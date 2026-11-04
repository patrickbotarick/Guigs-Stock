// Dois requests PostgREST concorrentes, projeto e contas artificiais fixados por live.cjs.
const {randomUUID}=require('node:crypto');
const {ids,loginAll,check}=require('./live.cjs');
(async()=>{
  const {clients}=await loginAll();
  const shop=ids.shopA,owner=clients.ownerA,second=clients.ownerA2;
  const call=(c,n,args={})=>c.rpc(n,{p_shop_id:shop,...args});
  const ok=async(c,n,args)=>{const r=await call(c,n,args);if(r.error)throw Error('Falha na RPC '+n);return r.data;};
  const suffix=randomUUID().slice(0,8);
  const product=await ok(owner,'guigs_create_product',{p_name:'Fixture distribuição '+suffix});
  const receipt=await ok(owner,'guigs_receive_stock',{p_product_id:product,p_lot_code:'A-'+suffix,
    p_expiry:new Date(Date.now()+60*86400000).toISOString().slice(0,10),p_quantity:12,p_note:'Fixture artificial',p_supplier_id:null});
  const lot=receipt.lot_id;
  await ok(owner,'guigs_transfer_stock',{p_lot_id:lot,p_from_location:'stock',p_to_location:'fridge',p_quantity:10,p_note:'Fixture artificial'});
  const save=(kind,values)=>ok(owner,'guigs_save_fridge_layout',{p_kind:kind,p_values:values});
  const f=await save('fridge',{name:'Distribuição artificial '+suffix});
  const h=await save('shelf',{name:'Prateleira',fridge_id:f.id});
  const slots=[];
  for(const name of ['A','B'])slots.push(await save('slot',{name,fridge_id:f.id,shelf_id:h.id,product_id:product,capacity_quantity:10}));
  const args=(slot,q)=>({p_request_id:randomUUID(),p_entries:[{lot_id:lot,slot_id:slot.id,quantity:q}]});
  const attempts=[args(slots[0],7),args(slots[1],7)],actors=[owner,second];
  const results=await Promise.all(actors.map((c,i)=>call(c,'guigs_allocate_fridge_stock',attempts[i])));
  check(results.filter(r=>!r.error).length===1,'Duas transações concorrentes não consomem o mesmo saldo não alocado');
  const i=results.findIndex(r=>!r.error),j=1-i;
  check(results[j].error?.code==='55P03'||/Saldo insuficiente/.test(results[j].error?.message||''),'Concorrente recusada por lock ou saldo atualizado');
  const retry=await ok(actors[i],'guigs_allocate_fridge_stock',attempts[i]);
  check(retry.event_id===results[i].data.event_id,'Retry da requisição vencedora retorna o mesmo evento');
  const wrongActor=await call(actors[j],'guigs_allocate_fridge_stock',attempts[i]);
  check(!!wrongActor.error,'Chave de retry não pode ser reaproveitada por outro ator');
  const map=await ok(clients.attendantA,'guigs_get_fridge_map');
  check(map.unallocated.find(l=>l.lot_id===lot).quantity===3,'Saldo parcial real preservado');
  check(map.slots.filter(s=>slots.some(x=>x.id===s.id)).reduce((n,s)=>n+s.quantity,0)===7,'Apenas sete unidades creditadas');
  await ok(owner,'guigs_allocate_fridge_stock',args(slots[j],3));
  const final=await ok(owner,'guigs_get_fridge_map');
  check(!final.unallocated.some(l=>l.lot_id===lot),'Distribuição total remove apenas o restante não alocado');
  const legacy=await owner.rpc('guigs_get_lot_balances',{p_shop:shop});
  const balance=legacy.data?.find(b=>b.lot_id===lot);
  check(Number(balance.fridge)===10&&Number(balance.stock)===2,'Invariante do ledger real: seco 2 e geladeira 10');
})().catch(()=>{console.error('Falha no gate de alocação remota; dados e credenciais omitidos.');process.exitCode=1;});
