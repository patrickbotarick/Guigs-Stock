// Ensaio com duas conexões reais. Usa apenas um cluster novo em loopback e dados artificiais.
const assert = require('node:assert/strict');
const {spawn, execFileSync} = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

async function localPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const {port} = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function run() {
  const bin = process.env.GUIGS_TEST_PG_BIN;
  assert.ok(bin && path.isAbsolute(bin), 'Defina GUIGS_TEST_PG_BIN com a pasta bin do PostgreSQL local.');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/i.test(key)));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guigs-replay-pg-'));
  const cluster = path.join(root, 'cluster');
  const port = await localPort();
  const tool = name => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
  const options = {env, encoding:'utf8', windowsHide:true, timeout:30000};
  const args = ['-X','-qAt','-w','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(port),'-U','guigs_test','-d','postgres'];
  const sql = (input, extras = []) => execFileSync(tool('psql'), [...args, ...extras], {...options,input}).trim();
  const session = statement => new Promise((resolve, reject) => {
    const child = spawn(tool('psql'),args,{env,windowsHide:true});
    let output='', errors='';
    child.stdout.on('data',chunk=>output+=chunk);
    child.stderr.on('data',chunk=>errors+=chunk);
    child.on('error',reject);
    child.on('close',code=>code===0?resolve(output.trim()):reject(Error(errors)));
    child.stdin.end(statement);
  });
  const id = n => '20000000-0000-0000-0000-'+String(n).padStart(12,'0');
  const asOwner = statement => `begin; set local statement_timeout='8s'; set local role authenticated;
    set local request.jwt.claim.sub='${id(1)}'; ${statement} commit;`;
  const allocate = key => `select public.guigs_allocate_fridge_stock('${id(10)}','${key}',
    '[{"lot_id":"${id(30)}","slot_id":"${id(60)}","quantity":1}]')::text;`;
  execFileSync(tool('initdb'),['-D',cluster,'-U','guigs_test','-A','trust','--locale=C','-E','UTF8'],options);
  const ctl = command => execFileSync(tool('pg_ctl'),['-D',cluster,'-w','-t','15',...command],{...options,stdio:'ignore'});
  ctl(['-l',path.join(root,'server.log'),'-o',`-h 127.0.0.1 -p ${port}`,'start']);
  try {
    sql(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key,email text);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated,anon;
      grant execute on function auth.uid() to authenticated,anon;`);
    const folder = path.join(__dirname,'../supabase/migrations');
    for (const file of fs.readdirSync(folder).filter(f=>f.endsWith('.sql')).sort()) sql('', ['-f',path.join(folder,file)]);
    sql(`insert into auth.users values('${id(1)}','owner@test.invalid');
      insert into public.guigs_shops(id,name) values('${id(10)}','Loja artificial');
      insert into public.guigs_memberships(shop_id,user_id,role) values('${id(10)}','${id(1)}','owner');
      insert into public.guigs_products(id,shop_id,name) values('${id(20)}','${id(10)}','Produto artificial');
      insert into public.guigs_lots(id,shop_id,product_id,code,expiry)
        values('${id(30)}','${id(10)}','${id(20)}','LOTE-A',current_date+30);
      insert into public.guigs_fridges(id,shop_id,name) values('${id(40)}','${id(10)}','Geladeira artificial');
      insert into public.guigs_fridge_shelves(id,shop_id,fridge_id,name) values('${id(50)}','${id(10)}','${id(40)}','Prateleira');
      insert into public.guigs_fridge_slots(id,shop_id,fridge_id,shelf_id,product_id,name,capacity_quantity)
        values('${id(60)}','${id(10)}','${id(40)}','${id(50)}','${id(20)}','Slot',10);
      insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id)
        values('${id(10)}','${id(30)}','${id(70)}','receipt','fridge',3,'${id(1)}');
      insert into guigs_private.spatial_commands(shop_id,request_id,actor_id,command,payload,result)
        values('${id(10)}','${id(80)}','${id(1)}','allocate',
          '[{"lot_id":"${id(30)}","slot_id":"${id(60)}","quantity":1}]','{"event_id":"${id(81)}","quantity":1}');`);
    await assert.rejects(session(asOwner(allocate(id(80)))),/ciclo anterior/);
    const firstCall = session(asOwner(allocate(id(82)) + ' select pg_sleep(3);'));
    let overlap = false;
    for (let attempt=0;attempt<10&&!overlap;attempt++) {
      overlap = sql("select exists(select 1 from pg_stat_activity where wait_event='PgSleep');")==='t';
      if (!overlap) await new Promise(resolve=>setTimeout(resolve,100));
    }
    const race = await Promise.allSettled([firstCall,session(asOwner(allocate(id(82))))]);
    assert.ok(overlap,'A primeira transação deve permanecer aberta durante o retry.');
    assert.equal(race[0].status,'fulfilled');
    assert.equal(race[1].status,'rejected');
    assert.match(race[1].reason.message,/could not obtain lock on relation/);
    const first = race[0].value;
    const retry = await session(asOwner(allocate(id(82))));
    assert.deepEqual(JSON.parse(first), JSON.parse(retry));
    assert.equal(sql('select count(*) from public.guigs_movements where spatial;'),'2');
    assert.equal(sql('select count(*) from guigs_private.spatial_commands;'),'2');
    console.log('Replay PostgreSQL: 8 verificações passaram em duas conexões reais locais.');
  } finally {
    ctl(['-m','fast','stop']);
  }
}

run().catch(error=>{console.error(error.message);process.exitCode=1;});
