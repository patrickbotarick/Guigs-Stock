const fs=require('node:fs'),path=require('node:path');
const {ids,loginAll,rpc,check,report,privateDir}=require('./live.cjs');
(async()=>{
 const {clients:c}=await loginAll(),state=JSON.parse(fs.readFileSync(path.join(privateDir,'performance-state.json'))),args={p_shop_id:ids.shopB,p_inventory_id:state.inventory};
 let r=await rpc(c.ownerB,'guigs_get_inventory',args);check(!r.error&&r.data.items.every(i=>i.counted_quantity!==null),'Massa de contagem grande preparada artificialmente');
 r=await rpc(c.ownerB,'guigs_set_inventory_status',{...args,p_status:'review',p_version:r.data.inventory.version});check(!r.error,'Revisão de 2002 itens');
 r=await rpc(c.ownerB,'guigs_get_inventory',args);const done=await rpc(c.ownerB,'guigs_complete_inventory',{...args,p_version:r.data.inventory.version,p_confirm:true});
 check(!done.error&&done.data.adjustments===2002,'Fechamento real: 2002 ajustes atômicos',{elapsedMs:done.ms});
 const after=await rpc(c.ownerB,'guigs_get_inventory',args);check(!after.error&&after.data.items.every(i=>i.adjustment_event_id&&Number(i.current_quantity)===Number(i.counted_quantity)),'2002 saldos reconciliados');
 report('close-large-results');
})().catch(()=>{console.error('Falha fechamento grande; detalhes privados omitidos.');report('close-large-results');process.exitCode=1;});
