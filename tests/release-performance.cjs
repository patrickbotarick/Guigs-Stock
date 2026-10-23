// Sonda local de volume, PostgreSQL/WASM em memória. Não conecta ao Supabase.
const assert=require('node:assert/strict');
const {createTestDatabase,asUser,id,callRPC}=require('./inventory-support.cjs');
let checks=0;const check=(v,m)=>{assert.ok(v,m);checks++;};
const timings={};
async function timed(name,work){const start=performance.now();const result=await work();timings[name]=Math.round(performance.now()-start);check(timings[name]<5000,`${name} excedeu orçamento local de 5s: ${timings[name]}ms`);return result;}
(async()=>{
 const db=await createTestDatabase();
 try {
  await db.exec('delete from public.guigs_movements');
  await db.query("insert into public.guigs_suppliers(id,shop_id,name) select md5('supplier-'||n)::uuid,$1,'Fornecedor artificial '||n from generate_series(1,10)n",[id(10)]);
  await db.query("insert into public.guigs_products(id,shop_id,name,min_total,target_total,min_fridge,target_fridge) select md5('product-'||n)::uuid,$1,'Produto artificial '||n,10,100,5,20 from generate_series(1,98)n",[id(10)]);
  await db.query(`insert into public.guigs_lots(id,shop_id,product_id,code,expiry,supplier_id)
   select md5('lot-'||n)::uuid,$1,p.id,'LOTE-VOLUME-'||n,current_date+30+(n%60),md5('supplier-'||(1+n%10))::uuid
   from generate_series(1,998)n join (select id,row_number()over(order by id) as position from public.guigs_products where shop_id=$1)p on p.position=1+(n%100)`,[id(10)]);
  await db.query(`insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,created_at)
   select $1,l.id,md5(l.id::text||':'||case when n between 22 and 41 then 'pair-'||((n-22)/2)::text else 'single-'||n end)::uuid,
    case when n=1 then 'receipt' when n<=21 then 'sale' when n<=41 then 'transfer' else 'loss' end,
    case when n between 22 and 41 and n%2=1 then 'fridge' else 'stock' end,
    case when n=1 then 100 when n between 22 and 41 and n%2=1 then 1 else -1 end,
    $2,case when n=1 and s.name is not null then 'Fornecedor: '||s.name else 'Volume artificial' end,
    now()-(50-n)*interval '1 hour'
   from public.guigs_lots l left join public.guigs_suppliers s on s.id=l.supplier_id and s.shop_id=l.shop_id cross join generate_series(1,50)n where l.shop_id=$1`,[id(10),id(1)]);
  await db.query(`insert into public.guigs_inventories(id,shop_id,status,started_by,started_at,cancelled_at,start_movement_count)
   select md5('inventory-'||n)::uuid,$1,'cancelled',$2,now()-n*interval '1 day',now()-n*interval '1 day',50000 from generate_series(1,20)n`,[id(10),id(1)]);
  await db.query(`insert into public.guigs_inventory_items(shop_id,inventory_id,lot_id,product_id,product_name,lot_code,expiry,location,expected_initial,initial_movement_count,basis_quantity,basis_movement_count,counted_quantity)
   select $1,i.id,l.id,p.id,p.name,l.code,l.expiry,x.location,0,0,0,0,0 from public.guigs_inventories i
   cross join public.guigs_lots l join public.guigs_products p on p.id=l.product_id and p.shop_id=l.shop_id
   cross join(values('stock'),('fridge'))x(location) where i.shop_id=$1 and l.shop_id=$1`,[id(10)]);
  await db.exec('analyze');
  for(const [table,count]of[['guigs_products',100],['guigs_lots',1000],['guigs_movements',50000],['guigs_inventory_items',40000]])check((await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n===count,'Volume '+table);
  const owner=work=>asUser(db,'owner',work);
  const reports=await timed('reports',()=>owner(async tx=>(await tx.query("select public.guigs_get_reports($1,now()-interval '30 days',now()+interval '1 day') as data",[id(10)])).rows[0].data));
  check(reports.summary.receipt_units===100000&&reports.summary.sale_units===20000,'Totais corretos sob volume');
  check(reports.summary.transfer_units===10000&&reports.summary.transfer_operations===10000,'Pares corretos sob volume');
  const history=await timed('history_filtered',()=>owner(tx=>tx.query("select * from public.guigs_get_history($1,20,0,$2,'sale',null,now()-interval '30 days',now()+interval '1 day','Produto')",[id(10),(reports.stock.products.find(p=>p.name.startsWith('Produto'))).id])));
  check(history.rows.length>0&&history.rows.length<=20,'Histórico paginado filtrado');
  const lot=reports.stock.lots[0].id;
  const fefo=await timed('fefo',()=>owner(tx=>tx.query('select * from public.guigs_get_fefo_candidates($1,$2)',[id(10),lot])));
  check(fefo.rows.length<1000,'FEFO restrito ao produto');
  const inv=await timed('inventory_create',()=>callRPC(db,'owner','guigs_create_inventory',{p_shop_id:id(10),p_observation:'Volume artificial'}));
  let detail=await timed('inventory_detail',()=>callRPC(db,'owner','guigs_get_inventory',{p_shop_id:id(10),p_inventory_id:inv}));
  check(detail.items.length===2000,'Snapshot inclui dois locais por lote');
  check(detail.items.every(i=>Number(i.basis_quantity)===(i.location==='stock'?61:10)),'Saldo correto no snapshot');
  // Preenchimento em lote apenas para medir o fechamento; permissões de contagem são testadas nas suítes funcionais.
  await db.query('update public.guigs_inventory_items set counted_quantity=basis_quantity where inventory_id=$1',[inv]);
  detail=await callRPC(db,'owner','guigs_get_inventory',{p_shop_id:id(10),p_inventory_id:inv});
  await callRPC(db,'owner','guigs_set_inventory_status',{p_shop_id:id(10),p_inventory_id:inv,p_status:'review',p_version:detail.inventory.version});
  detail=await callRPC(db,'owner','guigs_get_inventory',{p_shop_id:id(10),p_inventory_id:inv});
  const done=await timed('inventory_complete_equal',()=>callRPC(db,'owner','guigs_complete_inventory',{p_shop_id:id(10),p_inventory_id:inv,p_version:detail.inventory.version,p_confirm:true}));
  check(done.adjustments===0,'Fechamento sem divergência não cria ajustes');
  const second=await callRPC(db,'owner','guigs_create_inventory',{p_shop_id:id(10),p_observation:'Divergência artificial'});
  await db.query('update public.guigs_inventory_items set counted_quantity=basis_quantity+1 where inventory_id=$1',[second]);
  detail=await callRPC(db,'owner','guigs_get_inventory',{p_shop_id:id(10),p_inventory_id:second});
  await callRPC(db,'owner','guigs_set_inventory_status',{p_shop_id:id(10),p_inventory_id:second,p_status:'review',p_version:detail.inventory.version});
  detail=await callRPC(db,'owner','guigs_get_inventory',{p_shop_id:id(10),p_inventory_id:second});
  const changed=await timed('inventory_complete_2000_adjustments',()=>callRPC(db,'owner','guigs_complete_inventory',{p_shop_id:id(10),p_inventory_id:second,p_version:detail.inventory.version,p_confirm:true}));
  check(changed.adjustments===2000,'Fechamento com divergências em todos os itens');
  const plan=(await db.query("explain select * from public.guigs_movements where shop_id=$1 and created_at>=now()-interval '1 hour' order by created_at desc limit 20",[id(10)])).rows.map(r=>r['QUERY PLAN']).join('\n');
  check(/guigs_movements_shop_created_idx/.test(plan),'Histórico seletivo utiliza índice existente');
  console.log(JSON.stringify({environment:'PGlite em memória; dados artificiais',products:100,lots:1000,movementsInitial:50000,historicalInventories:20,historicalItems:40000,timingsMs:timings,reportBytes:Buffer.byteLength(JSON.stringify(reports)),inventoryDetailBytes:Buffer.byteLength(JSON.stringify(detail)),checks},null,2));
  console.log(`Performance: ${checks} verificações passaram.`);
 }finally{await db.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
