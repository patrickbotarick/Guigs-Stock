const {randomUUID}=require('node:crypto');
const {ids,loginAll,check}=require('./live.cjs');
(async()=>{
 const {clients:{ownerA:owner,attendantA:operator,ownerB:other}}=await loginAll();
 const shop=ids.shopA,code=randomUUID().slice(0,8);
 const call=(client,name,args={})=>client.rpc(name,{p_shop_id:shop,...args});
 const ok=async(c,n,args)=>{const r=await call(c,n,args);if(r.error)throw Error('RPC '+n);return r.data;};
 const product=await ok(owner,'guigs_create_product',{p_name:'Fixture reposição '+code});
 const lots=[];
 for(const [days,quantity] of [[15,3],[30,5]])lots.push(await ok(owner,'guigs_receive_stock',{
  p_product_id:product,p_lot_code:'R-'+code+'-'+days,p_expiry:new Date(Date.now()+days*86400000).toISOString().slice(0,10),
  p_quantity:quantity,p_note:'Fixture artificial',p_supplier_id:null}));
 const save=(kind,values)=>ok(owner,'guigs_save_fridge_layout',{p_kind:kind,p_values:values});
 const f=await save('fridge',{name:'Reposição artificial '+code}),h=await save('shelf',{name:'Prateleira',fridge_id:f.id});
 const x=await save('slot',{name:'Posição',fridge_id:f.id,shelf_id:h.id,product_id:product,min_quantity:4,target_quantity:10,capacity_quantity:12});
 const quote=await ok(operator,'guigs_get_fridge_replenishment',{p_slot_id:x.id});
 check(quote.deficit===10&&quote.quantity===8,'Sugestão real limitada pelo estoque seco');
 check(quote.plan.map(l=>l.lot_id).join()===lots.map(l=>l.lot_id).join(),'Dois lotes retornados em FEFO');
 const limited=await ok(operator,'guigs_get_fridge_replenishment',{p_slot_id:x.id,p_quantity:4});
 check(limited.plan.map(x=>x.quantity).join()==='3,1','Sugestão parcial distribuída em dois lotes');
 const args={p_slot_id:x.id,p_request_id:randomUUID(),p_quantity:4,p_plan:limited.plan};
 check(!!(await call(other,'guigs_replenish_fridge_slot',args)).error,'Reposição cross-shop negada');
 const completed=await ok(operator,'guigs_replenish_fridge_slot',args);
 check((await ok(operator,'guigs_replenish_fridge_slot',args)).event_id===completed.event_id,'Retry PostgREST preserva o evento');
 const map=await ok(operator,'guigs_get_fridge_map');
 check(map.slots.find(y=>y.id===x.id).quantity===4,'Mapa real após reposição');
 check(map.dry.filter(l=>lots.some(x=>x.lot_id===l.lot_id)).reduce((n,l)=>n+l.quantity,0)===4,'Saldo seco reduzido exatamente em quatro');
})().catch(()=>{console.error('Falha no gate de reposição remota; dados e credenciais omitidos.');process.exitCode=1;});
