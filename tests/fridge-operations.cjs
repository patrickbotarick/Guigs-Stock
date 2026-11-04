const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
const shop=id(10),lot=id(30),product=id(20),early=id(32),expired=id(33);
let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const reject=async(fn,pattern)=>{await assert.rejects(fn,pattern);checks++;};
(async()=>{
 const db=await createTestDatabase();
 try{
  const folder=path.join(__dirname,'../supabase/migrations');
  for(const f of fs.readdirSync(folder).filter(f=>/spatial_fridge_(foundation|allocation|replenishment|operations)\.sql$/.test(f)).sort())await db.exec(fs.readFileSync(path.join(folder,f),'utf8'));
  const get=(role,sql,args)=>asUser(db,role,async tx=>(await tx.query(sql,args)).rows[0].data);
  const save=(kind,v)=>get('owner','select public.guigs_save_fridge_layout($1,$2,$3) as data',[shop,kind,JSON.stringify(v)]);
  const f=await save('fridge',{name:'A'}),h=await save('shelf',{name:'1',fridge_id:f.id});
  const slot=(name,order)=>save('slot',{name,fridge_id:f.id,shelf_id:h.id,product_id:product,sort_order:order,capacity_quantity:10});
  const a=await slot('A',1),b=await slot('B',2);
  await get('owner','select public.guigs_allocate_fridge_stock($1,$2,$3) as data',[shop,randomUUID(),
    JSON.stringify([[a,5],[b,3]].map(([x,quantity])=>({lot_id:lot,slot_id:x.id,quantity})))]);
  await db.query("insert into public.guigs_lots(id,shop_id,product_id,code,expiry) values($1,$3,$4,'FEFO-A',current_date+2),($2,$3,$4,'VENCIDO',current_date-1)",[early,expired,shop,product]);
  for(const [l,q] of [[early,2],[expired,8]])await db.query(
   "insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id) values($1,$2,gen_random_uuid(),'adjust','fridge',$3,$4)",[shop,l,q,id(1)]);
  const spec=(kind,origin,quantity,slot_id=null,lot_id=null)=>({kind,origin,quantity,slot_id,lot_id,product_id:product});
  const quote=(s,role='attendant',tenant=shop)=>get(role,'select public.guigs_get_fridge_operation($1,$2) as data',[tenant,JSON.stringify(s)]);
  const write=(s,q,role='attendant',request=randomUUID(),note='fixture')=>get(role,
   'select public.guigs_apply_fridge_operation($1,$2,$3,$4,$5) as data',[shop,request,JSON.stringify(s),JSON.stringify(q),note]);
  const state=()=>get('attendant','select public.guigs_get_fridge_map($1) as data',[shop]);
  await reject(()=>quote(spec('sale','auto',1),'attendant',id(11)),/Acesso negado/);
  await reject(()=>quote(spec('sale','slot',5,b.id)),/insuficiente/);
  await reject(()=>quote(spec('sale','unallocated',1,null,expired)),/não vencido insuficiente/);
  await reject(()=>quote(spec('loss','auto',1,null,lot)),/inválida/);
  await reject(()=>quote(spec('adjust','slot',4,a.id,lot)),/proprietários/);
  const multi=spec('sale','auto',8);
  const q=await quote(multi);
  eq(q.plan.map(x=>[x.lot_id,x.slot_id,x.delta]),[[early,null,-2],[lot,a.id,-5],[lot,b.id,-1]]);
  const stale=await quote(spec('sale','slot',1,a.id));
  const key=randomUUID(),sold=await write(multi,q,'attendant',key);
  eq((await write(multi,q,'attendant',key)).event_id,sold.event_id);
  await reject(()=>write(spec('sale','slot',1,a.id),stale),/insuficiente/);
  const receipt=(await db.query('select count(*)::int as n from public.guigs_movements where event_id=$1',[sold.event_id])).rows[0].n;
  eq(receipt,3);
  const single=spec('sale','slot',1,b.id);
  const singleQuote=await quote(single);
  eq(singleQuote.plan.map(x=>x.slot_id),[b.id]);await write(single,singleQuote);
  const lost=spec('loss','unallocated',2,null,expired);
  const lq=await quote(lost);eq(lq.plan[0].delta,-2);
  await reject(()=>write(lost,lq,'attendant',randomUUID(),''),/motivo/);await write(lost,lq);
  const adjust=spec('adjust','slot',3,a.id,lot),aq=await quote(adjust,'owner');
  eq(aq.plan[0].current,0);eq(aq.plan[0].delta,3);
  await reject(()=>write(adjust,aq),/proprietários/);await write(adjust,aq,'owner');
  const ret=spec('return','slot',2,a.id,lot),rq=await quote(ret);
  const returned=await write(ret,rq);
  eq((await db.query('select location,delta,slot_id from public.guigs_movements where event_id=$1 order by location',[returned.event_id])).rows,
     [{location:'fridge',delta:-2,slot_id:a.id},{location:'stock',delta:2,slot_id:null}]);
  const m=await state();eq(m.slots.find(x=>x.id===a.id).quantity,1);eq(m.slots.find(x=>x.id===b.id).quantity,1);
  eq(m.unallocated.find(x=>x.lot_id===expired).quantity,6);
  const legacy=await get('owner',"select public.guigs_get_reports($1,now()-interval '1 day',now()+interval '1 day') as data",[shop]);
  eq(legacy.summary.sale_units,9);eq(legacy.summary.sale_operations,2);eq(legacy.summary.loss_units,2);eq(legacy.summary.transfer_units,2);
  const global=(await db.query("select sum(delta)::int as quantity from public.guigs_movements where location='fridge'")).rows[0].quantity;
  eq(global,m.slots.reduce((n,s)=>n+s.quantity,0)+m.unallocated.reduce((n,l)=>n+l.quantity,0));
  console.log(`Operações espaciais: ${checks} verificações passaram; PGlite e dados artificiais.`);
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
