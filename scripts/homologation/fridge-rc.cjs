// Ensaio integrado com Auth/PostgREST/Storage reais; loja e dados estritamente artificiais.
const {randomUUID}=require('node:crypto');
const {loginAll,client,check,URL_BASE}=require('./live.cjs');
const {BUCKET}=require('./fridge-storage.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const date=days=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
(async()=>{
 const {clients:c}=await loginAll(),shop=process.env.GUIGS_V17_FIXTURE_SHOP;
 if(!/^[a-f0-9-]{36}$/.test(shop||''))throw Error('Fixture dedicada obrigatória');
 const owner=c.ownerA,att=c.attendantA,other=c.ownerA2;
 const fixture=await owner.from('guigs_shops').select('name').eq('id',shop).single();
 if(fixture.data?.name!=='Fixture v1.7 RC integrada')throw Error('Loja não autorizada para o ensaio');
 const call=(who,name,args={})=>who.rpc(name,{p_shop_id:shop,...args});
 const ok=async(who,name,args)=>{const r=await call(who,name,args);if(r.error)throw Error('RPC '+name+' código '+r.error.code);return r.data;};
 const code=randomUUID().slice(0,8);
 const save=(kind,p_values,p_id=null,p_revision=null)=>ok(owner,'guigs_save_fridge_layout',{p_kind:kind,p_values,p_id,p_revision});
 const p=await ok(owner,'guigs_create_product',{p_name:'RC bebida A '+code});
 const p2=await ok(owner,'guigs_create_product',{p_name:'RC bebida B '+code});
 const fridges=[],shelves=[],slots=[];
 for(const [side,product] of [['A',p],['B',p2]]){
   const f=await save('fridge',{name:'RC '+side+' '+code,width_ratio:side==='A'?.6:.85,sort_order:side==='A'?0:1});
   fridges.push(f);
   for(let i=0;i<3;i++){
     const h=await save('shelf',{name:'Prateleira '+(i+1),fridge_id:f.id,sort_order:i,y_ratio:i*.3,height_ratio:.3});
     shelves.push(h);
     if(i===0)slots.push(await save('slot',{name:'Posição repetida '+side,fridge_id:f.id,shelf_id:h.id,product_id:p,target_quantity:10,min_quantity:3,capacity_quantity:16}));
     else await save('slot',{name:'Posição '+side+' '+i,fridge_id:f.id,shelf_id:h.id,product_id:product,capacity_quantity:12});
   }
 }
 const [a,b]=slots;
 const lot=[];
 for(const [i,product,q,d] of [[1,p,24,25],[2,p,10,55],[3,p2,8,80]])lot.push((await ok(owner,'guigs_receive_stock',{
  p_product_id:product,p_lot_code:'RC-'+code+'-'+i,p_expiry:date(d),p_quantity:q,p_note:'Fixture artificial',p_supplier_id:null})).lot_id);
 check(fridges.length===2&&shelves.length===6&&lot.length===3,'RC: duas geladeiras, seis prateleiras, múltiplos produtos/lotes e seco');
 const bucket=who=>who.storage.from(BUCKET),photo=()=>shop+'/'+p+'/'+randomUUID()+'.png';
 const image1=photo(),image2=photo();
 const upload=(who,name,body=png,contentType='image/png')=>bucket(who).upload(name,body,{contentType,upsert:false});
 check(!!(await upload(att,photo())).error,'Storage: atendente não sobe imagem');
 check(!!(await upload(c.ownerB,photo())).error,'Storage: owner externo não sobe imagem');
 check(!!(await upload(owner,photo().replace(/\.png$/,'.svg'),png,'image/svg+xml')).error,'Storage: SVG recusado');
 check(!!(await upload(owner,photo(),Buffer.alloc(2*1024*1024+1))).error,'Storage: tamanho acima de 2 MiB recusado');
 check(!(await upload(owner,image1)).error,'Storage: owner sobe PNG privado');
 const set=(who,path,expected=null)=>call(who,'guigs_set_product_image',{p_product_id:p,p_path:path,p_expected_path:expected});
 check(!!(await set(att,image1)).error,'Storage: atendente não vincula imagem');
 check(!(await set(owner,image1)).error,'Storage: owner vincula imagem existente');
 check(!!(await bucket(c.attendantB).createSignedUrl(image1,30)).error,'Storage: leitura cross-shop negada');
 check(!!(await bucket(client()).createSignedUrl(image1,30)).error,'Storage: leitura anônima negada');
 const signed=await bucket(att).createSignedUrl(image1,30);
 check(!signed.error&&new URL(signed.data.signedUrl).origin===URL_BASE,'Storage: atendente recebe URL assinada do próprio projeto');
 const imageResponse=await fetch(signed.data.signedUrl);
 check(imageResponse.ok&&Buffer.from(await imageResponse.arrayBuffer()).equals(png),'Storage: bytes do PNG artificial conferidos');
 check(!(await upload(owner,image2)).error&&!(await set(owner,image2,image1)).error,'Storage: substituição com objeto imutável novo');
 check(!!(await set(owner,null,image1)).error,'Storage: revisão antiga não remove nova foto');
 check(!(await set(owner,null,image2)).error&&!(await set(owner,image2)).error,'Storage: desvinculação e novo vínculo controlados');
 const map=()=>ok(att,'guigs_get_fridge_map');
 check((await map()).slots.filter(s=>s.product_id===p).every(s=>s.image_path===image2),'Foto vinculada aparece em todos os blocos do produto');
 await ok(owner,'guigs_transfer_stock',{p_lot_id:lot[0],p_from_location:'stock',p_to_location:'fridge',p_quantity:10,p_note:'Fixture artificial'});
 const allocation=await ok(owner,'guigs_allocate_fridge_stock',{p_request_id:randomUUID(),p_entries:[[a,5],[b,3]].map(([s,quantity])=>({lot_id:lot[0],slot_id:s.id,quantity}))});
 check(allocation.quantity===8&&(await map()).unallocated.find(x=>x.lot_id===lot[0]).quantity===2,'RC: distribuição parcial preserva não alocado');
 const replenishment=async(s,quantity=null)=>{
   const quote=await ok(att,'guigs_get_fridge_replenishment',{p_slot_id:s.id,p_quantity:quantity});
   if(!quote.quantity)throw Error('Reposição sem fixture disponível');
   return {p_request_id:randomUUID(),p_slot_id:s.id,p_quantity:quote.quantity,p_plan:quote.plan};
 };
 const first=await replenishment(a);
 check(first.p_plan[0].lot_id===lot[0]&&first.p_quantity===5,'RC: reposição segue FEFO');
 await ok(att,'guigs_replenish_fridge_slot',first);
 const operation=async(who,p_spec,p_note='Fixture artificial')=>({p_request_id:randomUUID(),p_spec,p_note,
   p_expected:await ok(who,'guigs_get_fridge_operation',{p_spec})});
 const sale=(slot,quantity)=>({kind:'sale',origin:slot?'slot':'auto',slot_id:slot?.id||null,product_id:p,quantity});
 const out=(kind,slot,quantity)=>({kind,origin:'slot',slot_id:slot.id,lot_id:lot[0],product_id:p,quantity});
 const sold=await operation(att,sale(null,11));
 check(sold.p_expected.plan.length===2,'RC: venda split explícita');
 await ok(att,'guigs_apply_fridge_operation',sold);
 await ok(att,'guigs_apply_fridge_operation',await operation(att,out('loss',b,1)));
 await ok(owner,'guigs_apply_fridge_operation',await operation(owner,out('adjust',b,2)));
 await ok(att,'guigs_apply_fridge_operation',await operation(att,out('return',b,1)));
 check((await map()).slots.find(x=>x.id===b.id).quantity===1,'RC: perda, ajuste e retorno afetaram a posição escolhida');
 for(const who of [c.ownerB,c.attendantB]){
   check(!!(await call(who,'guigs_get_fridge_map')).error,'Mapa cross-shop recusado');
   check(!!(await call(who,'guigs_apply_fridge_operation',sold)).error,'Write cross-shop recusado');
 }
 const pids=await Promise.all([ok(owner,'guigs_v17_overlap_probe'),ok(att,'guigs_v17_overlap_probe')]);
 check(pids[0]!==pids[1],'PostgREST usa dois backends PostgreSQL em paralelo');
 const pairArgs=await replenishment(a,8);
 let pair=await Promise.all([call(att,'guigs_replenish_fridge_slot',pairArgs),call(other,'guigs_replenish_fridge_slot',{...pairArgs,p_request_id:randomUUID()})]);
 check(pair.filter(x=>!x.error).length===1,'Corrida: duas reposições, apenas uma aceita');
 const repl=await replenishment(a,2),saleArgs=await operation(att,sale(a,1));
 const start=(await map()).slots.find(x=>x.id===a.id).quantity;
 pair=await Promise.all([call(owner,'guigs_replenish_fridge_slot',repl),call(att,'guigs_apply_fridge_operation',saleArgs)]);
 check(pair.some(x=>!x.error)&&(await map()).slots.find(x=>x.id===a.id).quantity===start+(!pair[0].error?2:0)-(!pair[1].error?1:0),'Corrida: venda/reposição preserva débitos e créditos');
 const adjust=await operation(owner,out('adjust',b,2)),single=await operation(att,sale(b,1));
 pair=await Promise.all([call(owner,'guigs_apply_fridge_operation',adjust),call(att,'guigs_apply_fridge_operation',single)]);
 check(pair.filter(x=>!x.error).length===1,'Corrida: ajuste e venda não confirmam a mesma base');
 const stale=await operation(att,sale(a,1)),latest=(await map()).slots.find(x=>x.id===a.id);
 pair=await Promise.all([call(att,'guigs_apply_fridge_operation',stale),call(owner,'guigs_save_fridge_layout',{
   p_kind:'slot',p_values:{...latest,name:'Posição atualizada'},p_id:a.id,p_revision:latest.revision})]);
 check(pair.some(x=>!x.error),'Corrida: edição de layout versus operação tem ordem segura');
 const inventory=await ok(owner,'guigs_create_spatial_inventory',{p_observation:'RC artificial '+code}),ref={p_inventory_id:inventory};
 const read=()=>ok(att,'guigs_get_spatial_inventory',ref);
 let d=await read();
 check(d.items.some(i=>i.slot_id===a.id)&&d.items.some(i=>i.slot_id===b.id)&&d.items.some(i=>i.slot_id===null&&i.location==='fridge'),
  'RC: snapshot inclui as duas geladeiras e não alocado');
 const count=(i,quantity)=>ok(att,'guigs_count_spatial_inventory_item',{...ref,p_item_id:i.id,p_version:i.version,p_quantity:quantity});
 for(const i of d.items)await count(i,i.basis_quantity);
 const during=await operation(att,sale(a,1));
 await ok(att,'guigs_apply_fridge_operation',during);
 d=await read();
 const conflicts=d.items.filter(x=>x.conflict);
 check(conflicts.length===1&&conflicts[0].slot_id===a.id,'Corrida: venda durante inventário invalida a partição movimentada');
 const changed=conflicts[0];
 await ok(att,'guigs_recount_spatial_inventory_item',{...ref,p_item_id:changed.id,p_version:changed.version});
 const refreshed=(await read()).items.find(i=>i.id===changed.id);
 await count(refreshed,refreshed.basis_quantity-1);
 d=await read();
 await ok(owner,'guigs_set_spatial_inventory_status',{...ref,p_status:'review',p_version:d.inventory.version});
 const closing={...ref,p_confirm:true,p_version:(await read()).inventory.version,p_request_id:randomUUID()};
 pair=await Promise.all([call(owner,'guigs_complete_spatial_inventory',closing),call(owner,'guigs_complete_spatial_inventory',closing)]);
 check(pair.every(x=>!x.error&&x.data.adjustments===1),'Corrida: fechamentos repetidos produzem um único ajuste');
 d=await read();check(d.items.filter(x=>x.adjustment_event_id).length===1&&d.inventory.status==='completed','RC: ajuste ligado ao item e inventário fechado');
 const history=await att.rpc('guigs_get_spatial_history',{p_shop:shop,p_limit:50,p_partition:'slot'});
 check(!history.error&&history.data.some(x=>x.movement_type==='sale'&&x.parts.length===2)&&history.data.some(x=>x.movement_type==='adjust'),'RC: histórico espacial e split auditáveis');
 const reportArgs={p_from:new Date(Date.now()-3600000).toISOString(),p_to:new Date(Date.now()+3600000).toISOString()};
 const report=await ok(owner,'guigs_get_reports',reportArgs);
 check(report.spatial_summary.length>0&&report.summary.sale_units>=11&&report.summary.loss_units===1,'RC: relatórios refletem ledger');
 check(!!(await call(att,'guigs_get_reports',reportArgs)).error,'RC: relatório owner-only');
 const final=await map(),global=await owner.rpc('guigs_get_lot_balances',{p_shop:shop});
 const sum=(all,id)=>all.filter(l=>l.lot_id===id).reduce((n,l)=>n+l.quantity,0);
 check(!global.error&&global.data.every(r=>Number(r.fridge)===sum([...final.unallocated,...final.slots.flatMap(x=>x.lots)],r.lot_id)&&
   Number(r.stock)===sum(final.dry,r.lot_id)),'RC: saldo global e partições iguais para cada lote');
})().catch(e=>{console.error(/^RPC [a-z_]+ código [A-Za-z0-9_]+$/.test(e.message)?e.message:'Falha no ensaio integrado; detalhes e credenciais omitidos.');process.exitCode=1;});
