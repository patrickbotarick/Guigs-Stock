const assert=require('node:assert/strict');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
const shop=id(10),product=id(20),lot=id(30),earlier=id(32),expired=id(33),a=id(60),b=id(61);

(async()=>{
  const db=await createTestDatabase({groupedInventory:true});
  let checks=0,key=500;
  const eq=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
  const fail=async(promise,pattern)=>{await assert.rejects(promise,pattern);checks++;};
  const rpc=(role,name,args)=>asUser(db,role,async tx=>(await tx.query(
    'select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') data',args)).rows[0].data);
  const quote=(source,dest,batch=null,qty=null,role='owner',store=shop)=>
    rpc(role,'guigs_quote_fridge_slot_move',[store,source,dest,batch,qty]);
  const apply=(source,dest,batch,qty,expected,request=id(key++),role='owner',store=shop)=>
    rpc(role,'guigs_apply_fridge_slot_move',[store,request,source,dest,batch,qty,expected]);
  const move=async(source,dest,batch,qty,role='owner')=>apply(source,dest,batch,qty,
    await quote(source,dest,batch,qty,role),id(key++),role);
  const history=(slot,limit=12,cursor={},role='attendant',store=shop)=>
    rpc(role,'guigs_get_fridge_slot_history',[store,slot,limit,cursor.created_at??null,cursor.event_id??null]);
  const totals=async()=>(await db.query(`select lot_id,sum(delta)::int total,
    coalesce(sum(delta) filter(where location='stock'),0)::int dry,
    coalesce(sum(delta) filter(where location='fridge' and slot_id is null),0)::int free,
    coalesce(sum(delta) filter(where location='fridge'),0)::int fridge
    from public.guigs_movements group by lot_id order by lot_id`)).rows;
  const balances=async slot=>(await db.query(`select lot_id,sum(delta)::int quantity from public.guigs_movements
    where slot_id=$1 group by lot_id having sum(delta)>0 order by lot_id`,[slot])).rows;
  const shopping=async()=> (await rpc('owner','guigs_get_shopping_board',[shop,10,0])).needs.find(p=>p.product_id===product);
  try{
    await db.exec(`
      insert into public.guigs_shops(id,name) values('${id(11)}','Outra loja');
      insert into public.guigs_lots(id,shop_id,product_id,code,expiry) values
        ('${earlier}','${shop}','${product}','FEFO anterior',current_date+5),
        ('${expired}','${shop}','${product}','Vencido',current_date-1);
      update public.guigs_products set min_total=30,target_total=50 where id='${product}';
      insert into public.guigs_fridges(id,shop_id,name,active) values
        ('${id(40)}','${shop}','Metalfrio',true),('${id(41)}','${shop}','Imbera',true),
        ('${id(42)}','${shop}','Inativa',false),('${id(43)}','${id(11)}','Externa',true);
      insert into public.guigs_fridge_shelves(id,shop_id,fridge_id,name) values
        ('${id(50)}','${shop}','${id(40)}','Prateleira 1'),('${id(51)}','${shop}','${id(41)}','Prateleira 2'),
        ('${id(52)}','${shop}','${id(42)}','Prateleira 3'),('${id(53)}','${id(11)}','${id(43)}','Externa');
      insert into public.guigs_fridge_slots(id,shop_id,fridge_id,shelf_id,product_id,name,min_quantity,target_quantity,capacity_quantity)
        values ('${a}','${shop}','${id(40)}','${id(50)}','${product}','Bloco',2,5,25),
          ('${b}','${shop}','${id(41)}','${id(51)}','${product}','Bloco',2,5,25),
          ('${id(62)}','${shop}','${id(41)}','${id(51)}','${id(21)}','Incompatível',0,1,25),
          ('${id(63)}','${shop}','${id(41)}','${id(51)}','${product}','Sem capacidade',null,null,null),
          ('${id(64)}','${shop}','${id(41)}','${id(51)}','${product}','Pequeno',0,1,1),
          ('${id(65)}','${shop}','${id(42)}','${id(52)}','${product}','Pai inativo',0,1,25),
          ('${id(66)}','${id(11)}','${id(43)}','${id(53)}',null,'Externo',0,1,25);
      insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,slot_id,spatial) values
        ('${shop}','${lot}',gen_random_uuid(),'receipt','fridge',12,'${id(1)}','${a}',true),
        ('${shop}','${earlier}',gen_random_uuid(),'receipt','fridge',4,'${id(1)}','${a}',true),
        ('${shop}','${lot}',gen_random_uuid(),'receipt','fridge',3,'${id(1)}','${b}',true);
    `);
    const before=await totals(), purchase=await shopping();
    const initial=await quote(a,b,lot,5,'attendant');
    eq([initial.source,initial.destination,initial.quantity,initial.space],['Metalfrio / Prateleira 1 / Bloco','Imbera / Prateleira 2 / Bloco',5,22]);
    const request=id(600), partial=await apply(a,b,lot,5,initial,request,'attendant');
    eq(await apply(a,b,lot,5,initial,request,'attendant'),partial);
    await fail(apply(a,b,lot,4,initial,request,'attendant'),/Identificador já utilizado/);
    await fail(apply(a,b,lot,5,initial,request,'owner'),/Identificador já utilizado/);
    eq(await balances(a),[{lot_id:lot,quantity:7},{lot_id:earlier,quantity:4}]);
    eq(await balances(b),[{lot_id:lot,quantity:8}]);eq(await totals(),before);
    await fail(quote(a,b,lot,0),/inteira positiva/);
    await fail(quote(a,b,lot,-1),/inteira positiva/);
    await fail(quote(a,b,lot,1.5),/integer/);
    await fail(quote(a,b,lot,8),/Saldo insuficiente/);
    await fail(quote(a,id(62),lot,1),/incompatível/);
    await fail(quote(a,id(63),lot,1),/capacidade/);
    await fail(quote(a,id(64),lot,2),/Espaço insuficiente/);
    await fail(quote(a,id(65),lot,1),/Destino indisponível/);
    await fail(quote(a,id(66),lot,1),/Destino indisponível/);
    await fail(quote(a,a,lot,1),/blocos diferentes/);
    await fail(quote(a,b,lot,1,'attendant',id(11)),/Acesso negado/);
    await fail(history(a,12,{},'attendant',id(11)),/Acesso negado/);
    await fail(history(id(66)),/Bloco indisponível/);
    const old=await quote(a,b,lot,1);
    await move(a,b,lot,1);
    await fail(apply(a,b,lot,1,old),/mudou/);
    const consolidatedPlan=await quote(a,b);
    eq(consolidatedPlan.lots.map(x=>[x.lot_id,x.quantity]),[[earlier,4],[lot,6]]);
    await db.exec(`create function public.test_move_credit() returns trigger language plpgsql as $$
      begin if new.movement_type='relocate' and new.delta>0 then raise exception 'Falha artificial no crédito'; end if;
      return new; end $$;
      create trigger test_move_credit before insert on public.guigs_movements for each row execute function public.test_move_credit();`);
    await fail(apply(a,b,null,null,consolidatedPlan,id(601)),/Falha artificial no crédito/);
    eq(await balances(a),[{lot_id:lot,quantity:6},{lot_id:earlier,quantity:4}]);
    eq((await db.query('select count(*)::int n from guigs_private.spatial_commands where request_id=$1',[id(601)])).rows[0].n,0);
    await db.exec('drop trigger test_move_credit on public.guigs_movements');
    const consolidated=await apply(a,b,null,null,consolidatedPlan,id(601));
    eq(await balances(a),[]);eq(await balances(b),[{lot_id:lot,quantity:15},{lot_id:earlier,quantity:4}]);
    eq(await totals(),before);eq(await shopping(),purchase);
    eq((await db.query('select count(*)::int as n,sum(delta)::int as total from public.guigs_movements where event_id=$1',[consolidated.event_id])).rows[0],{n:4,total:0});
    const firstPage=await history(a,2), nextPage=await history(a,2,firstPage.events.at(-1));
    eq(firstPage.has_more,true);eq(nextPage.events.some(event=>firstPage.events.some(first=>first.event_id===event.event_id)),false);
    const full=await history(a);
    eq(full.events.filter(event=>event.kind==='receipt').length,2);
    eq(full.events.find(event=>event.event_id===partial.event_id).parts.map(part=>[part.in_block,part.delta]),[[true,-5],[false,5]]);
    eq((await history(b)).events.find(event=>event.event_id===partial.event_id).parts.map(part=>[part.in_block,part.delta]),[[false,-5],[true,5]]);
    const loss={kind:'loss',origin:'slot',slot_id:b,lot_id:lot,product_id:product,quantity:1};
    const lossPlan=await rpc('attendant','guigs_get_fridge_operation',[shop,loss]);
    const lost=await rpc('attendant','guigs_apply_fridge_operation',[shop,id(key++),loss,lossPlan,'Fixture']);
    eq((await history(b)).events.find(event=>event.event_id===lost.event_id).kind,'loss');
    const replenish=await rpc('attendant','guigs_get_fridge_replenishment',[shop,a,2]);
    const replenished=await rpc('attendant','guigs_replenish_fridge_slot',[shop,id(key++),a,2,replenish.plan]);
    eq((await history(a)).events.find(event=>event.event_id===replenished.event_id).kind,'replenish');
    await db.exec(`insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,slot_id,spatial)
      values('${shop}','${expired}',gen_random_uuid(),'receipt','fridge',1,'${id(1)}','${a}',true);`);
    await fail(quote(a,b,expired,1),/vencidos/);
    await fail(quote(a,b),/vencidos/);
    const inv=await rpc('owner','guigs_create_spatial_inventory',[shop,'fixture']);
    await fail(quote(b,a,lot,1,'attendant'),/inventário ativo/);
    const rows=(await db.query('select * from public.guigs_inventory_items where inventory_id=$1',[inv])).rows;
    for(const row of rows)await rpc('attendant','guigs_count_spatial_inventory_item',
      [shop,inv,row.id,row.basis_quantity-(row.lot_id===lot&&row.slot_id===b?1:0),row.version]);
    let inventory=await rpc('owner','guigs_get_spatial_inventory',[shop,inv]);
    await rpc('owner','guigs_set_spatial_inventory_status',[shop,inv,'review',inventory.inventory.version]);
    await fail(quote(b,a,lot,1),/inventário ativo/);
    inventory=await rpc('owner','guigs_get_spatial_inventory',[shop,inv]);
    await rpc('owner','guigs_complete_spatial_inventory',[shop,inv,inventory.inventory.version,true,id(key++)]);
    eq((await history(b)).events.some(event=>event.kind==='inventory'),true);
    const alerts=(await import('../fridges.js')).fridgeSlotAlerts;
    eq(alerts({quantity:0,product_id:product,min_quantity:null,target_quantity:1,capacity_quantity:null},'2026-11-11'),
      {adequate:false,low:false,full:false,pending:true,capacity:true,expiry:false,empty:true});
    eq(alerts({quantity:4,product_id:product,min_quantity:1,target_quantity:4,capacity_quantity:4,
      lots:[{quantity:1,expiry:'2026-12-11'}]},'2026-11-11').expiry,true);
    console.log('Mapa v1.8D banco: '+checks+' verificações passaram em PostgreSQL isolado.');
  }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
