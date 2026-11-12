// Integração descartável: PostgreSQL + GoTrue + PostgREST nativos, só em loopback.
// Não lê config.js, .env, credenciais externas nem configurações do Postgres do operador.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {execFileSync, spawn} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');

const repo = path.resolve(__dirname, '..');
const migrations = path.join(repo, 'supabase', 'migrations');
const stages = [
  '20261111164204_integrated_fridge_transfers.sql',
  '20261111173911_blind_grouped_inventory.sql',
  '20261111181130_smart_shopping_list.sql',
  '20261111183754_fridge_slot_moves_history.sql'
];
const evidence = {checks: [], migrations: [], upgradeStages: [], snapshots: [], status: 'FAIL'};
const ok = (name, value) => { assert.ok(value, name); evidence.checks.push(name); };
const eq = (name, actual, expected) => { assert.deepEqual(actual, expected, name); evidence.checks.push(name); };
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const id = () => crypto.randomUUID();
const literal = x => "'" + String(x).replaceAll("'", "''") + "'";
const sqlValue = x => x === null ? 'null' : typeof x === 'object' ? `${literal(JSON.stringify(x))}::jsonb` : literal(x);
const exe = process.platform === 'win32' ? '.exe' : '';
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|ComSpec|NUMBER_OF_PROCESSORS|LANG|LC_ALL)$/i.test(k)));

async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const number = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return number;
}

function externalDirectory() {
  const requested = process.env.GUIGS_ROUND1_WORK;
  assert.ok(requested && path.isAbsolute(requested), 'Defina GUIGS_ROUND1_WORK como pasta externa absoluta e existente.');
  const real = fs.realpathSync(requested);
  for (let p = real;; p = path.dirname(p)) {
    assert.ok(!fs.existsSync(path.join(p, '.git')), 'Diretório de evidência deve estar fora de qualquer Git.');
    if (p === path.dirname(p)) break;
  }
  return fs.mkdtempSync(path.join(real, 'integration-'));
}

