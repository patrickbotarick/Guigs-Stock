const fs=require('node:fs'),path=require('node:path');
const {ids,client,loginAll,rpc,check,report,privateDir}=require('./live.cjs');
async function run(){
 const {clients:c}=await loginAll(),shop=ids.shopA;
 const ok=async(role,name,args,label)=>{const r=await rpc(c[role],name,args);check(!r.error,label||name,r.error?{code:r.error.code}:undefined);return r.data;};
 const denied=async(role,name,args,label)=>{const r=await rpc(c[role],name,args);check(!!r.error,label);};
 const range={p_from:'2026-10-01T03:00:00Z',p_to:'2026-11-01T03:00:00Z'};
 for(const role of ['ownerA','attendantA','ownerB','attendantB']){
  const foreign=role.includes('B')?ids.shopA:ids.shopB;
  for(const table of ['guigs_products','guigs_lots','guigs_movements','guigs_suppliers','guigs_inventories','guigs_inventory_items','guigs_inventory_audit']){
   const r=await c[role].from(table).select('shop_id').eq('shop_id',foreign);check(!r.error&&r.data.length===0,role+' RLS SELECT '+table);
  }
  await denied(role,'guigs_create_inventory',{p_shop_id:foreign},role+' inventário cross-shop bloqueado');
  await denied(role,'guigs_get_reports',{p_shop_id:foreign,...range},role+' relatório cross-shop bloqueado');
 }
 const anon=await client().from('guigs_products').select('id');check(!!anon.error,'Anônimo sem SELECT');
 await denied('attendantA','guigs_create_inventory',{p_shop_id:shop},'Atendente não cria inventário');
 await denied('attendantA','guigs_get_reports',{p_shop_id:shop,...range},'Relatório gerencial bloqueado para atendente no servidor');
 const initialReport=await ok('ownerA','guigs_get_reports',{p_shop_id:shop,...range},'Relatório inicial real');
 check(initialReport.summary.receipt_units===120&&initialReport.summary.receipt_operations===2,'Resumo inicial independente: 120 unidades, 2 recebimentos');
 const started=new Date().toISOString();
 await ok('attendantA','guigs_receive_stock',{p_shop_id:shop,p_product_id:ids.productA,p_lot_code:'LOTE-ARTIFICIAL-A',p_expiry:new Date(Date.now()+60*86400000).toISOString().slice(0,10),p_quantity:5,p_note:'Recebimento artificial homologação',p_supplier_id:ids.supplierA},'Recebimento RPC v1.5 após upgrade');
 await ok('attendantA','guigs_transfer_stock',{p_shop_id:shop,p_lot_id:ids.lotA,p_from_location:'stock',p_to_location:'fridge',p_quantity:7,p_note:'Transferência artificial'},'Transferência de atendente');
 await ok('attendantA','guigs_register_sale',{p_shop_id:shop,p_lot_id:ids.lotA,p_quantity:3,p_note:'Venda artificial'},'Venda de atendente');
 await ok('attendantA','guigs_register_loss',{p_shop_id:shop,p_lot_id:ids.lotA,p_location:'stock',p_quantity:2,p_note:'Perda artificial'},'Perda de atendente');
 const metrics=await ok('ownerA','guigs_get_reports',{p_shop_id:shop,p_from:started,p_to:new Date(Date.now()+1000).toISOString()},'Relatório do intervalo conhecido');
 for(const [key,value]of Object.entries({receipt_units:5,receipt_operations:1,transfer_units:7,transfer_operations:1,sale_units:3,sale_operations:1,loss_units:2,loss_operations:1}))check(metrics.summary[key]===value,'Métrica real '+key+' = '+value);
 check(metrics.suppliers.some(s=>s.supplier==='FORNECEDOR TESTE A'&&s.units===5),'Fornecedor histórico preservado');
 const inv=await ok('ownerA','guigs_create_inventory',{p_shop_id:shop,p_observation:'Fluxo real isolado'},'Owner cria snapshot');
 const detail=()=>ok('ownerA','guigs_get_inventory',{p_shop_id:shop,p_inventory_id:inv},'Detalhe real');
 const transition=async status=>ok('ownerA','guigs_set_inventory_status',{p_shop_id:shop,p_inventory_id:inv,p_status:status,p_version:(await detail()).inventory.version},'Transição '+status);
 let d=await detail();check(d.items.length===2,'Snapshot stock e fridge');
 for(const it of d.items)await ok('attendantA','guigs_count_inventory_item',{p_shop_id:shop,p_inventory_id:inv,p_item_id:it.id,p_quantity:Number(it.basis_quantity)-1,p_version:it.version},'Atendente conta '+it.location);
 d=await detail();check(d.items.every(i=>Number(i.current_quantity)===Number(i.basis_quantity)),'Salvar contagem não altera saldo');
 await denied('attendantA','guigs_set_inventory_status',{p_shop_id:shop,p_inventory_id:inv,p_status:'cancelled',p_version:d.inventory.version},'Atendente não cancela');
 await denied('attendantA','guigs_complete_inventory',{p_shop_id:shop,p_inventory_id:inv,p_version:d.inventory.version,p_confirm:true},'Atendente não fecha');
 await ok('attendantA','guigs_register_sale',{p_shop_id:shop,p_lot_id:ids.lotA,p_quantity:1,p_note:'Venda durante inventário'},'Venda durante contagem');
 await ok('attendantA','guigs_transfer_stock',{p_shop_id:shop,p_lot_id:ids.lotA,p_from_location:'stock',p_to_location:'fridge',p_quantity:1,p_note:'Transferência durante inventário'},'Transferência durante contagem');
 await transition('review');d=await detail();check(d.items.some(i=>i.conflict),'Movimento posterior identificado');
 await denied('ownerA','guigs_complete_inventory',{p_shop_id:shop,p_inventory_id:inv,p_version:d.inventory.version,p_confirm:true},'Fechamento bloqueado até recontagem');
 await transition('open');d=await detail();
 for(const it of d.items){await ok('attendantA','guigs_recount_inventory_item',{p_shop_id:shop,p_inventory_id:inv,p_item_id:it.id,p_version:it.version},'Atendente reabre contagem');const fresh=(await detail()).items.find(i=>i.id===it.id);await ok('attendantA','guigs_count_inventory_item',{p_shop_id:shop,p_inventory_id:inv,p_item_id:fresh.id,p_quantity:Number(fresh.basis_quantity)-1,p_version:fresh.version},'Recontagem real');}
 await transition('review');d=await detail();
 const done=await ok('ownerA','guigs_complete_inventory',{p_shop_id:shop,p_inventory_id:inv,p_version:d.inventory.version,p_confirm:true},'Fechamento autorizado');
 check(done.adjustments===2,'Duas divergências geram dois ajustes');
 await denied('ownerA','guigs_complete_inventory',{p_shop_id:shop,p_inventory_id:inv,p_version:d.inventory.version,p_confirm:true},'Retry de fechamento rejeitado');
 const end=await detail();check(end.inventory.status==='completed'&&end.items.filter(i=>i.adjustment_event_id).length===2,'Histórico e vínculo de ajustes persistidos');
 const cancelled=await ok('ownerA','guigs_create_inventory',{p_shop_id:shop,p_observation:'Cancelamento artificial'},'Novo inventário');
 const cd=await ok('ownerA','guigs_get_inventory',{p_shop_id:shop,p_inventory_id:cancelled});await ok('ownerA','guigs_set_inventory_status',{p_shop_id:shop,p_inventory_id:cancelled,p_status:'cancelled',p_version:cd.inventory.version},'Owner cancela');
 fs.writeFileSync(path.join(privateDir,'api-state.json'),JSON.stringify({completed:inv,started}));
 report('api-results');
}
run().catch(e=>{console.error('Falha API: '+(e.message?.startsWith('LOGIN')?e.message:'verificar último teste seguro'));report('api-results');process.exitCode=1;});
