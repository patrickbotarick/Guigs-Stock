const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
const shop=id(800),actor=id(1);
const uid=n=>`('20000000-0000-0000-0000-'||lpad((${n})::text,12,'0'))::uuid`;
let checks=0;
const check=(v,label)=>{assert.ok(v,label);checks++;};
(async()=>{
 const db=await createTestDatabase(),durations={};
 try{
  const folder=path.join(__dirname,'../supabase/migrations');
  for(const f of fs.readdirSync(folder).filter(f=>/spatial_fridge_.*\.sql$/.test(f)).sort())await db.exec(fs.readFileSync(path.join(folder,f),'utf8'));
  await db.exec(`
  insert into public.guigs_shops(id,name) values('${shop}','Volume espacial artificial');
  insert into public.guigs_memberships(shop_id,user_id,role) values('${shop}','${actor}','owner');
  insert into public.guigs_products(id,shop_id,name)
    select ${uid('10000+n')},'${shop}','Produto '||n from generate_series(0,99) n;
  insert into public.guigs_lots(id,shop_id,product_id,code,expiry)
    select ${uid('20000+n')},'${shop}',${uid('10000+n/10')},'VOLUME-'||n,current_date+10+n%60 from generate_series(0,999) n;
  insert into public.guigs_fridges(id,shop_id,name,sort_order)
    select ${uid('30000+n')},'${shop}','Geladeira '||n,n from generate_series(0,4) n;
  insert into public.guigs_fridge_shelves(id,shop_id,fridge_id,name,sort_order,y_ratio,height_ratio)
    select ${uid('31000+n')},'${shop}',${uid('30000+n/6')},'Prateleira '||n,n%6,(n%6)*0.16,0.16 from generate_series(0,29) n;
  insert into public.guigs_fridge_slots(id,shop_id,fridge_id,shelf_id,product_id,name,sort_order,x_ratio,width_ratio,min_quantity,target_quantity,capacity_quantity)
    select ${uid('32000+n')},'${shop}',${uid('30000+(n%30)/6')},${uid('31000+n%30')},${uid('10000+n')},'Posição '||n,n/30,
      (n/30)*0.25,0.25,20,80,200 from generate_series(0,99) n;
  insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note)
    select '${shop}',${uid('20000+n')},gen_random_uuid(),'receipt','stock',1,'${actor}','Volume artificial'
    from generate_series(0,999) n cross join generate_series(1,50) j;
  insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,spatial)
    select '${shop}',${uid('20000+n')},${uid('60000+n')},'transfer','stock',-5,'${actor}','Volume artificial',true
    from generate_series(0,999) n;
  insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,slot_id,spatial)
    select '${shop}',${uid('20000+n')},${uid('60000+n')},'transfer','fridge',5,'${actor}','Volume artificial',${uid('32000+n/10')},true
    from generate_series(0,999) n;`);
  const timed=async(name,sql,args=[shop])=>{
    const t=performance.now();
    const result=await asUser(db,'owner',async tx=>(await tx.query(sql,args)).rows[0].data);
    durations[name]=Math.round(performance.now()-t);
    check(durations[name]<10000,name+' respeita orçamento local de 10 s');
    return result;
  };
  const map=await timed('mapa','select public.guigs_get_fridge_map($1) as data');
  check(map.fridges.length===5&&map.shelves.length===30&&map.slots.length===100,'Layout 5/30/100');
  check(map.slots.every(s=>s.quantity===50&&s.lots.length===10),'Todos os slots reconciliados');
  check(map.dry.length===1000&&map.dry.reduce((n,l)=>n+l.quantity,0)===45000,'Seco preservado');
  check(map.slots.reduce((n,s)=>n+s.quantity,0)===5000&&map.unallocated.length===0,'Geladeira global preservada');
  const history=await timed('historico',"select public.guigs_get_spatial_history($1,p_partition=>'slot') as data");
  check(history.length===20&&history[0].total_count===1000,'Histórico expande somente 20 eventos');
  const reports=await timed('relatorios',"select public.guigs_get_reports($1,now()-interval '1 day',now()+interval '1 day') as data");
  check(reports.summary.receipt_units===50000&&reports.summary.transfer_units===5000,'Métricas do volume corretas');
  const quote=await timed('reposicao','select public.guigs_get_fridge_replenishment($1,$2) as data',[shop,id(32000)]);
  check(quote.quantity===30&&quote.dry_available===450,'Reposição usa meta e saldo seco por produto');
  const inv=await timed('inventario_criacao','select public.guigs_create_spatial_inventory($1) as data');
  const detail=await timed('inventario_detalhe','select public.guigs_get_spatial_inventory($1,$2) as data',[shop,inv]);
  check(detail.items.length===3000&&detail.new_lots===0,'Snapshot contém seco, não alocado e posição por lote');
  const bytes={map:Buffer.byteLength(JSON.stringify(map)),inventory:Buffer.byteLength(JSON.stringify(detail))};
  check(bytes.map<2*1024*1024&&bytes.inventory<4*1024*1024,'Payload dentro dos orçamentos do ensaio');
  console.log(JSON.stringify({engine:'PGlite local',fridges:5,shelves:30,slots:100,products:100,lots:1000,movements:52000,ms:durations,bytes}));
  console.log(`Volume espacial: ${checks} verificações passaram; nenhum acesso remoto.`);
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
