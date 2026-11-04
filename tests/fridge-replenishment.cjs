const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
const shop=id(10),product=id(20),earliest=id(32),expired=id(33);
let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const reject=async(fn,pattern)=>{await assert.rejects(fn,pattern);checks++;};
(async()=>{
 const db=await createTestDatabase();
 try{
  const folder=path.join(__dirname,'../supabase/migrations');
  for(const f of fs.readdirSync(folder).filter(f=>/spatial_fridge_(foundation|allocation|replenishment)\.sql$/.test(f)).sort())await db.exec(fs.readFileSync(path.join(folder,f),'utf8'));
  await db.query("insert into public.guigs_lots(id,shop_id,product_id,code,expiry) values($1,$3,$4,'FEFO-A',current_date+2),($2,$3,$4,'VENCIDO',current_date-1)",[earliest,expired,shop,product]);
  for(const [lot,qty] of [[earliest,4],[expired,20]])await db.query(
   "insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id) values($1,$2,gen_random_uuid(),'receipt','stock',$3,$4)",[shop,lot,qty,id(1)]);
  const scalar=(role,sql,args)=>asUser(db,role,async tx=>(await tx.query(sql,args)).rows[0].data);
  const save=(kind,values)=>scalar('owner','select public.guigs_save_fridge_layout($1,$2,$3) as data',[shop,kind,JSON.stringify(values)]);
  const f=await save('fridge',{name:'A'}),h=await save('shelf',{name:'1',fridge_id:f.id});
  const s=await save('slot',{name:'Posição',fridge_id:f.id,shelf_id:h.id,product_id:product,min_quantity:4,target_quantity:16,capacity_quantity:20});
  const quote=(q=null,tenant=shop)=>scalar('attendant','select public.guigs_get_fridge_replenishment($1,$2,$3) as data',[tenant,s.id,q]);
  const execute=(q,key=randomUUID())=>scalar('attendant','select public.guigs_replenish_fridge_slot($1,$2,$3,$4,$5) as data',
    [shop,key,s.id,q.quantity,JSON.stringify(q.plan)]);
  const count=()=>db.query("select count(*)::int as n from public.guigs_movements where spatial").then(r=>r.rows[0].n);
  const first=await quote();
  eq(first.deficit,16);eq(first.dry_available,14);eq(first.expired_dry,20);eq(first.quantity,14);
  eq(first.plan.map(p=>[p.lot_id,p.quantity]),[[earliest,4],[id(30),10]]);
  const legacy=await asUser(db,'attendant',tx=>tx.query('select lot_id from public.guigs_get_fefo_candidates($1,$2)',[shop,id(30)]));
  eq(legacy.rows.map(r=>r.lot_id),[expired,earliest]);
  await reject(()=>quote(null,id(11)),/Acesso negado/);
  await reject(()=>quote(0),/Quantidade inválida/);
  const selected=await quote(6);eq(selected.plan.map(p=>p.quantity),[4,2]);
  await reject(()=>execute({...selected,plan:[...selected.plan].reverse()}),/Plano FEFO mudou/);eq(await count(),0);
  const inv=await scalar('owner','select public.guigs_create_inventory($1) as data',[shop]);
  const key=randomUUID();
  await reject(()=>execute(selected,key),/inventário ativo/);eq(await count(),0);
  await db.query("update public.guigs_inventories set status='cancelled',cancelled_at=now(),cancelled_by=$2 where id=$1",[inv,id(1)]);
  const result=await execute(selected,key);
  eq(result.quantity,6);eq(await execute(selected,key),result);eq(await count(),4);
  await reject(()=>execute(first,key),/já utilizado/);
  const sums=(await db.query("select sum(delta)::int as total,sum(delta) filter(where location='stock')::int as dry,sum(delta) filter(where location='fridge')::int as fridge from public.guigs_movements where event_id=$1",[result.event_id])).rows[0];
  eq(sums,{total:0,dry:-6,fridge:6});
  const after=await quote();eq(after.current,6);eq(after.plan.map(p=>p.quantity),[8]);
  const map=await scalar('attendant','select public.guigs_get_fridge_map($1) as data',[shop]);
  eq(map.slots.find(x=>x.id===s.id).lots.map(x=>x.quantity),[4,2]);
  eq(map.unallocated.find(x=>x.lot_id===id(30)).quantity,8);
  const report=await scalar('owner',"select public.guigs_get_reports($1,now()-interval '1 day',now()+interval '1 day') as data",[shop]);
  eq(report.summary.transfer_units,6);eq(report.summary.transfer_operations,1);
  console.log(`Reposição espacial: ${checks} verificações passaram; dados artificiais em PGlite.`);
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
