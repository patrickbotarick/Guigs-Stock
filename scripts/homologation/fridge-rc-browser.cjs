const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const {build,files}=require('../build.cjs');
const {adminClient}=require('./fridge-storage.cjs');
const {legacyBrowser}=require('./fridge-foundation.cjs');
const {URL_BASE,PUBLIC_KEY,check}=require('./live.cjs');
const root=path.resolve(__dirname,'../..');
(async()=>{
 const shop=process.env.GUIGS_V17_FIXTURE_SHOP;
 if(!/^[a-f0-9-]{36}$/.test(shop||''))throw Error('Fixture obrigatória');
 const admin=adminClient(),known=await admin.from('guigs_shops').select('name').eq('id',shop).single();
 if(known.data?.name!=='Fixture v1.7 RC integrada')throw Error('Alvo não é a fixture');
 const users={};
 const legacyOnly=process.argv.includes('--legacy-only');
 for(const role of legacyOnly?['owner']:['owner','attendant']){
  const email='guigs-v17-'+role+'-'+crypto.randomUUID()+'@example.com';
  const password=crypto.randomBytes(32).toString('base64url');
  const result=await admin.auth.admin.createUser({email,password,email_confirm:true});
  if(result.error)throw Error('Auth artificial indisponível');
  const membership=await admin.from('guigs_memberships').insert({shop_id:shop,user_id:result.data.user.id,role,active:true});
  if(membership.error)throw Error('Vínculo artificial indisponível');
  users[role]={email,password};
 }
 // A versão 1.6 exige exatamente um vínculo ativo por conta.
 await legacyBrowser(users.owner);
 if(legacyOnly)return;
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'guigs-v17-live-build-'));
 let server,browser;
 try{
  for(const f of files){const to=path.join(temp,f);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(path.join(root,f),to);}
  const artifact=build({sourceRoot:temp,env:{GUIGS_SUPABASE_URL:URL_BASE,GUIGS_SUPABASE_PUBLISHABLE_KEY:PUBLIC_KEY}});
  const allowed=new Set(artifact.files);
  server=http.createServer((req,res)=>{
   const f=new URL(req.url,'http://127.0.0.1').pathname.slice(1)||'index.html';
   if(!allowed.has(f)){res.statusCode=404;return res.end();}
   res.setHeader('content-type',f.endsWith('.js')?'text/javascript':f.endsWith('.html')?'text/html':f.endsWith('.png')?'image/png':'application/json');
   res.end(fs.readFileSync(path.join(artifact.directory,f)));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  for(const role of ['owner','attendant']){
   const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
   const hosts=new Set(['127.0.0.1',new URL(URL_BASE).hostname,'esm.sh']);
   await context.route('**/*',r=>hosts.has(new URL(r.request().url()).hostname)?r.continue():r.abort());
   const page=await context.newPage(),errors=[];
   page.on('pageerror',()=>errors.push(true));
   page.setDefaultTimeout(20000);
   await page.goto(base+'/auth-preview.html');
   await page.fill('#email',users[role].email);await page.fill('#password',users[role].password);await page.click('#enter');
   await page.waitForSelector('#content:not(.hidden)');
   await page.click('#navFridges');await page.waitForSelector('.fridge-cabinet');
   check((await page.locator('.fridge-cabinet').count())>=2,'Navegador real: '+role+' autentica e carrega mapa do homolog');
   await page.waitForFunction(()=>[...document.querySelectorAll('img.fridge-photo')].some(img=>img.complete&&img.naturalWidth>0));
   check(true,'Navegador real: '+role+' carrega foto assinada no mapa');
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Navegador real: '+role+' mobile sem rolagem global');
   check(await page.isVisible('#fridgeEdit')===(role==='owner'),'Navegador real: editor respeita perfil '+role);
   await page.click('#navInventory');await page.waitForFunction(()=>document.querySelector('#inventoryList').textContent.includes('Por posição'));
   check(true,'Navegador real: '+role+' lê inventário espacial');
   if(role==='owner'){
    await page.click('#navReports');await page.waitForFunction(()=>document.querySelector('#reportsMessage').textContent.includes('Período aplicado'));
    check((await page.locator('#reportsFridgeSummary article').count())>0,'Navegador real: owner lê métricas por geladeira');
   }else{
    await page.goto(base+'/#relatorios');
    await page.waitForFunction(()=>document.querySelector('#reportsMessage').textContent.includes('apenas ao proprietário'));
    check(!(await page.isVisible('#navReports'))&&await page.isDisabled('#reportsExport'),'Navegador real: atendente sem relatório ou exportação');
   }
   check(errors.length===0,'Navegador real: '+role+' sem exceção JavaScript');
   await context.close();
  }
 }finally{
  if(browser)await browser.close();
  if(server)await new Promise(resolve=>server.close(resolve));
  if(path.dirname(temp)!==fs.realpathSync(os.tmpdir())||!path.basename(temp).startsWith('guigs-v17-live-build-'))throw Error('Limpeza de teste recusada');
  fs.rmSync(temp,{recursive:true});
 }
})().catch(()=>{console.error('Falha na interface real do homolog; dados e credenciais omitidos.');process.exitCode=1;});
