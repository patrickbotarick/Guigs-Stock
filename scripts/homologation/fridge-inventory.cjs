const {randomUUID}=require('node:crypto');
const {ids,loginAll,check}=require('./live.cjs');
(async()=>{
 const {clients:{ownerB:owner,attendantB:operator,ownerA:foreign}}=await loginAll(),shop=process.env.GUIGS_SPATIAL_INVENTORY_FIXTURE;
 if(!/^[0-9a-f-]{36}$/.test(shop||''))throw Error('Loja artificial dedicada obrigatória');
 const fixture=await owner.from('guigs_shops').select('name').eq('id',shop).single();
 if(fixture.data?.name!=='Fixture v1.7 inventário funcional')throw Error('Loja fora do ensaio');
 const call=(c,n,args={})=>c.rpc(n,{p_shop_id:shop,...args});
 const ok=async(c,n,args)=>{const r=await call(c,n,args);if(r.error)throw Error('RPC '+n);return r.data;};
 const code=randomUUID().slice(0,8),p=await ok(owner,'guigs_create_product',{p_name:'Fixture inventário '+code});
 const l=(await ok(owner,'guigs_receive_stock',{p_product_id:p,p_lot_code:'I-'+code,
   p_expiry:new Date(Date.now()+45*86400000).toISOString().slice(0,10),p_quantity:8,p_note:'Fixture artificial',p_supplier_id:null})).lot_id;
 await ok(owner,'guigs_transfer_stock',{p_lot_id:l,p_from_location:'stock',p_to_location:'fridge',p_quantity:6,p_note:'Fixture artificial'});
 const slots=[];
 const save=(kind,values)=>ok(owner,'guigs_save_fridge_layout',{p_kind:kind,p_values:values});
 for(const name of ['A','B']){
   const f=await save('fridge',{name:'Inventário artificial '+code+' '+name});
   const h=await save('shelf',{name:'Prateleira 1',fridge_id:f.id});
   slots.push(await save('slot',{name:'Posição',fridge_id:f.id,shelf_id:h.id,product_id:p}));
 }
 await ok(owner,'guigs_allocate_fridge_stock',{p_request_id:randomUUID(),p_entries:slots.map(s=>({lot_id:l,slot_id:s.id,quantity:2}))});
 const inv=await ok(owner,'guigs_create_spatial_inventory',{p_observation:'Fixture artificial'});
 const ref={p_inventory_id:inv};
 const read=()=>ok(operator,'guigs_get_spatial_inventory',ref);
 let d=await read();
 check(d.items.filter(i=>i.lot_id===l&&i.location==='fridge').length===3,'Snapshot real: duas posições e não alocado');
 check(!!(await call(foreign,'guigs_get_spatial_inventory',ref)).error,'Inventário espacial cross-shop negado');
 const count=(i,quantity)=>ok(operator,'guigs_count_spatial_inventory_item',{...ref,p_item_id:i.id,p_quantity:quantity,p_version:i.version});
 for(const i of d.items)await count(i,i.basis_quantity);
 const spec={kind:'sale',origin:'slot',slot_id:slots[0].id,product_id:p,quantity:1};
 const quote=await ok(operator,'guigs_get_fridge_operation',{p_spec:spec});
 await ok(operator,'guigs_apply_fridge_operation',{p_request_id:randomUUID(),p_spec:spec,p_expected:quote,p_note:'Fixture artificial'});
 d=await read();
 check(d.items.filter(i=>i.conflict).map(i=>i.slot_id).join()===slots[0].id,'Venda durante inventário invalida apenas a posição afetada');
 const status=async value=>ok(owner,'guigs_set_spatial_inventory_status',{...ref,p_status:value,p_version:(await read()).inventory.version});
 await status('review');
 const closeArgs=async()=>({...ref,p_version:(await read()).inventory.version,p_confirm:true,p_request_id:randomUUID()});
 check(!!(await call(owner,'guigs_complete_spatial_inventory',await closeArgs())).error,'Fechamento com conflito rejeitado');
 await status('open');d=await read();
 const i=d.items.find(i=>i.lot_id===l&&i.slot_id===slots[0].id);
 await ok(operator,'guigs_recount_spatial_inventory_item',{...ref,p_item_id:i.id,p_version:i.version});
 await count((await read()).items.find(x=>x.id===i.id),0);
 await status('review');
 const args=await closeArgs();
 const pair=await Promise.all([call(owner,'guigs_complete_spatial_inventory',args),call(owner,'guigs_complete_spatial_inventory',args)]);
 check(pair.every(x=>!x.error&&x.data.adjustments===1),'Fechamentos concorrentes da mesma requisição retornam um ajuste idempotente');
 check(!!(await call(owner,'guigs_complete_spatial_inventory',{...args,p_request_id:randomUUID()})).error,'Fechamento concluído não aceita outro identificador');
 d=await read();
 check(d.inventory.status==='completed'&&d.items.filter(i=>i.adjustment_event_id).length===1,'Um ajuste auditado, no item correto');
 const map=await ok(operator,'guigs_get_fridge_map');
 check(map.slots.find(s=>s.id===slots[0].id).quantity===0&&map.slots.find(s=>s.id===slots[1].id).quantity===2,
   'Ajuste afeta somente a posição recontada');
})().catch(()=>{console.error('Falha na homologação de inventário espacial; dados e credenciais omitidos.');process.exitCode=1;});
