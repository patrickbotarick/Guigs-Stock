const fs=require('node:fs'),path=require('node:path');
const {ids,client,loginAll,rpc,check,report,privateDir}=require('./live.cjs');
(async()=>{
 const {clients:c}=await loginAll(),shop=ids.shopA;
 const args={guigs_adjust_stock:{p_shop_id:shop,p_lot_id:ids.lotA,p_location:'stock',p_new_quantity:1,p_note:'Negado artificial'},guigs_create_product:{p_shop_id:shop,p_name:'Negado artificial'},guigs_update_product:{p_shop_id:shop,p_product_id:ids.productA,p_name:'Negado',p_category:'Outro',p_min_total:0,p_target_total:0,p_min_fridge:0,p_target_fridge:0,p_active:true},guigs_receive_stock:{p_shop_id:shop,p_product_id:ids.productA,p_lot_code:'NEGADO',p_expiry:'2027-02-01',p_quantity:1},guigs_transfer_stock:{p_shop_id:shop,p_lot_id:ids.lotA,p_from_location:'stock',p_to_location:'fridge',p_quantity:1},guigs_register_sale:{p_shop_id:shop,p_lot_id:ids.lotA,p_quantity:1},guigs_register_loss:{p_shop_id:shop,p_lot_id:ids.lotA,p_location:'stock',p_quantity:1},guigs_get_history:{p_shop:shop},guigs_get_history_actors:{p_shop:shop},guigs_get_lot_balances:{p_shop:shop}};
 for(const [name,params]of Object.entries(args)){
  const r=await rpc(client(),name,params);check(!!r.error||(Array.isArray(r.data)&&r.data.length===0),'Anônimo sem dados/efeitos: '+name);
  const foreign=Object.fromEntries(Object.entries(params).map(([k,v])=>[k,['p_shop_id','p_shop'].includes(k)?ids.shopB:v]));
  const cross=await rpc(c.ownerA,name,foreign);check(!!cross.error||(Array.isArray(cross.data)&&cross.data.length===0),'RPC legada cross-shop: '+name);
 }
 for(const name of ['guigs_adjust_stock','guigs_create_product','guigs_update_product'])check(!!(await rpc(c.attendantA,name,args[name])).error,'Administração negada ao atendente: '+name);
 for(const table of ['guigs_inventories','guigs_inventory_items','guigs_inventory_audit']){
  check(!!(await c.ownerA.from(table).insert({})).error,'INSERT direto negado '+table);
  check(!!(await c.ownerA.from(table).update({shop_id:shop}).eq('shop_id',shop)).error,'UPDATE direto negado '+table);
  check(!!(await c.ownerA.from(table).delete().eq('shop_id',shop)).error,'DELETE direto negado '+table);
 }
 const inv=JSON.parse(fs.readFileSync(path.join(privateDir,'api-state.json'))).completed;
 check(!(await rpc(c.attendantA,'guigs_get_inventory',{p_shop_id:shop,p_inventory_id:inv})).error,'Atendente visualiza inventário da própria loja');
 check(!!(await rpc(c.ownerB,'guigs_get_inventory',{p_shop_id:shop,p_inventory_id:inv})).error,'Owner B não lê detalhe do inventário A');
 check(!!(await rpc(c.attendantB,'guigs_get_inventory',{p_shop_id:shop,p_inventory_id:inv})).error,'Atendente B não lê detalhe do inventário A');
 const lots=await c.ownerA.from('guigs_lots').select('id,expiry').eq('shop_id',shop).order('expiry',{ascending:false});
 const fefo=await rpc(c.attendantA,'guigs_get_fefo_candidates',{p_shop_id:shop,p_lot_id:lots.data[0].id});check(!fefo.error&&fefo.data.some(l=>l.lot_id===ids.lotA||l.id===ids.lotA),'FEFO real identifica lote anterior com saldo');
 const name='ADMIN ARTIFICIAL '+Date.now();const product=await rpc(c.ownerA,'guigs_create_product',{p_shop_id:shop,p_name:name});check(!product.error,'Owner administra produto');
 const supplier=await rpc(c.ownerA,'guigs_create_supplier',{p_shop_id:shop,p_name:name});check(!supplier.error,'Owner administra fornecedor');
 const update=await rpc(c.ownerA,'guigs_update_supplier',{p_shop_id:shop,p_supplier_id:supplier.data,p_name:name+' INATIVO',p_active:false});check(!update.error,'Owner atualiza fornecedor');
 report('permissions-results');
})().catch(()=>{console.error('Falha permissões: verificar último teste seguro');report('permissions-results');process.exitCode=1;});