async function run() {
  const pgBin = process.env.GUIGS_TEST_PG_BIN;
  const authBin = process.env.GUIGS_TEST_AUTH_EXE;
  const restBin = process.env.GUIGS_TEST_POSTGREST_EXE;
  assert.ok([pgBin, authBin, restBin].every(x => x && path.isAbsolute(x)), 'Indique os binários locais por caminho absoluto.');
  const root = externalDirectory();
  const pg = name => path.join(pgBin, name + exe);
  const pgPort = await port(), authPort = await port(), restPort = await port();
  assert.equal(new Set([pgPort, authPort, restPort]).size, 3, 'Portas locais devem ser distintas; repita o teste.');
  const auth = `http://127.0.0.1:${authPort}`, rest = `http://127.0.0.1:${restPort}`;
  const cluster = path.join(root, 'cluster');
  const pgUri = user => `postgresql://${user}@127.0.0.1:${pgPort}/postgres?sslmode=disable`;
  const env = {...safeEnv, PATH: `${pgBin}${path.delimiter}${safeEnv.PATH || safeEnv.Path || ''}`};
  const pgArgs = ['-X','-qAt','-w','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(pgPort),'-U','guigs_test','-d','postgres'];
  const opts = {cwd:root,env,encoding:'utf8',windowsHide:true,timeout:30000};
  const sql = (input, args=[]) => execFileSync(pg('psql'), [...pgArgs,...args], {...opts,input}).trim();
  const jsonSql = input => JSON.parse(sql(input));
  const ctl = args => execFileSync(pg('pg_ctl'), ['-D',cluster,'-w','-t','20',...args], {...opts,stdio:'ignore'});
  const children = [];
  let running = false;
  const serve = (file, name, args, settings) => {
    const log = fs.openSync(path.join(root, `${name}.log`), 'wx');
    try {
      const child = spawn(file, args, {...opts,env:{...env,...settings},stdio:['ignore',log,log]});
      child.on('error', e => { child.launchError = e; });
      children.push(child);
      return child;
    } finally { fs.closeSync(log); }
  };
  async function ready(url, child) {
    for (let i=0;i<100;i++) {
      if (child.launchError || child.exitCode !== null || child.signalCode !== null) {
        throw Error(`Serviço local encerrou (${child.launchError?.code || child.exitCode || child.signalCode}); confira ${root}.`);
      }
      const r = await fetch(url, {signal:AbortSignal.timeout(1000),redirect:'error'}).catch(()=>null);
      if (r?.ok) return;
      await delay(200);
    }
    throw Error(`Serviço local não ficou pronto; confira ${root}.`);
  }
  async function request(base, url, body, token, method = body === undefined ? 'GET' : 'POST') {
    const target = new URL(url, base);
    assert.ok(target.origin === base && target.hostname === '127.0.0.1');
    const response = await fetch(target, {method,redirect:'error',signal:AbortSignal.timeout(12000),
      headers:{'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {})},
      ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const data = await response.json().catch(()=>null);
    return {ok:response.ok, status:response.status, data};
  }
  const success = async (promise, label) => {
    const r = await promise;
    if (!r.ok) throw Error(`${label}: HTTP ${r.status}: ${r.data?.message || r.data?.msg || r.data?.error_code || 'erro'}`);
    return r.data;
  };
  const blocked = async (name,promise) => ok(name, !(await promise).ok);
  const rpcResponse = (actor,name,args) => request(rest, `/rpc/${name}`, args, actor?.token);
  const rpc = (actor,name,args) => success(rpcResponse(actor,name,args),name);
  const twoSessions = (actor, name, params) => new Promise((resolve,reject) => {
    assert.match(name,/^guigs_[a-z_]+$/);
    assert.ok(Object.keys(params).every(key=>/^p_[a-z_]+$/.test(key)));
    const named = Object.entries(params).map(([k,v])=>`${k} => ${sqlValue(v)}`).join(',');
    const child = spawn(pg('psql'), pgArgs, {...opts,stdio:['pipe','pipe','pipe']});
    let out='',error='';
    child.stdout.on('data', x=>out+=x);
    child.stderr.on('data', x=>error+=x);
    child.on('error', reject);
    child.on('close', code=>resolve({ok:code===0, data:out.trim(), error:error.trim()}));
    child.stdin.end(`begin; set local statement_timeout='8s'; set local role authenticated;
      set local request.jwt.claims=${literal(JSON.stringify({sub:actor.user,role:'authenticated'}))};
      select public.${name}(${named}); commit;`);
  });
  async function race(label, name, first, second, actors, winners = 1) {
    const results = await Promise.all([twoSessions(actors[0],name,first),twoSessions(actors[1],name,second)]);
    eq(label,results.filter(x=>x.ok).length,winners);
    return results;
  }
  try {
    evidence.tools={postgres:execFileSync(pg('postgres'),['--version'],opts).trim(),postgrest:execFileSync(restBin,['--version'],opts).trim()};
    // Sem flush inicial apenas neste cluster temporário; o servidor mantém fsync padrão.
    execFileSync(pg('initdb'),['-D',cluster,'-U','guigs_test','-A','trust','--locale=C','-E','UTF8','--no-sync'],opts);
    ctl(['-l',path.join(root,'postgres.log'),'-o',`-h 127.0.0.1 -p ${pgPort}`,'start']); running=true;
    sql(`create role postgres nologin; create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create role authenticator login noinherit; grant anon,authenticated to authenticator;
      create schema auth; create schema storage;
      create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));
      alter table storage.objects enable row level security;
      grant usage on schema auth,storage to anon,authenticated;
      grant select on storage.objects to authenticated;`);
    const jwt = crypto.randomBytes(48).toString('hex');
    const authProcess=serve(authBin,'auth',[],{
      API_EXTERNAL_URL:auth,GOTRUE_SITE_URL:auth,GOTRUE_API_HOST:'127.0.0.1',GOTRUE_API_PORT:String(authPort),
      GOTRUE_DB_DRIVER:'postgres',GOTRUE_DB_DATABASE_URL:pgUri('guigs_test')+'&search_path=auth,public',GOTRUE_DB_NAMESPACE:'auth',
      GOTRUE_JWT_SECRET:jwt,GOTRUE_JWT_DEFAULT_GROUP_NAME:'authenticated',GOTRUE_JWT_AUD:'authenticated',
      GOTRUE_EXTERNAL_EMAIL_ENABLED:'true',GOTRUE_MAILER_AUTOCONFIRM:'true',GOTRUE_DISABLE_SIGNUP:'false',
      GOTRUE_RATE_LIMIT_EMAIL_SENT:'100',GOTRUE_RATE_LIMIT_TOKEN_REFRESH:'1000',GOTRUE_DB_MAX_POOL_SIZE:'5'});
    await ready(auth+'/health',authProcess);
    const health = await success(request(auth,'/health'),'Health Auth');
    evidence.tools.auth = health.version || health.name || 'GoTrue';
    ok('GoTrue real respondeu em loopback', !!health);
    sql(`create or replace function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
        nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
      grant execute on function auth.uid() to anon,authenticated;`);
    const all = fs.readdirSync(migrations).filter(x=>x.endsWith('.sql')).sort();
    eq('Ordem final de aplicação A, B, C e D',all.slice(-4),stages);
    eq('Último pré-requisito do baseline',all.at(-5),'20261111130126_nullable_stock_thresholds.sql');
    const applyMigration = file => {
      const input = path.join(migrations,file);
      sql('', ['-f',input]);
      const digest = sha(fs.readFileSync(input));
      evidence.migrations.push({file,sha256:digest});
      return digest;
    };
    for (const file of all.slice(0,-4)) applyMigration(file);

    // Estoque anterior à atualização: outra loja artificial, com as três partições ocupadas.
    const upgradeOwner=(await success(request(auth,'/signup',{
      email:'upgrade-owner@example.com',password:`Teste!${id()}`
    }),'Cadastro artificial para o upgrade')).user.id;
    const oldShop=id(), oldProduct=id(), oldLot=id(), oldFridge=id(), oldShelf=id(), oldSlot=id();
    sql(`insert into public.guigs_shops(id,name) values ('${oldShop}','Baseline v16 artificial');
      insert into public.guigs_memberships(shop_id,user_id,role) values ('${oldShop}','${upgradeOwner}','owner');
      insert into public.guigs_products(id,shop_id,name) values ('${oldProduct}','${oldShop}','Produto anterior');
      insert into public.guigs_lots(id,shop_id,product_id,code,expiry)
        values ('${oldLot}','${oldShop}','${oldProduct}','BASELINE',current_date+30);
      insert into public.guigs_fridges(id,shop_id,name) values ('${oldFridge}','${oldShop}','Geladeira anterior');
      insert into public.guigs_fridge_shelves(id,shop_id,fridge_id,name)
        values ('${oldShelf}','${oldShop}','${oldFridge}','Prateleira anterior');
      insert into public.guigs_fridge_slots(id,shop_id,fridge_id,shelf_id,product_id,name,capacity_quantity)
        values ('${oldSlot}','${oldShop}','${oldFridge}','${oldShelf}','${oldProduct}','Bloco anterior',20);
      insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,slot_id,spatial)
        values ('${oldShop}','${oldLot}',gen_random_uuid(),'receipt','stock',10,'${upgradeOwner}',null,false),
          ('${oldShop}','${oldLot}',gen_random_uuid(),'receipt','fridge',4,'${upgradeOwner}',null,false),
          ('${oldShop}','${oldLot}',gen_random_uuid(),'receipt','fridge',6,'${upgradeOwner}','${oldSlot}',true);`);
    const baselineTables=['guigs_products','guigs_lots','guigs_movements','guigs_memberships',
      'guigs_fridges','guigs_fridge_shelves','guigs_fridge_slots'];
    const fingerprint = () => sha(sql(`select ${baselineTables.map(table=>
      `(select jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text from public.${table} t where shop_id='${oldShop}')`
    ).join(" || E'\\n' || ")};`));
    const legacyReads = () => jsonSql(`begin; set local role authenticated;
      set local request.jwt.claims=${literal(JSON.stringify({sub:upgradeOwner,role:'authenticated'}))};
      select jsonb_build_object('balances',(select to_jsonb(b) from public.guigs_get_lot_balances('${oldShop}') b where lot_id='${oldLot}'),
        'history',(select count(*) from public.guigs_get_history('${oldShop}',20,0)),
        'mapSlots',jsonb_array_length(public.guigs_get_fridge_map('${oldShop}')->'slots')); commit;`);
    const original=fingerprint(), legacy=legacyReads();
    eq('Baseline anterior ao upgrade: estoque, histórico e mapa existentes',
      [Number(legacy.balances.stock),Number(legacy.balances.fridge),legacy.history,legacy.mapSlots],[10,10,3,1]);
    const contracts=[
      ['guigs_quote_fridge_transfer(uuid,jsonb)','guigs_apply_fridge_transfer(uuid,uuid,jsonb,jsonb,text)'],
      ['guigs_get_inventory(uuid,uuid)','guigs_get_spatial_inventory(uuid,uuid)','guigs_list_inventories(uuid,integer,integer)'],
      ['guigs_shopping_needs(uuid)','guigs_get_shopping_board(uuid,integer,integer)','guigs_get_purchase_order(uuid,uuid)',
        'guigs_apply_shopping_command(uuid,uuid,text,jsonb)'],
      ['guigs_get_fridge_slot_history(uuid,uuid,integer,timestamptz,uuid)','guigs_quote_fridge_slot_move(uuid,uuid,uuid,uuid,integer)',
        'guigs_apply_fridge_slot_move(uuid,uuid,uuid,uuid,uuid,integer,jsonb)']
    ];
    for (const [index,file] of stages.entries()) {
      const label='ABCD'[index], sha256=applyMigration(file), after=fingerprint();
      eq(`${label}: dados anteriores preservados`,after,original);
      eq(`${label}: cliente v16 conserva leituras de estoque, histórico e mapa`,legacyReads(),legacy);
      const signatures=contracts[index].map(signature=>`(${literal('public.'+signature)})`).join(',');
      eq(`${label}: RPCs presentes, authenticated autorizado e anon recusado`,sql(`select bool_and(
        coalesce(has_function_privilege('authenticated',to_regprocedure(signature),'EXECUTE'),false)
        and not coalesce(has_function_privilege('anon',to_regprocedure(signature),'EXECUTE'),true)) from (values ${signatures}) s(signature);`),'t');
      if (label==='B') eq('B: leitura direta de contagem/auditoria retirada dos papéis de API',sql(`select not exists (
        select from (values ('authenticated'),('anon')) a(role), (values ('public.guigs_inventory_items'),('public.guigs_inventory_audit')) t(tbl)
        where has_table_privilege(role,tbl,'SELECT'));`),'t');
      if (label==='C') {
        eq('C: RLS ativa e sem INSERT/UPDATE/DELETE direto nas tabelas de compras',sql(`select count(*)=4 and bool_and(relrowsecurity and
          not has_table_privilege('authenticated',oid,'INSERT,UPDATE,DELETE') and not has_table_privilege('anon',oid,'SELECT'))
          from pg_class where oid in ('public.guigs_purchase_orders'::regclass,'public.guigs_purchase_items'::regclass,
          'public.guigs_purchase_events'::regclass,'guigs_private.purchase_commands'::regclass);`),'t');
        eq('C: FKs e constraints das tabelas de compras validadas',sql(`select count(*) filter(where contype='f')>=8 and
          count(*) filter(where contype='c')>=3 and bool_and(convalidated) from pg_constraint where conrelid in
          ('public.guigs_purchase_orders'::regclass,'public.guigs_purchase_items'::regclass,'public.guigs_purchase_events'::regclass);`),'t');
      }
      if (label==='D') eq('D: três índices de histórico válidos',sql(`select count(*)=3 and bool_and(indisvalid) from pg_index
        where indexrelid in ('public.guigs_movements_slot_history_idx'::regclass,'public.guigs_inventory_items_adjustment_idx'::regclass,
        'guigs_private.guigs_spatial_commands_replenish_event_idx'::regclass);`),'t');
      evidence.upgradeStages.push({stage:label,file,sha256,baselinePreserved:after===original,legacyReadContracts:'PASS'});
    }
    const restProcess=serve(restBin,'postgrest',[],{
      PGRST_DB_URI:pgUri('authenticator'),PGRST_DB_ANON_ROLE:'anon',PGRST_DB_SCHEMAS:'public',
      GHCRTS:'-N1',PGRST_DB_CHANNEL_ENABLED:'false',PGRST_DB_POOL:'2',PGRST_DB_CONFIG:'false',
      PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:String(restPort),
      PGRST_JWT_SECRET:jwt});
    await ready(rest+'/',restProcess);
    ok('PostgREST real carregou o catálogo de migrations',true);
    async function login(role) {
      const email=`${role}@example.com`, password=`Teste!${id()}`;
      await success(request(auth,'/signup',{email,password}),'Cadastro de teste');
      await blocked(`Auth real: senha errada negada (${role})`,request(auth,'/token?grant_type=password',{email,password:`Inválida!${id()}`}));
      const login = await success(request(auth,'/token?grant_type=password',{email,password}),'Login de teste');
      const result = await success(request(auth,'/user',undefined,login.access_token),'Validação JWT no Auth');
      eq(`Auth real: sessão ${role}`,result.id,login.user.id);
      return {user:result.id,token:login.access_token};
    }
    const owner=await login('owner'), attendant=await login('attendant'), outsider=await login('external');
    const shop=id(), foreignShop=id(), product=id(), supplier=id(), fridge1=id(), fridge2=id(), shelf1=id(), shelf2=id();
    const a=id(), b=id(), c=id(), small=id();
    sql(`insert into public.guigs_shops(id,name) values ('${shop}','Loja artificial'),('${foreignShop}','Loja externa');
      insert into public.guigs_memberships(shop_id,user_id,role) values
        ('${shop}','${owner.user}','owner'),('${shop}','${attendant.user}','attendant'),('${foreignShop}','${outsider.user}','owner');
      insert into public.guigs_products(id,shop_id,name,min_total,target_total,min_fridge,target_fridge)
        values('${product}','${shop}','Bebida artificial',null,null,null,null);
      insert into public.guigs_fridges(id,shop_id,name) values('${fridge1}','${shop}','Fridge A'),('${fridge2}','${shop}','Fridge B');
      insert into public.guigs_fridge_shelves(id,shop_id,fridge_id,name) values
        ('${shelf1}','${shop}','${fridge1}','Prateleira A'),('${shelf2}','${shop}','${fridge2}','Prateleira B');
      insert into public.guigs_fridge_slots(id,shop_id,fridge_id,shelf_id,product_id,name,min_quantity,target_quantity,capacity_quantity,x_ratio,width_ratio) values
        ('${a}','${shop}','${fridge1}','${shelf1}','${product}','Bloco A',2,8,40,0,.4),
        ('${b}','${shop}','${fridge1}','${shelf1}','${product}','Bloco B',2,8,40,.5,.4),
        ('${c}','${shop}','${fridge2}','${shelf2}','${product}','Bloco C',2,8,40,0,.4),
        ('${small}','${shop}','${fridge2}','${shelf2}','${product}','Pequeno',null,null,null,.5,.4);
      insert into public.guigs_suppliers(id,shop_id,name) values('${supplier}','${shop}','Fornecedor artificial');`);
    const scoped = {p_shop_id:shop};
    const shopping = (actor=owner) => rpc(actor,'guigs_get_shopping_board',scoped);
    const need = async () => (await shopping()).needs.find(x=>x.product_id===product);
    const initial = await need();
    eq('Saldo inicial zero e parâmetros NULL',[initial.available,initial.suggested],[0,null]);
    const currentMap = await rpc(attendant,'guigs_get_fridge_map',scoped);
    eq('Bloco inicialmente sem parâmetros',currentMap.slots.find(x=>x.id===small).capacity_quantity,null);
    await blocked('Anon não executa RPC de compras',rpcResponse(null,'guigs_get_shopping_board',scoped));
    await blocked('PostgREST rejeita JWT forjado',request(rest,'/guigs_products',undefined,'token-invalido'));
    await blocked('RLS de RPC isola outra loja',rpcResponse(outsider,'guigs_get_shopping_board',scoped));
    eq('RLS da tabela isola outra loja',await success(request(rest,`/guigs_products?id=eq.${product}`,undefined,outsider.token),'RLS produto'),[]);
    await blocked('RLS e grants proíbem INSERT direto',request(rest,'/guigs_products',{shop_id:shop,name:'Proibido'},attendant.token));
    const capabilities = await rpc(attendant,'guigs_get_fridge_map',scoped);
    ok('Attendant pode ler o mapa',capabilities.slots.some(x=>x.id===a));
    const commandArgs = (action,payload,key=id()) => ({...scoped,p_action:action,p_payload:payload,p_request_id:key});
    const limits = commandArgs('limits',{product_id:product,min_total:60,target_total:80,expected:{min_total:null,target_total:null}});
    await blocked('Attendant não muda parâmetros administrativos',rpcResponse(attendant,'guigs_apply_shopping_command',limits));
    eq('Owner configura mínimo de compra',(await rpc(owner,'guigs_apply_shopping_command',limits)).min_total,60);
    const layout = {...scoped,p_kind:'slot',p_id:small,p_revision:currentMap.slots.find(x=>x.id===small).revision,
      p_values:{name:'Pequeno',fridge_id:fridge2,shelf_id:shelf2,product_id:product,
        min_quantity:1,target_quantity:2,capacity_quantity:2,x_ratio:.5,width_ratio:.4}};
    await blocked('Attendant sem capability não altera blocos',rpcResponse(attendant,'guigs_save_fridge_layout',layout));
    eq('Owner configura parâmetros do bloco',(await rpc(owner,'guigs_save_fridge_layout',layout)).capacity_quantity,2);
    const receive = (code,quantity,days) => rpc(attendant,'guigs_receive_stock',{
      ...scoped,p_product_id:product,p_lot_code:code,p_expiry:new Date(Date.now()+days*86400000).toISOString().slice(0,10),
      p_quantity:quantity,p_note:'Round 1 artificial',p_supplier_id:supplier});
    const lot=(await receive('RODADA-A',30,60)).lot_id, early=(await receive('RODADA-B',2,7)).lot_id;
    const quote = (spec,actor=owner)=>rpc(actor,'guigs_quote_fridge_transfer',{...scoped,p_spec:spec});
    const transferArgs=(spec,plan,key=id())=>({...scoped,p_request_id:key,p_spec:spec,p_expected:plan,p_note:'Rodada 1'});
    const transfer = async(spec,actor=attendant)=>rpc(actor,'guigs_apply_fridge_transfer',transferArgs(spec,await quote(spec,actor)));
    const out=(quantity,slot_id=null,lot_id=lot)=>({direction:'stock-fridge',product_id:product,lot_id,quantity,slot_id});
    const from=(quantity,sources)=>({direction:'fridge-stock',product_id:product,lot_id:lot,quantity,sources});
    const relocateArgs=(source,destination,quantity)=>({...scoped,p_source:source,p_destination:destination,p_lot:lot,p_quantity:quantity});
    const moveArgs=async(source,destination,quantity)=>{const p=relocateArgs(source,destination,quantity);
      return {...p,p_request_id:id(),p_expected:await rpc(owner,'guigs_quote_fridge_slot_move',p)};};
    const move=(source,destination,quantity)=>moveArgs(source,destination,quantity).then(p=>rpc(attendant,'guigs_apply_fridge_slot_move',p));
    const snapshot = (label) => {
      const rows=jsonSql(`select coalesce(jsonb_agg(to_jsonb(x) order by x.lot_id),'[]') from (
        select lot_id,coalesce(sum(delta) filter(where location='stock'),0)::int dry,
        coalesce(sum(delta) filter(where location='fridge' and slot_id is null),0)::int free,
        coalesce(sum(delta) filter(where slot_id is not null),0)::int slots,
        coalesce(sum(delta) filter(where location='fridge'),0)::int fridge,sum(delta)::int total
        from public.guigs_movements where shop_id='${shop}' group by lot_id) x;`);
      ok(`${label}: invariante global de geladeira`, rows.every(r=>r.fridge===r.free+r.slots && r.total===r.dry+r.fridge));
      eq(`${label}: nenhuma partição negativa`,sql(`select count(*) from (select sum(delta) from public.guigs_movements
        where shop_id='${shop}' group by lot_id,location,slot_id having sum(delta)<0)x;`),'0');
      evidence.snapshots.push({label,rows});return rows;
    };
    const mark = (label,event,legs) => eq(label,jsonSql(`select jsonb_build_array(count(*),sum(delta)) from public.guigs_movements where event_id='${event.event_id}'`),[legs,0]);
    const ledger = () => sql(`select md5(coalesce(string_agg(to_jsonb(m)::text,',' order by id),'')) from public.guigs_movements m where shop_id='${shop}'`);
    snapshot('Recebimento físico');
    const fefo=await transfer(out(3,null,null));
    eq('FEFO: lote de validade menor antes do lote principal',fefo.plan.map(x=>[x.lot_id,x.quantity]),[[early,2],[lot,1]]);
    mark('FEFO: duas pernas por lote',fefo,4);
    mark('Transferência seco → não alocado',await transfer(out(4)),2);
    mark('Transferência seco → bloco',await transfer(out(8,a)),2);
    const before=snapshot('Antes de realocar');
    mark('Entre blocos da mesma geladeira',await move(a,b,3),2);
    const cross=await move(b,c,2); mark('Entre geladeiras',cross,2);
    eq('Realocação conserva cada lote e todos os totais',snapshot('Depois de realocar'),before);
    const origins=[{slot_id:null,quantity:1},{slot_id:a,quantity:1},{slot_id:c,quantity:1}];
    mark('Retorno múltiplo: três origens e três créditos',await transfer(from(3,origins)),6);
    snapshot('Depois do retorno');

    const dryRace=out(15), dryPlan=await quote(dryRace);
    await race('Duas conexões disputam o mesmo saldo seco','guigs_apply_fridge_transfer',
      transferArgs(dryRace,dryPlan),transferArgs(dryRace,dryPlan),[owner,attendant]);
    const cap=out(2,small), capPlan=await quote(cap);
    await race('Duas conexões disputam capacidade do bloco','guigs_apply_fridge_transfer',
      transferArgs(cap,capPlan),transferArgs(cap,capPlan),[owner,attendant]);
    await blocked('Capacidade excedida recusada',rpcResponse(owner,'guigs_quote_fridge_transfer',{...scoped,p_spec:out(1,small)}));
    const reposition = await moveArgs(a,c,3);
    await race('Duas conexões tentam mover o mesmo saldo de bloco','guigs_apply_fridge_slot_move',
      reposition,{...reposition,p_request_id:id()},[owner,attendant]);
    const replay=out(1), replayArgs=transferArgs(replay,await quote(replay));
    const replayResults=await Promise.all([twoSessions(owner,'guigs_apply_fridge_transfer',replayArgs),
      twoSessions(owner,'guigs_apply_fridge_transfer',replayArgs)]);
    const replaySuccesses=replayResults.filter(x=>x.ok);
    ok('Chave repetida concorrente: sucesso ou recusa NOWAIT, sem falha inesperada',
      replaySuccesses.length>0 && replayResults.every(x=>x.ok || /could not obtain lock/.test(x.error)));
    const firstResult=JSON.parse(replaySuccesses[0].data);
    for(const replayResult of replaySuccesses.slice(1))assert.deepEqual(JSON.parse(replayResult.data),firstResult);
    eq('Após o commit, reenvio retorna o mesmo evento por PostgREST',await rpc(owner,'guigs_apply_fridge_transfer',replayArgs),firstResult);
    mark('Reenvio não duplica o ledger',firstResult,2);
    const alternate=out(2), contestedKey=id();
    const firstPayload=transferArgs(replay,await quote(replay),contestedKey), secondPayload=transferArgs(alternate,await quote(alternate),contestedKey);
    const collisions=await race('Dois payloads válidos com a mesma chave geram um vencedor','guigs_apply_fridge_transfer',firstPayload,secondPayload,[owner,owner]);
    const conflict=await rpcResponse(owner,'guigs_apply_fridge_transfer',collisions[0].ok?secondPayload:firstPayload);
    ok('Após commit, a mesma chave com payload diferente é recusada',!conflict.ok && /Identificador já utilizado/.test(conflict.data?.message||''));
    snapshot('Depois das corridas de transferência');

    const inv=await rpc(owner,'guigs_create_spatial_inventory',{...scoped,p_observation:'Contagem artificial'});
    const invArgs={...scoped,p_inventory_id:inv};
    const invRead=(actor=owner)=>rpc(actor,'guigs_get_spatial_inventory',invArgs);
    const open=await invRead(attendant);
    ok('Contagem cega no servidor para owner e attendant',open.items.length>0 &&
      [...open.items,...(await invRead()).items].every(x=>!['expected_initial','basis_quantity','current_quantity',
        'initial_movement_count','basis_movement_count','current_movement_count','applied_delta'].some(k=>Object.hasOwn(x,k))));
    await blocked('PostgREST proíbe leitura direta dos itens da contagem',request(rest,'/guigs_inventory_items?select=id',undefined,attendant.token));
    await blocked('Inventário ativo bloqueia transferência',rpcResponse(owner,'guigs_quote_fridge_transfer',{...scoped,p_spec:out(1)}));
    const quantities=jsonSql(`select jsonb_object_agg(id,basis_quantity) from public.guigs_inventory_items where inventory_id='${inv}';`);
    const item=open.items[0];
    const countArgs=(i,quantity=quantities[i.id])=>({...invArgs,p_item_id:i.id,p_quantity:quantity,p_version:i.version});
    await race('Duas conexões contam a mesma versão do item','guigs_count_spatial_inventory_item',countArgs(item),countArgs(item),[owner,attendant]);
    for(const i of open.items.slice(1)) await rpc(attendant,'guigs_count_spatial_inventory_item',countArgs(i));
    ok('Inventário tem seco, não alocado e slots',open.items.some(x=>x.location==='stock')&&
      open.items.some(x=>x.location==='fridge'&&!x.slot_id)&&open.items.some(x=>!!x.slot_id));
    const status=(actor,version,target='review')=>rpcResponse(actor,'guigs_set_spatial_inventory_status',{...invArgs,p_status:target,p_version:version});
    const version=(await invRead()).inventory.version;
    await blocked('Attendant não manda inventário para revisão',status(attendant,version));
    await success(status(owner,version),'Revisão owner');
    let review=await invRead();
    ok('Bases do inventário visíveis em revisão',review.items.every(x=>Number.isInteger(x.basis_quantity)));
    await success(status(owner,review.inventory.version,'open'),'Reabrir contagem');
    const refreshed=await invRead();
    await rpc(owner,'guigs_recount_spatial_inventory_item',{
      ...invArgs,p_item_id:item.id,p_version:refreshed.items.find(x=>x.id===item.id).version});
    const recount=await invRead();
    await rpc(attendant,'guigs_count_spatial_inventory_item',countArgs(recount.items.find(x=>x.id===item.id)));
    await success(status(owner,(await invRead()).inventory.version),'Revisão após recontagem');
    review=await invRead();
    const closedArgs={...invArgs,p_version:review.inventory.version,p_confirm:true,p_request_id:id()};
    const preClose=ledger();
    const closed=await rpc(owner,'guigs_complete_spatial_inventory',closedArgs);
    eq('Fechamento idempotente',await rpc(owner,'guigs_complete_spatial_inventory',closedArgs),closed);
    eq('Contagem igual à referência não gera ajustes',ledger(),preClose);

    const suggestion=await need();
    eq('Sugestão usa saldo total válido sem dupla contagem',[suggestion.available,suggestion.suggested],[32,48]);
    const save=commandArgs('save',{note:'Artificial',items:[{product_id:product,quantity:12,source:'suggestion',
      supplier_id:supplier,expected_suggestion:suggestion.suggested}]});
    let order=await rpc(attendant,'guigs_apply_shopping_command',save);
    const transition=(s)=>commandArgs('status',{order_id:order.id,version:order.version,status:s});
    order=await rpc(attendant,'guigs_apply_shopping_command',transition('pending'));
    await blocked('Attendant não confirma pedido',rpcResponse(attendant,'guigs_apply_shopping_command',transition('ordered')));
    order=await rpc(owner,'guigs_apply_shopping_command',transition('ordered'));
    const beforeReceived=ledger();
    await race('Duas conexões disputam a mesma revisão de pedido','guigs_apply_shopping_command',
      transition('received'),transition('received'),[owner,owner]);
    const orderDetail=await rpc(owner,'guigs_get_purchase_order',{...scoped,p_order_id:order.id});
    eq('Status final do pedido com histórico único',orderDetail.events.map(x=>x.action),['received','ordered','pending','created']);
    eq('Recebimento administrativo não altera ledger',ledger(),beforeReceived);
    const lastLot=(await receive('RODADA-C',12,75)).lot_id;
    eq('Recebimento físico recalcula compra',[ (await need()).available,(await need()).suggested],[44,36]);
    const history=await rpc(attendant,'guigs_get_fridge_slot_history',{...scoped,p_slot_id:c,p_limit:12});
    ok('Histórico por bloco contém evento de entrada entre geladeiras',history.events.some(x=>x.event_id===cross.event_id));
    const final=snapshot('Final integrado');
    eq('Saldo total final consultado no banco',final.reduce((n,x)=>n+x.total,0),44);
    const moved=collisions[0].ok?1:2;
    const byLot=Object.fromEntries(final.map(x=>[x.lot_id,[x.dry,x.free,x.slots,x.fridge,x.total]]));
    eq('Partições finais reconciliadas por lote',byLot,{
      [lot]:[2-moved,20+moved,8,28+moved,30],[early]:[0,2,0,2,2],[lastLot]:[12,0,0,0,12]});
    const bySlot=jsonSql(`select jsonb_object_agg(slot_id,quantity) from (
      select slot_id,sum(delta)::int quantity from public.guigs_movements where shop_id='${shop}'
        and lot_id='${lot}' and slot_id is not null group by slot_id) s;`);
    eq('Saldos finais em cada bloco conferidos no ledger',bySlot,{[a]:1,[b]:1,[c]:4,[small]:2});
    eq('Nenhum evento espacial de transferência desbalanceado',sql(`select count(*) from (select event_id from public.guigs_movements
      where shop_id='${shop}' and movement_type in ('transfer','return','relocate') group by event_id having sum(delta)<>0)x;`),'0');
    evidence.status='PASS';
    console.log(`Integração local: ${evidence.checks.length} verificações passaram (Auth, PostgREST e PostgreSQL nativos).`);
  } catch (error) {
    evidence.error=error.message;
    throw error;
  } finally {
    await Promise.all(children.map(child=>new Promise(resolve=>{
      if(child.exitCode!==null || !child.pid) return resolve();
      child.once('exit',resolve); child.kill();
    })));
    if(running) ctl(['-m','fast','stop']);
    fs.writeFileSync(path.join(root,'integration-results.json'),JSON.stringify(evidence,null,2));
    console.log(`Evidência externa: ${path.join(root,'integration-results.json')}`);
  }
}

run().catch(e=>{console.error(e.message);process.exitCode=1;});
