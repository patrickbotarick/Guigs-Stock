const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const {build,files}=require('../build.cjs');
const {ids,check,report,URL_BASE,PUBLIC_KEY,stateFile,privatePath,privateDir}=require('./live.cjs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'guigs-live-dist-'));
for(const file of files){const to=path.join(temp,file);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(path.join(__dirname,'../..',file),to);}
const artifact=build({sourceRoot:temp,env:{GUIGS_SUPABASE_URL:URL_BASE,GUIGS_SUPABASE_PUBLISHABLE_KEY:PUBLIC_KEY}});
let workerVersion=9;
const server=http.createServer((req,res)=>{
 const file=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
 if(!artifact.files.includes(file)){res.statusCode=404;return res.end();}
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.png')?'image/png':'application/json');
 let data=fs.readFileSync(path.join(artifact.directory,file));
 if(file==='service-worker.js'){res.setHeader('Cache-Control','no-store');data=data.toString().replace('guigs-stock-shell-v10',`guigs-stock-shell-v${workerVersion}`);}
 res.end(data);
});
async function run(){
 let browser;await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`,state=JSON.parse(fs.readFileSync(privatePath(stateFile)));
 try{
  browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'allow'});
  const unexpected=[],errors=[];
  await context.route('**/*',route=>{const host=new URL(route.request().url()).hostname;if(!['127.0.0.1',new URL(URL_BASE).hostname,'esm.sh'].includes(host)){unexpected.push(host);return route.abort();}return route.continue();});
  const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',()=>errors.push('JS_ERROR'));
  await page.goto(base+'/auth-preview.html');await page.fill('#email',state.users.ownerA.email);await page.fill('#password',state.users.ownerA.password);await page.click('#enter');
  await page.waitForSelector('#content:not(.hidden)');await page.waitForFunction(()=>document.getElementById('status').textContent.includes('sincronizado'));
  check(true,'Login UI real em 390×844');
  check((await page.textContent('#products')).includes('REFRIGERANTE TESTE'),'Visão geral com dados reais artificiais');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile sem overflow horizontal');
  for(const file of ['docs/V1.6_RELEASE_READINESS.md','scripts/homologation/live.cjs','tests/security.cjs','supabase/migrations/007_physical_inventory.sql','AGENTS.md'])check((await context.request.get(base+'/'+file)).status()===404,'dist exclui '+file);
  const idle=()=>page.waitForFunction(()=>!document.getElementById('refresh').disabled);
  const choose=(selector,value)=>page.selectOption(selector,value,{force:true});
  const closed=id=>page.waitForSelector('#'+id+':not([open])',{state:'attached'});
  const confirm=async()=>{await page.waitForSelector('#operationConfirmDialog[open]');check(await page.getAttribute('#operationConfirmDialog','aria-labelledby')!==null,'Confirmação com título acessível');await page.click('#confirmOperation');};
  await page.click('#receiveStock');await page.waitForSelector('#receiveProductSearch');
  await page.fill('#receiveProductSearch','REFRIGERANTE');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  check(await page.inputValue('#receiveProduct')===ids.productA,'Searchable por teclado seleciona produto real');
  await choose('#receiveSupplier',ids.supplierA);await page.fill('#lotCode','UI-ARTIFICIAL-'+Date.now());await page.fill('#expiry','2027-02-01');await page.fill('#receiveQuantity','4');await page.click('#saveReceipt');await closed('receiveDialog');await idle();check(true,'Recebimento real pela UI');
  await page.click('#adjustStock');await choose('#adjustLot',ids.lotA);await page.fill('#adjustQuantity','80');await page.fill('#adjustNote','Preparação artificial UI repetível');await page.click('#saveAdjust');await confirm();await closed('adjustDialog');await idle();
  await page.click('#transferStock');await choose('#transferLot',ids.lotA);await page.fill('#transferQuantity','1');await page.click('#saveTransfer');await closed('transferDialog');await idle();check(true,'Transferência real pela UI');
  await page.click('#registerSale');await choose('#saleLot',ids.lotA);await page.fill('#saleQuantity','1');await page.click('#saveSale');await closed('saleDialog');await idle();check(true,'Venda real pela UI');
  await page.click('#registerLoss');await choose('#lossLot',ids.lotA);await page.fill('#lossQuantity','1');await page.fill('#lossNote','Avaria artificial UI');await page.click('#saveLoss');await confirm();await closed('lossDialog');await idle();check(true,'Perda confirmada pela UI');
  await page.click('#adjustStock');await choose('#adjustLot',ids.lotA);await page.fill('#adjustQuantity','80');await page.fill('#adjustNote','Ajuste artificial UI');await page.click('#saveAdjust');await confirm();await closed('adjustDialog');await idle();check(true,'Ajuste confirmado pela UI');
  await page.click('#navHistory');await page.waitForFunction(()=>document.getElementById('history').textContent.includes('artificial'));check(true,'Histórico real da operação');
  await page.click('#navInventory');await page.waitForFunction(()=>!document.getElementById('inventoryReload').disabled);
  await page.click('#newInventory');await page.click('#inventoryCreateSubmit');await page.waitForSelector('#inventoryDetail:not(.hidden)');
  const items=await page.locator('[data-item-id]').evaluateAll(rows=>rows.map(r=>({id:r.dataset.itemId,value:r.querySelector('input')?.value})));check(items.length>=4,'Snapshot UI inclui lote recebido');
  for(const item of items){const input=page.locator(`[data-item-id="${item.id}"] input`);await input.fill('1');await page.locator(`[data-item-id="${item.id}"] button[type="submit"]`).click();await page.waitForFunction(id=>!document.getElementById('count-'+id),item.id);await page.waitForFunction(()=>!document.getElementById('inventoryReload').disabled);await page.selectOption('#inventoryFilter','all');}
  await page.click('#inventoryReview');await page.waitForFunction(()=>document.getElementById('inventoryDetailTitle').textContent.includes('Em revisão'));await page.check('#inventoryReviewCheck');await page.click('#inventoryComplete');await confirm();await page.waitForFunction(()=>document.getElementById('inventoryDetailTitle').textContent.includes('Concluído'));check(true,'Inventário completo pela UI real');
  await page.click('#navReports');await page.waitForFunction(()=>!document.getElementById('reportsReload').disabled&&document.getElementById('reportsMessage').textContent.includes('Período aplicado'));check((await page.textContent('#reportsInventories')).includes('Concluído'),'Relatório UI inclui inventário real');
  await page.setViewportSize({width:390,height:450});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Viewport com teclado sem overflow');await page.setViewportSize({width:1440,height:900});check(await page.isVisible('#reportsSummary'),'Desktop exibe relatório real');
  await page.evaluate(()=>navigator.serviceWorker.ready);await page.waitForFunction(()=>!!navigator.serviceWorker.controller);check(await page.evaluate(async()=>(await caches.keys()).includes('guigs-stock-shell-v9')),'PWA v9 artificial instalada');
  workerVersion=10;await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update();});await page.waitForFunction(async()=>{const keys=await caches.keys();return keys.includes('guigs-stock-shell-v10')&&!keys.includes('guigs-stock-shell-v9');});check(true,'PWA atualiza v9 para v10');
  await context.setOffline(true);await page.waitForFunction(()=>document.getElementById('reportsReload').disabled);check(await page.isVisible('#reportsOffline'),'Relatório bloqueado offline');
  await page.click('#navInventory');check(await page.isDisabled('#newInventory'),'Inventário bloqueado offline');await page.click('#navOverview');check(await page.isDisabled('#registerSale')&&await page.isDisabled('#receiveStock'),'Operações bloqueadas offline');
  await context.setOffline(false);await page.waitForFunction(()=>!document.getElementById('registerSale').disabled);await page.click('#refresh');await idle();check(true,'Reconexão restaura operação');
  check(unexpected.length===0,'Nenhum destino externo além de homologação e SDK');check(errors.length===0,'Sem erros JavaScript');
  if(process.env.HOMOLOG_RESULTS_DIR)await page.screenshot({path:path.join(process.env.HOMOLOG_RESULTS_DIR,'frontend-live.png')});
  await context.close();
  // Renderização do detalhe grande com sessão de outra loja, sem mocks.
  const large=await browser.newContext({viewport:{width:390,height:844}});const lp=await large.newPage();lp.setDefaultTimeout(30000);
  await lp.goto(base+'/auth-preview.html');await lp.fill('#email',state.users.ownerB.email);await lp.fill('#password',state.users.ownerB.password);await lp.click('#enter');await lp.waitForSelector('#content:not(.hidden)');
  await lp.click('#navInventory');await lp.waitForFunction(()=>!document.getElementById('inventoryReload').disabled);const start=performance.now();await lp.locator('[data-inventory-open]').first().click();await lp.waitForSelector('#inventoryDetail:not(.hidden)');check(true,'Mobile renderiza detalhe de 2002 itens',{elapsedMs:Math.round(performance.now()-start)});await large.close();
  report('browser-results');
 }finally{if(browser)await browser.close();server.close();}
}
run().catch(e=>{console.error('Falha UI: '+String(e.message||'').split('\n')[0].replace(/https?:\/\/\S+/g,'[URL]'));report('browser-results');process.exitCode=1;});
