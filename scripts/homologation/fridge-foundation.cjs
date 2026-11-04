// Execução explícita: PostgREST/Auth artificial e frontend v1.6 exato; nunca produção.
const http=require('node:http');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const {files}=require('../build.cjs');
const {ids,client,loginAll,check,URL_BASE,PUBLIC_KEY}=require('./live.cjs');
const base='a0079a192597252a283a0e70f4f945db27275793';
const root=path.resolve(__dirname,'../..');
async function legacyBrowser(user){
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
  const tracked=new Set(execFileSync('git',['ls-tree','-r','--name-only',base],{cwd:root,encoding:'utf8'}).trim().split(/\r?\n/));
  const assets=new Map(files.filter(f=>tracked.has(f)).map(f=>[f,execFileSync('git',['show',base+':'+f],{cwd:root})]));
  assets.set('config.js',Buffer.from('window.GUIGS_SUPABASE_CONFIG='+JSON.stringify({url:URL_BASE,publishableKey:PUBLIC_KEY})+';'));
  const server=http.createServer((req,res)=>{
    const f=new URL(req.url,'http://127.0.0.1').pathname.slice(1)||'index.html';
    if(!assets.has(f)){res.statusCode=404;return res.end();}
    res.setHeader('content-type',f.endsWith('.js')?'text/javascript':f.endsWith('.html')?'text/html':f.endsWith('.png')?'image/png':'application/json');
    res.end(assets.get(f));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  let browser,stage='abrir navegador';
  try{
    browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
    const context=await browser.newContext({serviceWorkers:'block'});
    const allowed=new Set(['127.0.0.1',new URL(URL_BASE).hostname,'esm.sh']);
    await context.route('**/*',route=>allowed.has(new URL(route.request().url()).hostname)?route.continue():route.abort());
    const page=await context.newPage(); page.setDefaultTimeout(25000);
    stage='abrir tela de acesso';
    await page.goto('http://127.0.0.1:'+server.address().port+'/auth-preview.html');
    stage='autenticar e sincronizar painel';
    await page.fill('#email',user.email); await page.fill('#password',user.password); await page.click('#enter');
    await page.waitForSelector('#content:not(.hidden)');
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('sincronizado'));
    check((await page.locator('#products tr').count())>0,'Frontend original v1.6 autentica e sincroniza produtos/saldos');
    stage='carregar histórico';
    await page.click('#navHistory');
    await page.waitForSelector('#historyView:not(.hidden) #history tr');
    check((await page.locator('#history tr').count())>0,'Histórico v1.6 após migration espacial');
    stage='carregar inventário';
    await page.click('#navInventory');
    await page.waitForFunction(()=>document.querySelector('#inventoryList').textContent.trim().length>0);
    check(!(await page.textContent('#inventoryMessage')).trim(),'Inventário v1.6 lista sem erro');
    stage='carregar relatórios';
    await page.click('#navReports');
    await page.waitForFunction(()=>document.querySelector('#reportsMessage').textContent.includes('Período aplicado'));
    check((await page.locator('#reportsSummary').textContent()).trim().length>0,'Relatórios v1.6 carregam após migration espacial');
    await context.close();
  }catch(error){
    console.error('Falha v1.6 ao '+stage+(error.name==='TimeoutError'?' (tempo limite).':'.'));
    throw error;
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
async function run(){
  const {clients,state}=await loginAll();
  const p=(shop)=>({p_shop_id:shop});
  const fixture=crypto.randomUUID().slice(0,8);
  for(const side of ['A','B']){
    const shop=ids['shop'+side], foreign=ids['shop'+(side==='A'?'B':'A')];
    const owner=clients['owner'+side],attendant=clients['attendant'+side];
    const save=(c,s,kind,values)=>c.rpc('guigs_save_fridge_layout',{...p(s),p_kind:kind,p_values:values});
    const f=await save(owner,shop,'fridge',{name:'Fixture v1.7 '+fixture+' '+side});
    check(!f.error&&f.data.shop_id===shop,'Owner '+side+' grava layout artificial');
    const h=await save(owner,shop,'shelf',{name:'Prateleira artificial',fridge_id:f.data.id});
    check(!h.error&&h.data.fridge_id===f.data.id,'FK de prateleira '+side);
    const x=await save(owner,shop,'slot',{name:'Posição artificial',fridge_id:f.data.id,shelf_id:h.data.id});
    check(!x.error&&x.data.shelf_id===h.data.id,'FK de posição '+side);
    for(const [role,c] of [['owner',owner],['attendant',attendant]]){
      const map=await c.rpc('guigs_get_fridge_map',p(shop));
      check(!map.error&&map.data.slots.some(s=>s.id===x.data.id&&s.quantity===0&&s.lots.length===0),role+' '+side+' lê posição vazia');
      check(!!(await c.rpc('guigs_get_fridge_map',p(foreign))).error,role+' '+side+' mapa cross-shop negado');
      check(!!(await save(c,foreign,'fridge',{name:'Não permitido'})).error,role+' '+side+' escrita cross-shop negada');
      for(const t of ['guigs_fridges','guigs_fridge_shelves','guigs_fridge_slots']){
        const r=await c.from(t).select('id').eq('shop_id',foreign);
        check(!r.error&&r.data.length===0,role+' '+side+' RLS '+t);
      }
    }
    check(!!(await save(attendant,shop,'fridge',{name:'Não permitido'})).error,'Atendente '+side+' não edita');
    check(!!(await owner.from('guigs_fridges').update({name:'Não permitido'}).eq('id',f.data.id)).error,'Owner '+side+' sem DML direto');
  }
  check(!!(await client().rpc('guigs_get_fridge_map',p(ids.shopA))).error,'Anônimo não executa mapa');
  await legacyBrowser(state.users.ownerA);
}
module.exports={legacyBrowser};
if(require.main===module){
  run().catch(()=>{console.error('Falha no check de compatibilidade; respostas e credenciais omitidas.');process.exitCode=1;});
}
