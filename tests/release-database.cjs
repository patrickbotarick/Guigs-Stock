// Instalação completa e upgrade com dados artificiais preexistentes; só PGlite.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
let checks=0;const check=(v,m)=>{assert.ok(v,m);checks++;};
const sql=n=>fs.readFileSync(path.join(__dirname,'../supabase/migrations',n===7?'007_physical_inventory.sql':'008_reporting.sql'),'utf8');
const legacy=['guigs_shops','guigs_memberships','guigs_products','guigs_lots','guigs_movements','guigs_suppliers'];
async function fingerprint(db){
 const data={};for(const table of legacy)data[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') as rows from public.${table} t`)).rows[0].rows;
 const functions=(await db.query(`select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as args,pg_get_functiondef(p.oid) as definition,p.proacl::text as acl
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','guigs_private') and p.proname like 'guigs_%' or n.nspname='guigs_private' order by n.nspname,p.proname,args`)).rows;
 return {data,functions};
}
async function legacyContract(db){
 return asUser(db,'owner',async tx=>{
  const scalar=async(s,a)=>(await tx.query(s,a)).rows[0].data;
  const p=[id(10),id(20),'L3-2103'];
  check((await scalar("select public.guigs_receive_stock($1,$2,$3,current_date+60,1,'Contrato antigo') as data",p)).success,'Recebimento 6 args');
  check((await scalar("select public.guigs_receive_stock($1,$2,$3,current_date+60,1,'Contrato atual',null::uuid) as data",p)).success,'Recebimento 7 args');
  await tx.query("select public.guigs_transfer_stock($1,$2,'stock','fridge',1,'Contrato legado')",[id(10),id(30)]);checks++;
  await tx.query("select public.guigs_register_sale($1,$2,1,'Contrato legado')",[id(10),id(30)]);checks++;
  await tx.query("select public.guigs_register_loss($1,$2,'stock',1,'Contrato legado')",[id(10),id(30)]);checks++;
  await tx.query("select public.guigs_adjust_stock($1,$2,'stock',10,'Contrato legado')",[id(10),id(30)]);checks++;
  check((await tx.query('select * from public.guigs_get_history($1,20,0)',[id(10)])).rows.length>0,'Histórico antigo');
  check((await tx.query('select * from public.guigs_get_lot_balances($1)',[id(10)])).rows.length===2,'Saldo antigo');
  await tx.query('select * from public.guigs_get_history_actors($1)',[id(10)]);checks++;
  await tx.query('select * from public.guigs_get_fefo_candidates($1,$2)',[id(10),id(30)]);checks++;
 });
}
async function verify(db){
 const tables=(await db.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r' and relname like 'guigs_%' order by relname")).rows;
 check(tables.length===9&&tables.every(t=>t.relrowsecurity),'Nove tabelas com RLS habilitada');
 const functions=(await db.query("select proname,prosecdef,proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (proname like '%inventory%' or proname='guigs_list_inventories' or proname='guigs_get_reports')")).rows;
 check(functions.length===9,'Nove novas RPCs disponíveis');
 for(const f of functions)check(f.prosecdef&&f.proconfig.some(v=>/^search_path=(?:""|)$/.test(v)),`${f.proname} com search_path vazio`);
 for(const table of ['guigs_inventories','guigs_inventory_items','guigs_inventory_audit']){
  const grants=(await db.query("select has_table_privilege('authenticated',$1,'SELECT') as read,has_table_privilege('authenticated',$1,'INSERT,UPDATE,DELETE') as write",['public.'+table])).rows[0];
  check(grants.read&&!grants.write,'Somente SELECT concedido em '+table);
 }
 const constraints=(await db.query("select contype from pg_constraint where conrelid in ('public.guigs_inventory_items'::regclass,'public.guigs_inventory_audit'::regclass)")).rows;
 check(constraints.filter(c=>c.contype==='f').length===7,'FKs de loja, item, lote e autor');
 const indexes=(await db.query("select indexname from pg_indexes where schemaname='public'")).rows.map(r=>r.indexname);
 for(const name of ['guigs_inventory_one_active','guigs_inventory_items_shop','guigs_inventory_audit_shop','guigs_inventories_shop_date','guigs_movements_shop_created_idx'])check(indexes.includes(name),'Índice '+name);
 await asUser(db,'attendant',async tx=>{await assert.rejects(tx.query('select public.guigs_get_reports($1,now()-interval \'1 day\',now())',[id(10)]),/proprietário/);checks++;});
 const owner=await asUser(db,'owner',async tx=>(await tx.query('select public.guigs_get_reports($1,now()-interval \'1 day\',now()+interval \'1 day\') as data',[id(10)])).rows[0].data);
 check(owner.summary.receipt_units>0,'Relatório funciona após upgrade');
 await legacyContract(db);
}
(async()=>{
 let db=await createTestDatabase();try{await verify(db);console.log('Instalação 001–008: aprovada.');}finally{await db.close();}
 db=await createTestDatabase({through:6});try{
  const original=await fingerprint(db);let baseline=original;
  for(const number of [7,8]){
   await db.exec(sql(number));const after=await fingerprint(db);
   assert.deepEqual(after.data,baseline.data);checks++;
   for(const f of original.functions){assert.deepEqual(after.functions.find(a=>a.proname===f.proname&&a.args===f.args&&a.nspname===f.nspname),f);checks++;}
   await legacyContract(db);baseline=await fingerprint(db);
  }
  await verify(db);
  const schemaBefore=(await db.query("select count(*)::int as n from pg_class where relnamespace='public'::regnamespace")).rows[0].n;
  await assert.rejects(db.exec(sql(7)),/already exists/);checks++;await db.exec('rollback');
  check((await db.query("select count(*)::int as n from pg_class where relnamespace='public'::regnamespace")).rows[0].n===schemaBefore,'Reexecução não idempotente falha sem schema parcial');
  console.log('Upgrade 006 → 007 → 008: dados/contratos anteriores preservados.');
 }finally{await db.close();}
 db=await createTestDatabase({through:6});try{
  await assert.rejects(db.exec(sql(7).replace(/commit;\s*$/,'select public.falha_artificial_rollback(); commit;')),/does not exist/);checks++;
  await db.exec('rollback');check((await db.query("select to_regclass('public.guigs_inventories') as table_name")).rows[0].table_name===null,'Falha antes do COMMIT reverte toda a 007');
  await assert.rejects(db.exec(sql(8)),/007/);checks++;await db.exec('rollback');
  await db.exec(sql(7));
  await assert.rejects(db.exec(sql(8).replace(/commit;\s*$/,'select public.falha_artificial_rollback(); commit;')),/does not exist/);checks++;
  await db.exec('rollback');check((await db.query("select count(*)::int as n from pg_proc where proname='guigs_get_reports'")).rows[0].n===0,'Falha antes do COMMIT reverte toda a 008');
 }finally{await db.close();}
 db=await createTestDatabase({through:5});try{
  await assert.rejects(db.exec(sql(7)),/006/);checks++;await db.exec('rollback');
  check((await db.query("select to_regclass('public.guigs_inventories') as table_name")).rows[0].table_name===null,'007 sem 006 não deixa objetos parciais');
 }finally{await db.close();}
 console.log(`Release banco: ${checks} verificações passaram.`);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
