// PostgreSQL isolado em memória. Nenhuma conexão com o Supabase real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {PGlite} = require(process.env.PGLITE_MODULE_PATH || '@electric-sql/pglite');
const {pgcrypto} = require(path.join(process.env.PGLITE_MODULE_PATH || '@electric-sql/pglite', 'dist/contrib/pgcrypto.cjs'));
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
let checks = 0;
const check = (value, message) => {assert.ok(value, message); checks++;};

(async () => {
  const db = new PGlite({extensions: {pgcrypto}});
  const query = (sql, args = []) => db.query(sql, args);
  const scalar = async (sql, args = []) => Object.values((await query(sql, args)).rows[0])[0];
  const denied = async (sql, args, pattern) => {
    await assert.rejects(query(sql, args), pattern);
    checks++;
  };
  const login = async (id, role = 'authenticated') => {
    await db.exec('reset role');
    await query("select set_config('request.jwt.claim.sub', $1, false)", [id || '']);
    await db.exec(`set role ${role}`);
  };
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  const migrations = path.join(__dirname, '../supabase/migrations');
  for (const file of fs.readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
    console.log(`Migration executada: ${file}`);
  }
  await query('insert into auth.users(id, email) values ($1,$2),($3,$4),($5,$6),($7,$8)',
    [uuid(1), 'owner@test.invalid', uuid(2), 'attendant@test.invalid', uuid(3), 'other@test.invalid', uuid(4), 'inactive@test.invalid']);
  await query('insert into public.guigs_shops(id,name) values ($1,$2),($3,$4)', [uuid(10), 'Guigs teste', uuid(11), 'Outra loja']);
  await query(`insert into public.guigs_memberships(shop_id,user_id,role,active) values
    ($1,$2,'owner',true),($1,$3,'attendant',true),($4,$5,'owner',true),($1,$6,'owner',false)`,
    [uuid(10), uuid(1), uuid(2), uuid(11), uuid(3), uuid(4)]);
  await query('insert into public.guigs_products(id,shop_id,name) values ($1,$2,$3),($4,$5,$6)',
    [uuid(20), uuid(10), 'Coca-Cola 2L', uuid(21), uuid(11), 'Outra bebida']);
  await query(`insert into public.guigs_lots(id,shop_id,product_id,code,expiry,created_at) values
    ($1,$2,$3,'LOTE-A',current_date+35,now()-interval '3 days'),
    ($4,$2,$3,'LOTE-B',current_date+65,now()-interval '2 days'),
    ($5,$2,$3,'EMPATE',current_date+65,now()-interval '4 days'),
    ($6,$2,$3,'ZERO',current_date+20,now()-interval '5 days'),
    ($7,$8,$9,'OUTRA-LOJA',current_date+10,now()-interval '7 days')`,
    [uuid(30),uuid(10),uuid(20),uuid(31),uuid(32),uuid(33),uuid(34),uuid(11),uuid(21)]);
  await query(`insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id)
    values ($1,$2,gen_random_uuid(),'receipt','stock',10,$3),
           ($1,$4,gen_random_uuid(),'receipt','stock',10,$3),
           ($1,$5,gen_random_uuid(),'receipt','stock',2,$3),
           ($6,$7,gen_random_uuid(),'receipt','stock',99,$8)`,
    [uuid(10),uuid(30),uuid(1),uuid(31),uuid(32),uuid(11),uuid(34),uuid(3)]);

  await login(uuid(3));
  const otherSupplier = await scalar('select public.guigs_create_supplier($1,$2)', [uuid(11),'Fornecedor externo']);
  await login(uuid(1));
  check(await scalar('select count(*)::int from public.guigs_suppliers') === 0, 'RLS oculta fornecedor de outra loja');
  const supplier = await scalar('select public.guigs_create_supplier($1,$2)', [uuid(10), 'Distribuidora Guigs']);
  check(!!supplier, 'Owner cadastra fornecedor');
  await denied('select public.guigs_create_supplier($1,$2)', [uuid(10), ' distribuidora guigs '], /Já existe/);
  await denied('select public.guigs_create_supplier($1,$2)', [uuid(11), 'Inválido'], /proprietários/);
  await denied('insert into public.guigs_suppliers(shop_id,name) values ($1,$2)', [uuid(10), 'Direto'], /permission denied/);
  await denied('select public.guigs_create_supplier($1,$2)', [uuid(10), ' '], /inválidos/);
  await denied('select public.guigs_update_supplier($1,$2,$3,$4)', [uuid(10),otherSupplier,'Invasão',true], /não encontrado/);

  await login(uuid(2));
  check(await scalar('select count(*)::int from public.guigs_suppliers') === 1, 'Atendente lê somente sua loja');
  await denied('select public.guigs_create_supplier($1,$2)', [uuid(10), 'Admin'], /proprietários/);
  await denied('select public.guigs_update_supplier($1,$2,$3,$4)', [uuid(10),supplier,'Alterado',false], /proprietários/);
  await denied('update public.guigs_suppliers set active=false where id=$1', [supplier], /permission denied/);
  await denied('select public.guigs_receive_stock($1,$2,$3,current_date+90,$4,$5,$6)',
    [uuid(10),uuid(20),'FORNECEDOR-OUTRA-LOJA',1,'',otherSupplier], /nesta loja/);
  const receipt = await scalar('select public.guigs_receive_stock($1,$2,$3,current_date+90,$4,$5,$6)',
    [uuid(10),uuid(20),'NOVO',7,'nota teste',supplier]);
  check(!!receipt.success, 'Atendente recebe lote com fornecedor');
  check(await scalar('select supplier_id from public.guigs_lots where id=$1', [receipt.lot_id]) === supplier, 'Fornecedor vinculado ao lote');
  check(await scalar('select note from public.guigs_movements where event_id=$1', [receipt.event_id]) === 'Fornecedor: Distribuidora Guigs\nnota teste', 'Snapshot no histórico');
  await scalar('select public.guigs_receive_stock($1,$2,$3,current_date+90,$4,$5)', [uuid(10),uuid(20),'NOVO',1,'cliente antigo']);
  check(await scalar('select supplier_id from public.guigs_lots where id=$1', [receipt.lot_id]) === supplier, 'RPC antiga preserva vínculo');
  check(await scalar('select supplier_id from public.guigs_lots where id=$1', [uuid(30)]) === null, 'Lote antigo continua sem fornecedor');
  const legacy = await scalar('select public.guigs_receive_stock($1,$2,$3,current_date+95,$4)', [uuid(10),uuid(20),'LEGADO',1]);
  check(legacy.success, 'RPC antiga com nota default funciona');

  await login(uuid(1));
  const supplier2 = await scalar('select public.guigs_create_supplier($1,$2)', [uuid(10),'Segundo']);
  const before = await scalar('select count(*)::int from public.guigs_movements');
  await denied('select public.guigs_receive_stock($1,$2,$3,current_date+90,$4,$5,$6)',
    [uuid(10),uuid(20),'NOVO',3,'',supplier2], /outro fornecedor/);
  check(await scalar('select count(*)::int from public.guigs_movements') === before, 'Recebimento conflitante não cria movimento');
  await scalar('select public.guigs_update_supplier($1,$2,$3,$4)', [uuid(10),supplier,'Renomeado',false]);
  check(await scalar('select note from public.guigs_movements where event_id=$1', [receipt.event_id]) === 'Fornecedor: Distribuidora Guigs\nnota teste', 'Renomeação preserva auditoria');
  await denied('select public.guigs_receive_stock($1,$2,$3,current_date+90,$4,$5,$6)',
    [uuid(10),uuid(20),'INATIVO',1,'',supplier], /inativo/);
  await denied('select public.guigs_receive_stock($1,$2,$3,current_date+90,$4,$5,$6)',
    [uuid(10),uuid(20),'ZERO-QTD',null,'',supplier2], /quantidade/);

  await login(uuid(2));
  const candidates = (await query('select * from public.guigs_get_fefo_candidates($1,$2)', [uuid(10),uuid(31)])).rows;
  check(candidates.length === 2 && candidates[0].code === 'LOTE-A' && candidates[1].code === 'EMPATE', 'FEFO por validade e desempate por criação');
  check(Number(candidates[0].stock) === 10, 'Saldo seco real no aviso');
  check((await query('select * from public.guigs_get_fefo_candidates($1,$2)', [uuid(10),uuid(30)])).rows.length === 0, 'Lote prioritário sem alerta');
  await denied('select * from public.guigs_get_fefo_candidates($1,$2)', [uuid(11),uuid(34)], /Acesso negado/);
  await denied('select * from public.guigs_get_fefo_candidates($1,$2)', [uuid(10),uuid(34)], /não encontrado/);
  await scalar('select public.guigs_transfer_stock($1,$2,$3,$4,$5)', [uuid(10),uuid(31),'stock','fridge',5]);
  let balances = (await query('select * from public.guigs_get_lot_balances($1)', [uuid(10)])).rows;
  let b = balances.find(row => row.lot_id === uuid(31));
  check(Number(b.stock) === 5 && Number(b.fridge) === 5, 'Transferência permite ignorar FEFO e conserva saldo');
  await denied('select public.guigs_transfer_stock($1,$2,$3,$4,$5)', [uuid(10),uuid(31),'stock','fridge',6], /Saldo insuficiente/);
  await scalar('select public.guigs_transfer_stock($1,$2,$3,$4,$5)', [uuid(10),uuid(30),'stock','fridge',10]);
  await scalar('select public.guigs_transfer_stock($1,$2,$3,$4,$5)', [uuid(10),uuid(32),'stock','fridge',2]);
  check((await query('select * from public.guigs_get_fefo_candidates($1,$2)', [uuid(10),uuid(31)])).rows.length === 0, 'Prioritários com seco zero não alertam');

  const history = (await query("select * from public.guigs_get_history($1,1,0,$2,'receipt',$3,null,null,'Distribuidora Guigs')", [uuid(10),uuid(20),uuid(2)])).rows;
  check(history.length === 1 && history[0].actor_email === 'attendant@test.invalid', 'Histórico, filtros, busca e responsável preservados');
  check((await query('select * from public.guigs_get_history($1,1,1)', [uuid(10)])).rows.length === 1, 'Paginação server-side');
  await login(uuid(4));
  check(await scalar('select count(*)::int from public.guigs_suppliers') === 0, 'Vínculo inativo sem leitura');
  await denied('select public.guigs_create_supplier($1,$2)', [uuid(10), 'Inativo'], /proprietários/);
  await denied('select * from public.guigs_get_fefo_candidates($1,$2)', [uuid(10),uuid(31)], /Acesso negado/);
  await login(null, 'anon');
  await denied('select * from public.guigs_suppliers', [], /permission denied/);
  await denied('select public.guigs_create_supplier($1,$2)', [uuid(10), 'Anon'], /permission denied/);
  await denied('select * from public.guigs_get_fefo_candidates($1,$2)', [uuid(10),uuid(31)], /permission denied/);
  await db.close();
  console.log(`Banco: ${checks} verificações passaram.`);
})().catch(error => {console.error(error); process.exitCode = 1;});
