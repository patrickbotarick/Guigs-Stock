const fs=require('node:fs'),path=require('node:path');
const {ids,loginAll,rpc,check,report,privateDir}=require('./live.cjs');
async function run(){
 const {clients:c}=await loginAll();
 const rows=await c.ownerA.from('guigs_movements').select('movement_type,delta,event_id,location,created_at,lot_id');check(!rows.error,'Leitura independente de movimentos artificiais');
 const periods={hoje:['2026-10-23T03:00:00Z','2026-10-24T03:00:00Z'],dias7:['2026-10-17T03:00:00Z','2026-10-24T03:00:00Z'],dias30:['2026-09-24T03:00:00Z','2026-10-24T03:00:00Z'],mes:['2026-10-01T03:00:00Z','2026-11-01T03:00:00Z'],anterior:['2026-09-01T03:00:00Z','2026-10-01T03:00:00Z'],personalizado:['2026-10-22T12:00:00Z','2026-10-24T01:00:00Z']};
 for(const [label,[p_from,p_to]]of Object.entries(periods)){
  const selected=rows.data.filter(m=>Date.parse(m.created_at)>=Date.parse(p_from)&&Date.parse(m.created_at)<Date.parse(p_to));
  const r=await rpc(c.ownerA,'guigs_get_reports',{p_shop_id:ids.shopA,p_from,p_to});check(!r.error,'Relatório período '+label);
  for(const type of ['receipt','sale','loss','transfer','adjust']){
   const set=selected.filter(m=>type==='transfer'?['transfer','return'].includes(m.movement_type):m.movement_type===type);
   const expectedUnits=set.reduce((n,m)=>n+(type==='transfer'?Math.max(0,m.delta):type==='adjust'?m.delta:Math.abs(m.delta)),0);
   check(r.data.summary[type+'_operations']===new Set(set.map(m=>m.event_id)).size,label+' operações '+type);
   check(r.data.summary[type==='adjust'?'adjust_net_units':type+'_units']===expectedUnits,label+' unidades '+type);
  }
 }
 const samples={report:[],create:[],detail:[]};let inv;
 for(let n=0;n<3;n++){
  const r=await rpc(c.ownerB,'guigs_get_reports',{p_shop_id:ids.shopB,p_from:periods.mes[0],p_to:periods.mes[1]});check(!r.error&&r.data.summary.receipt_units===50120,'Relatório real 50 mil movimentos '+n);samples.report.push(r.ms);
  const create=await rpc(c.ownerB,'guigs_create_inventory',{p_shop_id:ids.shopB,p_observation:'Performance artificial 1001 lotes'});check(!create.error,'Snapshot grande '+n);inv=create.data;samples.create.push(create.ms);
  const d=await rpc(c.ownerB,'guigs_get_inventory',{p_shop_id:ids.shopB,p_inventory_id:inv});check(!d.error&&d.data.items.length===2002,'Detalhe real 2002 itens '+n);samples.detail.push(d.ms);
  samples.payloadBytes=Buffer.byteLength(JSON.stringify(d.data));
  if(n<2){const cancel=await rpc(c.ownerB,'guigs_set_inventory_status',{p_shop_id:ids.shopB,p_inventory_id:inv,p_status:'cancelled',p_version:d.data.inventory.version});check(!cancel.error,'Cancela benchmark '+n);}
  else {
   const item=d.data.items[0];const count=await rpc(c.attendantB,'guigs_count_inventory_item',{p_shop_id:ids.shopB,p_inventory_id:inv,p_item_id:item.id,p_quantity:Number(item.basis_quantity),p_version:item.version});check(!count.error,'Contagem em inventário grande');samples.count=count.ms;
   const latest=await rpc(c.ownerB,'guigs_get_inventory',{p_shop_id:ids.shopB,p_inventory_id:inv});const it=latest.data.items.find(i=>i.id===item.id);
   const recount=await rpc(c.attendantB,'guigs_recount_inventory_item',{p_shop_id:ids.shopB,p_inventory_id:inv,p_item_id:it.id,p_version:it.version});check(!recount.error,'Recontagem em inventário grande');samples.recount=recount.ms;
  }
 }
 fs.writeFileSync(path.join(privateDir,'performance-state.json'),JSON.stringify({inventory:inv,samples}));
 for(const key of ['report','create','detail'])samples[key+'P50']=samples[key].slice().sort((a,b)=>a-b)[1];
 check(samples.payloadBytes>1000000,'Payload medido via PostgREST superior a 1 MB',samples);report('performance-results');
}
run().catch(()=>{console.error('Falha benchmark: conferir último teste seguro');report('performance-results');process.exitCode=1;});
