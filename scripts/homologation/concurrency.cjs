const fs=require('node:fs'),path=require('node:path');
const {ids,loginAll,rpc,check,report,privateDir}=require('./live.cjs');
async function run(){
 const {clients:c}=await loginAll(),shop=ids.shopA,mode=process.argv[2]||'race';
 const call=async(role,name,args)=>{const r=await rpc(c[role],name,args);if(r.error)throw Error(r.error.code);return r.data;};
 const stateFile=path.join(privateDir,'concurrency-state.json');
 let inv;
 const args=()=>({p_shop_id:shop,p_inventory_id:inv});
 const detail=()=>call('ownerA','guigs_get_inventory',args());
 const status=async p_status=>call('ownerA','guigs_set_inventory_status',{...args(),p_status,p_version:(await detail()).inventory.version});
 const closeArgs=async()=>({...args(),p_version:(await detail()).inventory.version,p_confirm:true});
 const movementCount=async()=>{const r=await c.ownerA.from('guigs_movements').select('id',{count:'exact',head:true});if(r.error)throw Error('COUNT');return r.count;};
 if(mode==='rollback-check'){
  inv=JSON.parse(fs.readFileSync(stateFile)).inventory;const before=await detail(),n=await movementCount();
  const failed=await rpc(c.ownerA,'guigs_complete_inventory',await closeArgs());check(failed.error?.message.includes('HOMOLOG_SECOND_ADJUST_FAILURE'),'Erro injetado no segundo ajuste real');
  const after=await detail();check(await movementCount()===n,'Rollback: nenhum movimento parcial');
  check(after.inventory.status===before.inventory.status&&after.inventory.version===before.inventory.version,'Rollback: cabeçalho inalterado');
  check(after.items.every(i=>i.applied_delta===null&&i.adjustment_event_id===null),'Rollback: itens sem aplicação parcial');
  check(after.audit.length===before.audit.length,'Rollback: auditoria inalterada');
 }else if(mode==='finish-rollback'){
  inv=JSON.parse(fs.readFileSync(stateFile)).inventory;const done=await call('ownerA','guigs_complete_inventory',await closeArgs());check(done.adjustments===2,'Após retirar falha: fechamento com dois ajustes');
 }else{
  inv=await call('ownerA','guigs_create_inventory',{p_shop_id:shop,p_observation:'Concorrência real A/B/C'});let d=await detail();const first=d.items[0];
  const params={...args(),p_item_id:first.id,p_quantity:Number(first.basis_quantity)-1,p_version:first.version};
  const started=performance.now();
  const pair=await Promise.all([rpc(c.attendantA,'guigs_count_inventory_item',params),rpc(c.ownerA2,'guigs_count_inventory_item',params)]);
  check(pair.filter(r=>!r.error).length===1&&pair.filter(r=>!!r.error).length===1,'A: duas sessões, uma contagem aceita e uma versão rejeitada',{elapsedMs:Math.round(performance.now()-started)});
  d=await detail();check(d.items.find(i=>i.id===first.id).version===first.version+1,'A: versão incrementada uma única vez');
  for(const it of d.items.filter(i=>i.counted_quantity===null))await call('attendantA','guigs_count_inventory_item',{...args(),p_item_id:it.id,p_quantity:Number(it.basis_quantity)-1,p_version:it.version});
  await status('review');const close=await closeArgs(),before=await movementCount();
  // O trigger temporário mantém o fechamento em processamento por dois segundos.
  const a=rpc(c.ownerA,'guigs_complete_inventory',close);
  await new Promise(resolve=>setTimeout(resolve,100));
  const b=rpc(c.ownerA2,'guigs_complete_inventory',close);
  await new Promise(resolve=>setTimeout(resolve,100));
  const movement=rpc(c.attendantA,'guigs_transfer_stock',{p_shop_id:shop,p_lot_id:ids.lotA,p_from_location:'stock',p_to_location:'fridge',p_quantity:1,p_note:'Concorrência C artificial'});
  const [ra,rb,rm]=await Promise.all([a,b,movement]);
  check([ra,rb].filter(r=>!r.error).length===1&&[ra,rb].filter(r=>!!r.error).length===1,'B: dois owners, um único fechamento',{timesMs:[ra.ms,rb.ms]});
  check(!rm.error,'C: transferência aguarda fechamento e conclui',{elapsedMs:rm.ms});
  check(await movementCount()===before+4,'B/C: apenas dois ajustes e um par de transferência');
  const retry=await rpc(c.ownerA,'guigs_complete_inventory',close);check(!!retry.error&&await movementCount()===before+4,'Retry não duplica ajustes');
  const done=await detail();check(done.inventory.status==='completed','B: conclusão persistida');
  check(done.items.every(i=>Number(i.current_quantity)===Number(i.counted_quantity)+(i.location==='stock'?-1:1)),'C: saldo final combina fechamento e transferência');
  inv=await call('ownerA','guigs_create_inventory',{p_shop_id:shop,p_observation:'Rollback segundo ajuste artificial'});d=await detail();
  for(const it of d.items)await call('attendantA','guigs_count_inventory_item',{...args(),p_item_id:it.id,p_quantity:Number(it.basis_quantity)-1,p_version:it.version});
  await status('review');fs.writeFileSync(stateFile,JSON.stringify({inventory:inv}));
 }
 report('concurrency-'+mode);
}
run().catch(e=>{console.error('Falha concorrência: '+(/^[A-Z0-9_]+$/.test(e.message)?e.message:'assertion'));report('concurrency-'+(process.argv[2]||'race'));process.exitCode=1;});
