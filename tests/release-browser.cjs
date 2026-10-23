// Artefato dist em TEMP, SDK simulado, leituras/operações em um único PGlite artificial.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const {build,files}=require('../scripts/build.cjs');const {fixture}=require('./browser.cjs');
const {createTestDatabase,asUser,callRPC,id}=require('./inventory-support.cjs');const {report}=require('./reports-support.cjs');
let checks=0,db,queue=Promise.resolve(),workerVersion=9;const check=(v,m)=>{assert.ok(v,m);checks++;};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'guigs-release-browser-'));
for(const file of files){const out=path.join(temp,file);fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(path.join(__dirname,'..',file),out);}
const artifact=build({sourceRoot:temp,env:{GUIGS_SUPABASE_URL:'https://test.supabase.co',GUIGS_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_TEST_ONLY'}});
async function dispatch(request){
 if(request.table){
  if(!['guigs_products','guigs_lots','guigs_suppliers'].includes(request.table))throw Error('Tabela de teste não permitida');
  return asUser(db,'owner',async tx=>(await tx.query(`select * from public.${request.table} where shop_id=$1 order by id limit 1000 offset $2`,[id(10),request.offset||0])).rows);
 }
 if(request.name==='guigs_get_reports')return report(db,'owner',request.args);
 if(/inventory|inventories/.test(request.name))return callRPC(db,'owner',request.name,request.args);
 const reads={guigs_get_lot_balances:['select * from public.guigs_get_lot_balances($1)',[id(10)]],guigs_get_history_actors:['select * from public.guigs_get_history_actors($1)',[id(10)]],guigs_get_history:['select * from public.guigs_get_history($1,20,0)',[id(10)]]};
 if(reads[request.name])return asUser(db,'owner',async tx=>(await tx.query(...reads[request.name])).rows);
 if(request.name==='guigs_adjust_stock')return asUser(db,'owner',async tx=>(await tx.query('select public.guigs_adjust_stock($1,$2,$3,$4,$5) as data',[id(10),request.args.p_lot_id,request.args.p_location,request.args.p_new_quantity,request.args.p_note])).rows[0].data);
 throw Error('RPC de teste não permitida');
}
const server=http.createServer(async(req,res)=>{
 const file=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
 if(file==='test-api'&&req.method==='POST'){
  let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);
  const run=queue.then(()=>dispatch(request));queue=run.catch(()=>{});
  res.setHeader('Content-Type','application/json');
  try{res.end(JSON.stringify({data:await run,error:null}));}catch(e){res.end(JSON.stringify({data:null,error:{message:e.message,code:e.code}}));}return;
 }
 if(file==='fake.js'){res.setHeader('Content-Type','text/javascript');return res.end('export const createClient=()=>window.__mockClient;');}
 // Este servidor serve exclusivamente o artefato; config.js vem do build artificial.
 if(!artifact.files.includes(file)){res.statusCode=404;return res.end();}
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.png')?'image/png':'application/json');
 let content=fs.readFileSync(path.join(artifact.directory,file));if(file.endsWith('.js'))content=content.toString().replace('https://esm.sh/@supabase/supabase-js@2','./fake.js');
 if(file==='service-worker.js'){res.setHeader('Cache-Control','no-store');content=content.replace('guigs-stock-shell-v10',`guigs-stock-shell-v${workerVersion}`);}
 res.end(content);
});
function bridge(shopId){
 const api=request=>fetch('/test-api',{method:'POST',body:JSON.stringify(request)}).then(r=>r.json());
 window.__mockClient.from=table=>({offset:0,select(){return this;},eq(){return this;},range(from){this.offset=from;return this;},then(resolve,reject){return (table==='guigs_memberships'?Promise.resolve({data:[{shop_id:shopId,role:'owner',active:true}],error:null}):api({table,offset:this.offset})).then(resolve,reject);}});
 window.__mockClient.rpc=(name,args)=>api({name,args});
}
(async()=>{
 let browser;await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try {
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  for(const through of [6,8]){
   db=await createTestDatabase({through});
   await db.query('update public.guigs_products set min_total=20,target_total=30,min_fridge=10,target_fridge=15 where id=$1',[id(20)]);
   const context=await browser.newContext({serviceWorkers:through===8?'allow':'block'});const errors=[],external=[];
   await context.route('**/*',route=>{if(new URL(route.request().url()).hostname!=='127.0.0.1'){external.push(route.request().url());return route.abort();}return route.continue();});
   await context.addInitScript(fixture,{role:'owner',session:true});await context.addInitScript(bridge,id(10));
   const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base);await page.waitForSelector('#content:not(.hidden)');
   check((await page.textContent('#status')).includes('sincronizado'),'dist carrega visão geral com schema '+through);
   for(const file of ['docs/V1.6D_RELATORIOS.md','scripts/backup-production.ps1','tests/database.cjs','supabase/migrations/007_physical_inventory.sql','AGENTS.md'])check((await context.request.get(base+'/'+file)).status()===404,'Arquivo interno não publicado');
   if(through===6){
    await page.click('#navInventory');await page.waitForFunction(()=>document.getElementById('inventoryMessage').textContent.includes('indisponível'));
    check(await page.isVisible('#inventoryMessage'),'007 ausente não quebra carregamento');
    await page.click('#navReports');await page.waitForFunction(()=>document.getElementById('reportsMessage').textContent.includes('indisponíveis'));
    check(await page.isVisible('#reportsMessage'),'008 ausente não quebra carregamento');
    await page.click('#navOverview');await page.waitForSelector('#overviewView:not(.hidden)');check(await page.isVisible('#overviewView'),'Retorno à operação sem migrations novas');
   }else{
    await page.click('#adjustStock');await page.selectOption('#adjustLot',id(30),{force:true});await page.fill('#adjustQuantity','9');await page.fill('#adjustNote','Integração artificial B/C/D');await page.click('#saveAdjust');
    await page.waitForSelector('#operationConfirmDialog[open]');await page.click('#confirmOperation');await page.waitForSelector('#adjustDialog:not([open])',{state:'attached'});await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
    check((await db.query("select sum(delta)::int as n from public.guigs_movements where lot_id=$1 and location='stock'",[id(30)])).rows[0].n===9,'Ajuste B confirma pelo mecanismo oficial');
    await page.click('#navInventory');await page.waitForFunction(()=>!document.getElementById('inventoryReload').disabled&&document.getElementById('inventoryPage').textContent.includes('Página'));
    await page.click('#newInventory');await page.click('#inventoryCreateSubmit');await page.waitForSelector('#inventoryDetail:not(.hidden)');
    const items=(await db.query('select * from public.guigs_inventory_items order by id')).rows;
    check(Number(items.find(i=>i.lot_id===id(30)&&i.location==='stock').expected_initial)===9,'Snapshot C reflete ajuste da B');
    for(const item of items){
     await page.locator(`[data-item-id="${item.id}"] input`).fill(String(Number(item.basis_quantity)-(item.lot_id===id(30)&&item.location==='stock'?1:0)));
     await page.locator(`[data-item-id="${item.id}"] button[type="submit"]`).click();await page.waitForFunction(id=>!document.getElementById('count-'+id),item.id);
     await page.waitForFunction(()=>!document.getElementById('inventoryReload').disabled);await page.selectOption('#inventoryFilter','all');
    }
    await page.click('#inventoryReview');await page.waitForFunction(()=>document.getElementById('inventoryDetailTitle').textContent.includes('Em revisão'));await page.check('#inventoryReviewCheck');await page.click('#inventoryComplete');await page.waitForSelector('#operationConfirmDialog[open]');await page.click('#confirmOperation');
    await page.waitForFunction(()=>document.getElementById('inventoryDetailTitle').textContent.includes('Concluído'));await page.waitForFunction(()=>!document.getElementById('inventoryReload').disabled);
    await page.click('#navReports');await page.waitForFunction(()=>!document.getElementById('reportsReload').disabled&&document.getElementById('reportsMessage').textContent.includes('Período aplicado'));
    check((await page.textContent('#reportsSummary')).includes('2 operações')&&(await page.textContent('#reportsSummary')).includes('-2 unidades de variação líquida'),'D inclui ajustes B e fechamento C');
    check((await page.textContent('#reportsInventories')).includes('Concluído')&&(await page.textContent('#reportsInventories')).includes('Divergentes: 1'),'D reflete inventário concluído');
    check((await page.textContent('#reportsRestock')).includes('Total: 16'),'Estoque atual D reflete saldo pós-inventário');
    await page.click('#navOverview');await page.click('#refresh');await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
    check((await db.query("select sum(delta)::int as n from public.guigs_movements where lot_id=$1 and location='stock'",[id(30)])).rows[0].n===8,'Saldo permanece reconciliado após navegar/atualizar');
    await page.evaluate(()=>navigator.serviceWorker.ready);await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
    check(await page.evaluate(async()=>(await caches.keys()).includes('guigs-stock-shell-v9')),'Cache anterior artificial instalado');
    await page.waitForLoadState('networkidle');
    workerVersion=10;await page.evaluate(async()=>{
     const registration=await navigator.serviceWorker.getRegistration(),previous=registration.active;
     await registration.update();
     const next=registration.installing||registration.waiting||(registration.active!==previous?registration.active:null);
     if(!next)throw Error('Worker novo não encontrado');
     if(next.state==='activated')return;
     await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('Worker novo não ativou')),8000);
      next.addEventListener('statechange',()=>{
       if(next.state==='activated'){clearTimeout(timeout);resolve();}
       if(next.state==='redundant'){clearTimeout(timeout);reject(Error('Instalação do worker novo falhou'));}
      });
     });
    });
    await page.waitForFunction(async()=>{
     const keys=await caches.keys(),registration=await navigator.serviceWorker.getRegistration();
     return registration?.active?.state==='activated'&&keys.includes('guigs-stock-shell-v10')&&!keys.includes('guigs-stock-shell-v9');
    });
    check(true,'Atualização remove v9 e ativa v10');
    for(const file of ['inventory.js','reports.js','pwa.js','icons/guigs-stock-192.png'])check(await page.evaluate(async name=>{
     const cache=await caches.open('guigs-stock-shell-v10');return !!await cache.match(new URL('./'+name,location.href).href);
    },file),'Shell contém '+file);
   }
   check(errors.length===0,'Sem erros JS: '+errors);check(external.length===0,'Sem conexão externa');
   await context.close();await queue;await db.close();db=null;
  }
  console.log(`Release navegador: ${checks} verificações passaram; build e ciclo B/C/D integrado.`);
 }finally{
  if(browser)await browser.close();if(db)await db.close();server.close();
  if(path.dirname(temp)!==fs.realpathSync(os.tmpdir())||!path.basename(temp).startsWith('guigs-release-browser-'))throw Error('Limpeza recusada.');
  fs.rmSync(temp,{recursive:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
