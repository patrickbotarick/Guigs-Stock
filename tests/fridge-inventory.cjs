const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
const shop=id(10),lot=id(30),product=id(20),second=id(34);
let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const reject=async(fn,pattern)=>{await assert.rejects(fn,pattern);checks++;};
(async()=>{
 const db=await createTestDatabase();
 try{
  const folder=path.join(__dirname,'../supabase/migrations');
  for(const f of fs.readdirSync(folder).filter(f=>/spatial_(fridge_.*|replay_integrity)\.sql$/.test(f)).sort())await db.exec(fs.readFileSync(path.join(folder,f),'utf8'));
  await db.exec(fs.readFileSync(path.join(folder,'20261111173911_blind_grouped_inventory.sql'),'utf8'));
  const get=(role,sql,args)=>asUser(db,role,async tx=>(await tx.query(sql,args)).rows[0].data);
  const legacy=await get('owner',"select public.guigs_create_inventory($1,'fixture legado') as data",[shop]);
  const legacyDetail=await get('owner','select public.guigs_get_inventory($1,$2) as data',[shop,legacy]);
  eq(legacyDetail.items.length,4);eq(legacyDetail.inventory.spatial,false);
  await get('owner',"select public.guigs_set_inventory_status($1,$2,'cancelled',$3) as data",[shop,legacy,legacyDetail.inventory.version]);
  const save=(kind,v)=>get('owner','select public.guigs_save_fridge_layout($1,$2,$3) as data',[shop,kind,JSON.stringify(v)]);
  const position=async(name)=>{
    const f=await save('fridge',{name}),h=await save('shelf',{name:'Prateleira 1',fridge_id:f.id});
    return save('slot',{name:'Posição',fridge_id:f.id,shelf_id:h.id,product_id:product,capacity_quantity:8});
  };
  const a=await position('Geladeira A'),b=await position('Geladeira B');
  await db.query("insert into public.guigs_lots(id,shop_id,product_id,code,expiry) values($1,$2,$3,'SEGUNDO',current_date+80)",[second,shop,product]);
  await db.query("insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id) values($1,$2,gen_random_uuid(),'adjust','fridge',3,$3)",[shop,second,id(1)]);
  await get('owner','select public.guigs_allocate_fridge_stock($1,$2,$3) as data',[shop,randomUUID(),JSON.stringify([
    {lot_id:lot,slot_id:a.id,quantity:4},{lot_id:lot,slot_id:b.id,quantity:2},{lot_id:second,slot_id:b.id,quantity:2}])]);
  const start=(role='owner')=>get(role,"select public.guigs_create_spatial_inventory($1,'fixture') as data",[shop]);
  await reject(()=>start('attendant'),/proprietários/);
  const inv=await start();
  await reject(()=>get('attendant','select public.guigs_get_inventory($1,$2) as data',[shop,inv]),/v1.7/);
  await reject(()=>get('attendant','select public.guigs_get_spatial_inventory($1,$2) as data',[id(11),inv]),/Acesso negado/);
  await reject(()=>save('fridge',{name:'Durante inventário'}),/antes de editar/);
  const read=()=>get('attendant','select public.guigs_get_spatial_inventory($1,$2) as data',[shop,inv]);
  const count=(item,qty)=>get('attendant','select public.guigs_count_spatial_inventory_item($1,$2,$3,$4,$5) as data',[shop,inv,item.id,qty,item.version]);
  const recount=item=>get('attendant','select public.guigs_recount_spatial_inventory_item($1,$2,$3,$4) as data',[shop,inv,item.id,item.version]);
  const status=async status=>get('owner','select public.guigs_set_spatial_inventory_status($1,$2,$3,$4) as data',[shop,inv,status,(await read()).inventory.version]);
  const finish=(version,key,role='owner')=>get(role,'select public.guigs_complete_spatial_inventory($1,$2,$3,true,$4) as data',[shop,inv,version,key]);
  const ledger=()=>db.query('select id,delta,slot_id from public.guigs_movements order by id').then(r=>r.rows);
  const item=(d,l,s,location='fridge')=>d.items.find(x=>x.lot_id===l&&x.slot_id===s&&x.location===location);
  let d=await read();eq(d.inventory.spatial,true);
  const persisted=async()=>new Map((await db.query('select id,expected_initial,basis_quantity from public.guigs_inventory_items where inventory_id=$1',[inv])).rows.map(row=>[row.id,row]));
  const initial=await persisted();
  eq(item(d,lot,a.id).expected_initial,undefined);
  eq(initial.get(item(d,lot,a.id).id).expected_initial,4);eq(initial.get(item(d,lot,b.id).id).expected_initial,2);
  eq(initial.get(item(d,lot,null).id).expected_initial,2);eq(initial.get(item(d,second,b.id).id).expected_initial,2);
  eq(initial.get(item(d,second,a.id).id).expected_initial,0);eq(item(d,lot,a.id).fridge_id,a.fridge_id);
  eq(item(d,lot,a.id).slot_label,'Geladeira A / Prateleira 1 / Posição');
  const before=await ledger();
  for(const x of d.items){
    const value=x.id===item(d,second,b.id).id?9:x.id===item(d,lot,null).id?1:initial.get(x.id).basis_quantity;
    await count(x,value);
  }
  eq(await ledger(),before);
  const sale={kind:'sale',origin:'slot',slot_id:a.id,product_id:product,quantity:1};
  const plan=await get('attendant','select public.guigs_get_fridge_operation($1,$2) as data',[shop,JSON.stringify(sale)]);
  await get('attendant','select public.guigs_apply_fridge_operation($1,$2,$3,$4,$5) as data',[shop,randomUUID(),JSON.stringify(sale),JSON.stringify(plan),'fixture']);
  d=await read();eq(d.items.filter(i=>i.conflict).map(i=>i.id),[item(d,lot,a.id).id]);
  await status('review');
  let version=(await read()).inventory.version;
  const key=randomUUID();
  await reject(()=>finish(version,key,'attendant'),/proprietários/);
  await reject(()=>finish(version,key),/Movimentações posteriores/);
  await status('open');
  await recount(item(await read(),lot,a.id));
  const current=item(await read(),lot,a.id);eq((await persisted()).get(current.id).basis_quantity,3);
  await count(current,2);
  await status('review');
  version=(await read()).inventory.version;
  const rollback=await ledger();
  await reject(()=>finish(version,key),/Capacidade/);
  eq(await ledger(),rollback);
  eq((await read()).inventory.status,'review');
  await status('open');
  await recount(item(await read(),second,b.id));
  await count(item(await read(),second,b.id),3);
  await status('review');
  version=(await read()).inventory.version;
  const done=await finish(version,key);
  eq(done.adjustments,3);
  eq(await finish(version,key),done);
  await reject(()=>finish(version,randomUUID()),/encerrado/);
  d=await read();eq(d.inventory.status,'completed');
  const adjusted=d.items.filter(x=>x.adjustment_event_id);
  eq(adjusted.length,3);
  for(const x of adjusted){
    const row=(await db.query("select delta,slot_id from public.guigs_movements where event_id=$1 and movement_type='adjust'",[x.adjustment_event_id])).rows[0];
    eq(row,{delta:x.applied_delta,slot_id:x.slot_id});
  }
  eq(d.audit.some(x=>x.action==='recount'&&x.previous_quantity===4),true);
  const map=await get('attendant','select public.guigs_get_fridge_map($1) as data',[shop]);
  const global=(await db.query("select sum(delta)::int as quantity from public.guigs_movements where location='fridge'")).rows[0].quantity;
  eq(global,map.slots.reduce((n,s)=>n+s.quantity,0)+map.unallocated.reduce((n,l)=>n+l.quantity,0));
  console.log(`Inventário espacial: ${checks} verificações passaram; PGlite e dados artificiais.`);
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
