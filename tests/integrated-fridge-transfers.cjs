const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
const shop=id(10), product=id(20), lot=id(30), secondLot=id(32);
const first=id(60), second=id(61);
const outbound=(quantity,slot_id,lot_id=lot)=>({direction:'stock-fridge',product_id:product,lot_id,quantity,slot_id});
const inbound=(quantity,sources)=>({direction:'fridge-stock',product_id:product,lot_id:lot,quantity,sources});
const portion=(slot_id,quantity)=>({slot_id,quantity});

(async()=>{
  const db=await createTestDatabase();
  let checks=0;
  const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
  const reject=async (promise,pattern)=>{await assert.rejects(promise,pattern);checks++;};
  const rpc=(role,name,args)=>asUser(db,role,async tx=>(await tx.query(
    'select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') data',args)).rows[0].data);
  const quote=(spec,role='owner',store=shop)=>rpc(role,'guigs_quote_fridge_transfer',[store,spec]);
  const apply=(spec,plan,key,role='owner',store=shop)=>rpc(role,'guigs_apply_fridge_transfer',[store,key,spec,plan,'teste']);
  let key=100;
  const operation=async(spec,role)=>apply(spec,await quote(spec,role),id(key++),role);
  async function invariant() {
    const rows=(await db.query(`
      select lot_id, sum(delta) filter(where location='fridge') as total,
        sum(delta) filter(where location='fridge' and slot_id is null) as unallocated,
        sum(delta) filter(where slot_id is not null) as slots
      from public.guigs_movements group by lot_id
    `)).rows;
    assert.ok(rows.every(r=>Number(r.total)===Number(r.unallocated)+Number(r.slots)));
    checks++;
  }
  const balances=async()=> (await db.query(`
    select (coalesce(sum(delta) filter(where location='stock'),0))::int dry,
      (coalesce(sum(delta) filter(where location='fridge' and slot_id is null),0))::int free,
      (coalesce(sum(delta) filter(where slot_id=$2),0))::int first,
      (coalesce(sum(delta) filter(where slot_id=$3),0))::int as "second"
    from public.guigs_movements where lot_id=$1
  `,[lot,first,second])).rows[0];
  try {
    await db.exec("create schema storage; create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name)); alter table storage.objects enable row level security;");
    const migrations=path.join(__dirname,'../supabase/migrations');
    for(const file of fs.readdirSync(migrations).filter(f=>/^2026.*\.sql$/.test(f)).sort()) {
      await db.exec(fs.readFileSync(path.join(migrations,file),'utf8'));
    }
    await db.exec(`
      delete from public.guigs_movements;
      insert into public.guigs_shops(id,name) values ('${id(11)}','Outra loja');
      insert into public.guigs_lots(id,shop_id,product_id,code,expiry)
        values ('${secondLot}','${shop}','${product}','FEFO anterior',current_date+5),
               ('${id(33)}','${shop}','${product}','Vencido',current_date-1);
      insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id)
        values ('${shop}','${lot}',gen_random_uuid(),'receipt','stock',30,'${id(1)}'),
               ('${shop}','${secondLot}',gen_random_uuid(),'receipt','stock',2,'${id(1)}'),
               ('${shop}','${id(33)}',gen_random_uuid(),'receipt','stock',99,'${id(1)}');
      insert into public.guigs_fridges(id,shop_id,name) values ('${id(40)}','${shop}','Metalfrio'),('${id(41)}','${shop}','Imbera');
      insert into public.guigs_fridge_shelves(id,shop_id,fridge_id,name)
        values ('${id(50)}','${shop}','${id(40)}','Superior'),('${id(51)}','${shop}','${id(41)}','Inferior');
      insert into public.guigs_fridge_slots(id,shop_id,fridge_id,shelf_id,product_id,name,capacity_quantity)
        values ('${first}','${shop}','${id(40)}','${id(50)}','${product}','A',12),
        ('${second}','${shop}','${id(41)}','${id(51)}','${product}','B',12),
        ('${id(62)}','${shop}','${id(41)}','${id(51)}','${product}','Sem capacidade',null),
        ('${id(63)}','${shop}','${id(41)}','${id(51)}','${id(21)}','Outro produto',12);
    `);
    await db.exec(`insert into public.guigs_inventories(id,shop_id,started_by,start_movement_count)
      values('${id(130)}','${shop}','${id(1)}',3);`);
    await reject(quote(outbound(1),'attendant'),/inventário ativo/);
    await db.exec(`update public.guigs_inventories set status='cancelled' where id='${id(130)}';`);
    await operation(outbound(4),'attendant');
    eq(await balances(),{dry:26,free:4,first:0,second:0}); await invariant();
    await operation(inbound(2,[portion(null,2)]));
    eq(await balances(),{dry:28,free:2,first:0,second:0}); await invariant();
    const positioned=outbound(10,first), plan=await quote(positioned);
    const firstResult=await apply(positioned,plan,id(110));
    eq(await apply(positioned,plan,id(110)),firstResult);
    await reject(apply({...positioned,quantity:9},plan,id(110)),/Identificador já utilizado/);
    eq(await balances(),{dry:18,free:2,first:10,second:0}); await invariant();
    const map=await rpc('owner','guigs_get_fridge_map',[shop]);
    eq(map.slots.find(s=>s.id===first).quantity,10);
    const history=await rpc('owner','guigs_get_spatial_history',[shop,25,0,null,null,null,null,null,null,null]);
    const historyEvent=history.find(item=>item.event_id===firstResult.event_id);
    eq(historyEvent.delta,10);
    eq(historyEvent.parts.map(p=>[p.label,p.delta]),[['Estoque seco',-10],['Metalfrio / Superior / A',10]]);
    await operation(outbound(4,second));
    await operation(inbound(1,[portion(first,1)]),'attendant'); await invariant();
    await operation(inbound(4,[portion(first,2),portion(second,2)])); await invariant();
    await operation(inbound(4,[portion(null,2),portion(first,2)]),'attendant');
    eq(await balances(),{dry:23,free:0,first:5,second:2}); await invariant();
    await reject(quote(outbound(1,id(62))),/capacidade configurada/);
    await reject(quote(outbound(1,id(63))),/associado ao produto/);
    await reject(quote(outbound(8,first)),/Espaço insuficiente/);
    await reject(quote(outbound(24)),/Saldo seco/);
    await reject(quote(outbound(1,first,id(33))),/vencidos/);
    await reject(quote(outbound(1),'attendant',id(11)),/Acesso negado/);
    await reject(apply(positioned,plan,id(111),'attendant',id(11)),/Acesso negado/);
    await reject(quote(inbound(2,[portion(second,1),portion(second,1)])),/sem repetir/);
    await reject(quote(inbound(2,[portion(second,1)])),/soma das origens/);
    await reject(quote(inbound(3,[portion(first,1),portion(second,3)])),/Saldo insuficiente/);
    eq(await balances(),{dry:23,free:0,first:5,second:2}); await invariant();
    const interrupted=inbound(2,[portion(first,1),portion(second,1)]);
    const interruptedPlan=await quote(interrupted);
    await db.exec(`create function public.test_reject_transfer_credit() returns trigger language plpgsql as $$
      begin if new.spatial and new.movement_type='return' and new.delta>0 then
        raise exception 'Falha artificial no crédito'; end if; return new; end $$;
      create trigger test_reject_transfer_credit before insert on public.guigs_movements
      for each row execute function public.test_reject_transfer_credit();`);
    await reject(apply(interrupted,interruptedPlan,id(113)),/Falha artificial no crédito/);
    eq(await balances(),{dry:23,free:0,first:5,second:2}); await invariant();
    eq((await db.query('select count(*)::int n from guigs_private.spatial_commands where request_id=$1',[id(113)])).rows[0].n,0);
    await db.exec('drop trigger test_reject_transfer_credit on public.guigs_movements');
    const fefo=await operation(outbound(3,first,null));
    eq(fefo.plan.map(p=>[p.lot_id,p.quantity]),[[secondLot,2],[lot,1]]); await invariant();
    const stale=outbound(4,first), stalePlan=await quote(stale);
    await operation(outbound(2,first),'attendant');
    await reject(apply(stale,stalePlan,id(112)),/Espaço insuficiente/); await invariant();
    await reject(rpc('owner','guigs_transfer_stock',[shop,lot,'fridge','stock',1,'teste']),/posição física/);
    const inv=await rpc('owner','guigs_create_spatial_inventory',[shop,'teste']);
    assert.ok(inv);checks++;
    await reject(quote(outbound(1)),/inventário ativo/); await invariant();
    const now=Date.now(), day=86400000;
    const report=await rpc('owner','guigs_get_reports',[shop,new Date(now-day).toISOString(),new Date(now+day).toISOString(),50,0,0]);
    eq(report.summary.transfer_operations,9);
    eq(report.summary.transfer_units,34);
    await db.query('delete from public.guigs_movements where event_id=$1',[firstResult.event_id]);
    await reject(apply(positioned,plan,id(110)),/ciclo anterior/);
    console.log('Transferências integradas: '+checks+' verificações passaram em PostgreSQL isolado.');
  }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
