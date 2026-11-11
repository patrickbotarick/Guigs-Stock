const assert=require('node:assert/strict');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
const shop=id(10),product=id(20),manual=id(21),supplier=id(70),lot=id(30),slot=id(60);

(async()=>{
 const db=await createTestDatabase({groupedInventory:true});
 let checks=0;
 const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
 const fail=async(promise,pattern)=>{await assert.rejects(promise,pattern);checks++;};
 const call=(role,name,params)=>asUser(db,role,async tx=>(await tx.query(
   'select public.'+name+'('+params.map((_,i)=>'$'+(i+1)).join(',')+') data',params)).rows[0].data);
 const board=(role='owner',store=shop)=>call(role,'guigs_get_shopping_board',[store]);
 const detail=(key,role='owner',store=shop)=>call(role,'guigs_get_purchase_order',[store,key]);
 let request=200;
 const apply=(action,payload,role='owner',key=id(request++),store=shop)=>
   call(role,'guigs_apply_shopping_command',[store,key,action,payload]);
 const transition=(order,status,role='owner',key)=>apply('status',{order_id:order.id,version:order.version,status},role,key);
 const ledger=()=>db.query('select * from public.guigs_movements order by id').then(r=>r.rows);
 const line=(product_id,quantity,source='manual',supplier_id=null,expected_suggestion=null,note='')=>
   ({product_id,quantity,source,supplier_id,expected_suggestion,note});
 const needs=async()=>new Map((await board()).needs.map(row=>[row.product_id,row]));
 try{
  await db.exec(`
   delete from public.guigs_movements;
   insert into public.guigs_shops(id,name) values('${id(11)}','Outra loja');
   insert into public.guigs_suppliers(id,shop_id,name) values('${supplier}','${shop}','Distribuidora teste'),
     ('${id(71)}','${id(11)}','Fornecedor externo');
   update public.guigs_products set min_total=20,target_total=45,min_fridge=90,target_fridge=100 where id='${product}';
   update public.guigs_products set min_total=null,target_total=20 where id='${manual}';
   insert into public.guigs_products(id,shop_id,name,min_total,target_total,active) values
     ('${id(22)}','${shop}','Igual',5,10,true),('${id(23)}','${shop}','Acima',3,6,true),
     ('${id(24)}','${shop}','Sem meta',2,null,true),('${id(25)}','${shop}','Zerado',1,7,true),
     ('${id(26)}','${shop}','Inativo',1,8,false),('${id(27)}','${shop}','Mínimo zero',0,10,true);
   insert into public.guigs_lots(id,shop_id,product_id,code,expiry) values
     ('${id(32)}','${shop}','${product}','Próximo',current_date+10),
     ('${id(33)}','${shop}','${product}','Vencido',current_date-1),
     ('${id(34)}','${shop}','${id(22)}','Igual',current_date+70),
     ('${id(35)}','${shop}','${id(23)}','Acima',current_date+70);
   insert into public.guigs_fridges(id,shop_id,name) values('${id(40)}','${shop}','Geladeira artificial');
   insert into public.guigs_fridge_shelves(id,shop_id,fridge_id,name) values('${id(50)}','${shop}','${id(40)}','Prateleira');
   insert into public.guigs_fridge_slots(id,shop_id,fridge_id,shelf_id,product_id,name,capacity_quantity)
     values('${slot}','${shop}','${id(40)}','${id(50)}','${product}','Bloco',15);
   insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,slot_id,spatial)
     values ('${shop}','${lot}',gen_random_uuid(),'receipt','stock',6,'${id(1)}',null,false),
     ('${shop}','${lot}',gen_random_uuid(),'receipt','fridge',4,'${id(1)}',null,false),
     ('${shop}','${lot}',gen_random_uuid(),'receipt','fridge',6,'${id(1)}','${slot}',true),
     ('${shop}','${id(32)}',gen_random_uuid(),'receipt','stock',2,'${id(1)}',null,false),
     ('${shop}','${id(33)}',gen_random_uuid(),'receipt','stock',100,'${id(1)}',null,false),
     ('${shop}','${id(34)}',gen_random_uuid(),'receipt','stock',5,'${id(1)}',null,false),
     ('${shop}','${id(35)}',gen_random_uuid(),'receipt','stock',12,'${id(1)}',null,false);
  `);
  let by=await needs(), p=by.get(product);
  eq([p.dry,p.unallocated,p.slots,p.available,p.expired,p.near_expiry,p.base_suggested,p.suggested],[8,4,6,18,100,2,27,27]);
  eq(by.get(id(22)).suggested,0);eq(by.get(id(23)).suggested,0);
  eq(by.get(manual).suggested,null);eq(by.get(id(24)).suggested,null);
  eq(by.get(id(25)).suggested,7);eq(by.has(id(26)),false);eq(by.get(id(27)).suggested,0);
  eq((await board('attendant')).suppliers.map(s=>s.id),[supplier]);
  await fail(board('attendant',id(11)),/Acesso negado/);
  const limits={product_id:manual,min_total:4,target_total:10,expected:{min_total:null,target_total:20}};
  await fail(apply('limits',limits,'attendant'),/proprietários/);
  await fail(apply('limits',{...limits,target_total:2}),/maior ou igual/);
  await fail(apply('limits',{...limits,min_total:1.2}),/integer/);
  eq((await apply('limits',limits)).min_total,4);
  await fail(apply('limits',limits),/parâmetros mudaram/);
  eq((await apply('limits',{...limits,min_total:null,target_total:null,expected:{min_total:4,target_total:10}})).target_total,null);
  eq((await db.query('select min_fridge,target_fridge from public.guigs_products where id=$1',[product])).rows[0],{min_fridge:90,target_fridge:100});
  const beginLedger=await ledger();
  const draft={note:'Comprar nesta semana',items:[line(product,25,'suggestion',supplier,27),line(manual,3)]};
  const creationKey=id(400);
  let order=await apply('save',draft,'attendant',creationKey);
  eq(await apply('save',draft,'attendant',creationKey),order);
  await fail(apply('save',{...draft,note:'outra ação'},'attendant',creationKey),/Identificador já utilizado/);
  eq(order.status,'draft');eq((await needs()).get(product).on_order,0);
  let saved=await detail(order.id,'attendant');
  const first=saved.items.find(item=>item.product_id===product), second=saved.items.find(item=>item.product_id===manual);
  eq([first.quantity,first.original_suggestion,first.supplier_name,second.source,second.supplier_id],[25,27,'Distribuidora teste','manual',null]);
  await fail(detail(order.id,'attendant',id(11)),/Acesso negado/);
  await fail(apply('save',{...draft,items:[line(product,1,'manual',id(71))]}),/Fornecedor indisponível/);
  await fail(apply('save',{...draft,items:[line(product,0)]}),/quantidade inteira positiva/);
  await fail(apply('save',{...draft,items:[line(product,1.5)]}),/integer/);
  await fail(apply('save',{...draft,items:[line(product,1,'suggestion',null,26)]}),/sugestão mudou/);
  await fail(apply('save',{...draft,items:[line(product,1),line(product,2)]}),/distintos/);
  await fail(asUser(db,'owner',tx=>tx.query("update public.guigs_purchase_orders set status='received'")),/permission denied/);
  const parallel=await apply('save',{items:[line(product,27,'suggestion',null,27)]},'attendant');
  const edit={order_id:order.id,version:order.version,note:'Quantidade ajustada',items:[
    line(product,24,'suggestion',null,27,'Sem gelo')]};
  order=await apply('save',edit,'attendant');
  await fail(apply('save',edit,'attendant'),/lista foi alterada/);
  saved=await detail(order.id);
  eq(saved.items.find(item=>item.product_id===product).id,first.id);
  eq(saved.events[0].previous.items.find(item=>item.product_id===product).supplier_name,'Distribuidora teste');
  eq(saved.events[0].current.items.find(item=>item.product_id===product).supplier_id,null);
  eq([saved.events[0].previous.items.length,saved.events[0].current.items.length],[2,1]);
  eq(await ledger(),beginLedger);
  await call('owner','guigs_adjust_stock',[shop,lot,'stock',7,'ajuste artificial após criar a lista']);
  const revisedLedger=await ledger();
  eq((await needs()).get(product).suggested,26);
  eq((await detail(order.id)).items.find(item=>item.product_id===product).original_suggestion,27);
  order=await transition(order,'pending','attendant');
  eq([(await needs()).get(product).on_order,(await needs()).get(product).suggested],[24,2]);
  await fail(transition(parallel,'pending','attendant'),/necessidade mudou/);
  await fail(transition(order,'ordered','attendant'),/Acesso negado/);
  await fail(transition(order,'received'),/Transição não permitida/);
  order=await transition(order,'ordered');
  eq((await board()).order_counts.awaiting,1);
  const receiptKey=id(401), ordered=order;
  order=await transition(ordered,'received','owner',receiptKey);
  eq(await transition(ordered,'received','owner',receiptKey),order);
  await fail(transition(order,'received'),/Transição não permitida/);
  eq([(await needs()).get(product).on_order,(await needs()).get(product).suggested],[0,26]);
  eq((await detail(order.id)).events.map(e=>e.action),['received','ordered','pending','items_updated','created']);
  const canceled=await transition(parallel,'cancelled','attendant');
  eq(canceled.status,'cancelled');
  let pendingManual=await apply('save',{items:[line(manual,3)]},'attendant');
  pendingManual=await transition(pendingManual,'pending','attendant');
  eq((await needs()).get(manual).on_order,3);
  eq((await transition(pendingManual,'cancelled')).status,'cancelled');
  eq((await needs()).get(manual).on_order,0);
  await fail(apply('save',{order_id:order.id,version:order.version,items:[]}),/Somente rascunhos/);
  eq(await ledger(),revisedLedger);
  console.log('Compras banco: '+checks+' verificações passaram em PostgreSQL isolado.');
 }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
