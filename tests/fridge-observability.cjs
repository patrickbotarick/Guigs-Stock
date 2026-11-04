const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
const shop=id(10),lot=id(30),product=id(20);
let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
(async()=>{
 const db=await createTestDatabase();
 try{
  const folder=path.join(__dirname,'../supabase/migrations');
  for(const f of fs.readdirSync(folder).filter(f=>/spatial_fridge_.*\.sql$/.test(f)).sort())await db.exec(fs.readFileSync(path.join(folder,f),'utf8'));
  const get=(role,sql,args)=>asUser(db,role,async tx=>(await tx.query(sql,args)).rows[0].data);
  const save=(kind,v,id=null,rev=null)=>get('owner','select public.guigs_save_fridge_layout($1,$2,$3,$4,$5) as data',[shop,kind,JSON.stringify(v),id,rev]);
  const f=await save('fridge',{name:'Geladeira auditável'}),h=await save('shelf',{name:'Prateleira 1',fridge_id:f.id});
  const a=await save('slot',{name:'Posição original',fridge_id:f.id,shelf_id:h.id,product_id:product,target_quantity:9,capacity_quantity:24});
  const b=await save('slot',{name:'Posição B',fridge_id:f.id,shelf_id:h.id,product_id:product,sort_order:2,capacity_quantity:24});
  const allocation=await get('owner','select public.guigs_allocate_fridge_stock($1,$2,$3) as data',[shop,randomUUID(),JSON.stringify([
    {lot_id:lot,slot_id:a.id,quantity:3},{lot_id:lot,slot_id:b.id,quantity:4}])]);
  const quote=await get('attendant','select public.guigs_get_fridge_replenishment($1,$2,2) as data',[shop,a.id]);
  await get('attendant','select public.guigs_replenish_fridge_slot($1,$2,$3,2,$4) as data',[shop,randomUUID(),a.id,JSON.stringify(quote.plan)]);
  async function op(spec,note){
    const q=await get('attendant','select public.guigs_get_fridge_operation($1,$2) as data',[shop,JSON.stringify(spec)]);
    return get('attendant','select public.guigs_apply_fridge_operation($1,$2,$3,$4,$5) as data',
      [shop,randomUUID(),JSON.stringify(spec),JSON.stringify(q),note]);
  }
  const sale=await op({kind:'sale',origin:'auto',quantity:6,product_id:product},'Fixture venda');
  const loss=await op({kind:'loss',origin:'slot',slot_id:b.id,lot_id:lot,quantity:1,product_id:product},'=Fórmula artificial');
  await save('slot',{...a,name:'Renomeada'},a.id,a.revision);
  const history=({limit=20,offset=0,type=null,partition=null,search=null,tenant=shop}={})=>
    get('attendant','select public.guigs_get_spatial_history($1,$2,$3,null,$4,null,null,null,$5,$6) as data',[tenant,limit,offset,type,search,partition]);
  const list=await history();eq(list.length,7);eq(Number(list[0].total_count),7);
  const historic=list.find(x=>x.event_id===allocation.event_id);
  eq(historic.delta,7);eq(historic.parts.length,4);
  eq(historic.parts.some(x=>x.label==='Geladeira auditável / Prateleira 1 / Posição original'),true);
  eq(historic.parts.some(x=>x.label.includes('Renomeada')),false);
  eq(historic.parts.some(x=>x.label==='Geladeira — não alocado'),true);
  const sold=list.find(x=>x.event_id===sale.event_id);
  eq(sold.delta,-6);eq(sold.parts.length,2);
  eq(list.find(x=>x.event_id===loss.event_id).parts[0].slot_id,b.id);
  eq((await history({type:'relocate',partition:'slot'})).map(x=>x.event_id),[allocation.event_id]);
  eq((await history({search:'posição original'})).some(x=>x.event_id===allocation.event_id),true);
  eq((await history({partition:'unallocated'})).some(x=>!x.spatial&&x.parts[0].label==='Geladeira — não alocado'),true);
  eq((await history({limit:1,offset:1}))[0].id,list[1].id);
  await assert.rejects(()=>history({tenant:id(11)}),/Acesso negado/);checks++;
  const report=role=>get(role,"select public.guigs_get_reports($1,now()-interval '1 day',now()+interval '1 day') as data",[shop]);
  await assert.rejects(()=>report('attendant'),/proprietário/);checks++;
  const r=await report('owner');
  eq(r.spatial_summary,[{fridge_name:'Geladeira auditável',replenishment_events:1,replenished_units:2,sale_units:6,loss_units:1}]);
  eq(r.summary.transfer_units,2);eq(r.losses[0].location_label,'Geladeira auditável / Prateleira 1 / Posição B');
  await db.query("insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note) select $1,$2,gen_random_uuid(),'receipt','stock',1,$3,'Volume artificial' from generate_series(1,5000)",[shop,lot,id(1)]);
  const started=performance.now();const paged=await history({search:'Volume artificial'});
  eq(paged.length,20);eq(Number(paged[0].total_count),5000);
  console.log('Histórico filtrado 5.000 linhas: '+Math.round(performance.now()-started)+' ms em PGlite.');
  console.log(`Observabilidade espacial: ${checks} verificações passaram; dados artificiais em PGlite.`);
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
