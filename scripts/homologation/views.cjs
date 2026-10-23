const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright'),{build,files}=require('../build.cjs');
const {check,report,stateFile,privatePath,URL_BASE,PUBLIC_KEY}=require('./live.cjs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'guigs-views-live-'));
for(const file of files){const out=path.join(temp,file);fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(path.join(__dirname,'../..',file),out);}
const artifact=build({sourceRoot:temp,env:{GUIGS_SUPABASE_URL:URL_BASE,GUIGS_SUPABASE_PUBLISHABLE_KEY:PUBLIC_KEY}});
const server=http.createServer((req,res)=>{const file=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';if(!artifact.files.includes(file)){res.statusCode=404;return res.end();}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.png')?'image/png':'application/json');res.end(fs.readFileSync(path.join(artifact.directory,file)));});
(async()=>{let browser;await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
 browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',args:['--enable-precise-memory-info']});const state=JSON.parse(fs.readFileSync(privatePath(stateFile)));
 for(const role of ['ownerB','attendantA']){
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});await context.route('**/*',r=>['127.0.0.1',new URL(URL_BASE).hostname,'esm.sh'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());const page=await context.newPage();page.setDefaultTimeout(30000);
  await page.goto(`http://127.0.0.1:${server.address().port}/auth-preview.html`);await page.fill('#email',state.users[role].email);await page.fill('#password',state.users[role].password);await page.click('#enter');await page.waitForSelector('#content:not(.hidden)');
  if(role==='attendantA'){check(await page.isHidden('#navReports')&&await page.isHidden('#adjustStock'),'UI real de atendente oculta administração e relatórios');await page.click('#navInventory');await page.waitForFunction(()=>!document.getElementById('inventoryReload').disabled);check(await page.isHidden('#newInventory'),'UI de atendente não cria inventário');}
  else{
   await page.click('#navInventory');await page.waitForFunction(()=>!document.getElementById('inventoryReload').disabled);const before=await page.evaluate(()=>performance.memory?.usedJSHeapSize);await page.locator('[data-inventory-open]').first().click();await page.waitForSelector('#inventoryDetail:not(.hidden)');
   const memory=await page.evaluate(()=>({usedJSHeapBytes:performance.memory?.usedJSHeapSize,totalJSHeapBytes:performance.memory?.totalJSHeapSize,visibleItems:document.querySelectorAll('[data-item-id]').length}));
   check(memory.visibleItems===2002,'Detalhe grande renderiza os 2002 itens',{beforeHeapBytes:before,...memory});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Detalhe grande sem overflow em 390×844');
   await page.keyboard.press('Tab');check(await page.evaluate(()=>document.activeElement!==document.body),'Teclado alcança controles do detalhe');
  }
  await context.close();
 }
 report('views-results');
}finally{if(browser)await browser.close();server.close();}})().catch(()=>{console.error('Falha views; detalhes privados omitidos.');report('views-results');process.exitCode=1;});
