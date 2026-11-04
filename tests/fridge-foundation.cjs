// PostgreSQL em memória, fixtures artificiais; nunca usa ambiente remoto.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createTestDatabase,id,asUser}=require('./inventory-support.cjs');
const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261104123035_spatial_fridge_foundation.sql'),'utf8');
let checks=0;
const equal=(a,b)=>{assert.deepEqual(a,b);checks++;};
const reject=async (fn,pattern)=>{await assert.rejects(fn,pattern);checks++;};
const shop=id(10), lot=id(30), product=id(20), shopB=id(11);
const sqlMap='select public.guigs_get_fridge_map($1) as data';
const ledger='select id,shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,created_at from public.guigs_movements order by id';
async function actor(db,user,fn){
  return db.transaction(async tx=>{
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
    await tx.exec('set local role authenticated');
    return fn(tx);
  });
}
async function map(db,user=id(1),s=shop){
  return actor(db,user,async tx=>(await tx.query(sqlMap,[s])).rows[0].data);
}
async function save(db,kind,values,{user=id(1),s=shop,existing}={}){
  return actor(db,user,async tx=>(await tx.query('select public.guigs_save_fridge_layout($1,$2,$3,$4,$5) as data',
    [s,kind,JSON.stringify(values),existing?.id??null,existing?.revision??null])).rows[0].data);
}
async function run(){
  const db=await createTestDatabase();
  try{
    const before=(await db.query(ledger)).rows;
    const getGlobal=()=>asUser(db,'owner',async tx=>(await tx.query('select * from public.guigs_get_lot_balances($1) order by lot_id',[shop])).rows);
    const globalBefore=await getGlobal();
    await db.exec(migration);
    equal((await db.query(ledger)).rows,before);
    equal(await getGlobal(),globalBefore);
    equal((await map(db)).unallocated.map(l=>l.quantity),[8]);
    equal((await map(db)).slots,[]);
    await db.query('insert into auth.users values($1,$2),($3,$4)',[id(3),'owner-b@test.invalid',id(4),'attendant-b@test.invalid']);
    await db.query("insert into public.guigs_shops(id,name) values($1,'Loja artificial B')",[shopB]);
    await db.query("insert into public.guigs_memberships(shop_id,user_id,role) values($1,$2,'owner'),($1,$3,'attendant')",[shopB,id(3),id(4)]);
    await db.query("insert into public.guigs_products(id,shop_id,name) values($1,$2,'Produto B')",[id(22),shopB]);
    const f=await save(db,'fridge',{name:'Geladeira A',width_ratio:.5});
    const fb=await save(db,'fridge',{name:'Geladeira B'},{user:id(3),s:shopB});
    const h=await save(db,'shelf',{name:'Prateleira A',fridge_id:f.id,height_ratio:.5});
    const x=await save(db,'slot',{name:'Posição A',fridge_id:f.id,shelf_id:h.id,product_id:product,
      width_ratio:.5,min_quantity:2,target_quantity:6,capacity_quantity:10});
    const y=await save(db,'slot',{name:'Vazio',fridge_id:f.id,shelf_id:h.id,x_ratio:.5,width_ratio:.5});
    equal((await map(db,id(2))).slots.map(s=>s.quantity).sort(),[0,0]);
    equal((await map(db,id(4),shopB)).fridges.map(s=>s.id),[fb.id]);
    for(const user of [id(1),id(2)])await reject(()=>map(db,user,shopB),/Acesso negado/);
    for(const user of [id(3),id(4)])await reject(()=>map(db,user),/Acesso negado/);
    equal(await actor(db,id(4),async tx=>(await tx.query('select count(*)::int as n from public.guigs_fridge_slots')).rows[0].n),0);
    await reject(()=>db.transaction(async tx=>{await tx.exec('set local role anon');await tx.query(sqlMap,[shop]);}),/permission denied/);
    await reject(()=>save(db,'fridge',{name:'Attendant'},{user:id(2)}),/proprietários/);
    await reject(()=>save(db,'fridge',{name:'Outra loja'},{user:id(3),s:shopB,existing:f}),/indisponível/);
    await reject(()=>save(db,'shelf',{name:'Outra loja',fridge_id:fb.id}),/foreign key/);
    await reject(()=>save(db,'slot',{name:'Produto B',fridge_id:f.id,shelf_id:h.id,product_id:id(22)}),/indisponível/);
    await reject(()=>save(db,'slot',{name:'Fora',fridge_id:f.id,shelf_id:h.id,x_ratio:.8,width_ratio:.5}),/check constraint/);
    await reject(()=>save(db,'slot',{name:'Meta inválida',fridge_id:f.id,shelf_id:h.id,target_quantity:8,capacity_quantity:7}),/check constraint/);
    await reject(()=>actor(db,id(1),tx=>tx.query("update public.guigs_fridges set name='Direto' where id=$1",[f.id])),/permission denied/);
    const resized=await save(db,'slot',{...x,width_ratio:.4,sort_order:1},{existing:x});
    equal(resized.revision,2);
    equal(Number(resized.width_ratio),.4);
    await reject(()=>save(db,'slot',{...x,name:'Stale'},{existing:x}),/Layout alterado/);
    equal((await db.query(ledger)).rows,before);
    // Antes da primeira alocação, o frontend legado pode movimentar e inventariar normalmente.
    await asUser(db,'attendant',tx=>tx.query("select public.guigs_transfer_stock($1,$2,'stock','fridge',1,'fixture')",[shop,lot]));
    equal((await map(db)).unallocated[0].quantity,9);
    const startInventory=()=>asUser(db,'owner',tx=>tx.query('select public.guigs_create_inventory($1)',[shop]));
    const inv=(await startInventory()).rows[0].guigs_create_inventory;
    const add=(tx,slot,delta,kind='fridge',spatial=true)=>tx.query(
      "insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,slot_id,spatial) values($1,$2,gen_random_uuid(),'adjust',$3,$4,$5,$6,$7)",[shop,lot,kind,delta,id(1),slot,spatial]);
    await reject(()=>add(db,x.id,1),/inventário ativo/);
    await db.query("update public.guigs_inventories set status='cancelled',cancelled_at=now(),cancelled_by=$2 where id=$1",[inv,id(1)]);
    const original=(await getGlobal()).find(row=>row.lot_id===lot).fridge;
    // Sonda de ledger como admin de fixture; a RPC pública de distribuição pertence ao Gate 5.
    await db.transaction(async tx=>{await add(tx,null,-5);await add(tx,x.id,5);});
    const current=await map(db);
    equal(current.slots.find(s=>s.id===x.id).quantity,5);
    equal(current.slots.find(s=>s.id===y.id).lots,[]);
    equal(current.unallocated[0].quantity,4);
    equal(current.slots.reduce((n,s)=>n+s.quantity,0)+current.unallocated[0].quantity,Number(original));
    equal((await getGlobal()).find(row=>row.lot_id===lot).fridge,original);
    await reject(()=>add(db,x.id,-6),/Saldo insuficiente/);
    await reject(()=>add(db,x.id,6),/Capacidade/);
    await reject(()=>add(db,x.id,1,'stock'),/check constraint/);
    await reject(()=>add(db,null,-1,'fridge',false),/posição física/);
    await reject(startInventory,/inventário espacial/);
    await reject(()=>save(db,'slot',{...resized,active:false},{existing:resized}),/saldo incompatível/);
    await reject(()=>save(db,'shelf',{...h,active:false},{existing:h}),/com saldo/);
    await reject(()=>save(db,'fridge',{...f,active:false},{existing:f}),/com saldo/);
    await db.query('update public.guigs_products set active=false where id=$1',[product]);
    const deactivated=(await map(db)).slots.find(s=>s.id===x.id);
    equal(deactivated.product_active,false);
    equal(deactivated.lots[0].quantity,5);
    equal((await db.query('select slot_label from public.guigs_movements where slot_id=$1',[x.id])).rows[0].slot_label,'Geladeira A / Prateleira A / Posição A');
    console.log(`Fundação espacial: ${checks} verificações passaram; PGlite, dados artificiais.`);
  }finally{await db.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
