// Navegador com SDK Supabase mockado; RPCs de inventário usam só PGlite em memória.
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const {fixture}=require('./browser.cjs');const {createTestDatabase,callRPC,asUser,id}=require('./inventory-support.cjs');
let checks=0;const check=(value,message)=>{assert.ok(value,message);checks++;};
let db;let rpcQueue=Promise.resolve();const calls=[];
const root=path.resolve(__dirname,'..');
const allowed=['index.html','cloud-dashboard.js','inventory.js','pwa.js','manifest.webmanifest','logo-guigs.png'];
const server=http.createServer(async(req,res)=>{
 const file=new URL(req.url,'http://localhost').pathname.slice(1);
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/json');
 if(file==='test-inventory-rpc'&&req.method==='POST'){
  let body='';for await(const chunk of req)body+=chunk;
  const request=JSON.parse(body);calls.push(request);
  const run=rpcQueue.then(()=>callRPC(db,request.role,request.name,request.args));rpcQueue=run.catch(()=>{});
  try{res.end(JSON.stringify({data:await run,error:null}));}catch(error){res.end(JSON.stringify({data:null,error:{message:error.message,code:error.code}}));}return;
 }
 if(file==='config.js')return res.end('window.GUIGS_SUPABASE_CONFIG={url:"https://test.supabase.co",publishableKey:"sb_publishable_TEST"};');
 if(file==='fake.js')return res.end('export const createClient=()=>window.__mockClient;');
 if(!allowed.includes(file)){res.statusCode=404;return res.end();}
 let content=fs.readFileSync(path.join(root,file));if(file.endsWith('.js'))content=content.toString().replace('https://esm.sh/@supabase/supabase-js@2','./fake.js');res.end(content);
});
function inventoryClient({role,shopId}){
 const originalFrom=window.__mockClient.from;const originalRPC=window.__mockClient.rpc;
 window.__mockClient.from=table=>table==='guigs_memberships'?{select(){return this;},eq(){return this;},then(resolve,reject){return Promise.resolve({data:[{shop_id:shopId,role,active:true}],error:null}).then(resolve,reject);}}:originalFrom(table);
 window.__mockClient.rpc=async(name,args)=>{
  if(!name.includes('inventory')&&!name.includes('inventories'))return originalRPC(name,args);
  if(window.__test.inventoryDelay)await new Promise(resolve=>setTimeout(resolve,window.__test.inventoryDelay));
  if(window.__test.inventoryMissing)return {error:{code:'PGRST202',message:'schema cache missing'}};
  return (await fetch('/test-inventory-rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,name,args})})).json();
 };
}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  for(const mobile of [false,true])for(const role of ['owner','attendant']){
   db=await createTestDatabase();calls.length=0;
   if(role==='attendant')await callRPC(db,'owner','guigs_create_inventory',{p_shop_id:id(10),p_observation:'Inventário do atendente artificial'});
   const context=await browser.newContext({viewport:mobile?{width:390,height:700}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
   const external=[];const errors=[];
   await context.route('**/*',route=>{if(new URL(route.request().url()).hostname!=='127.0.0.1'){external.push(route.request().url());return route.abort();}return route.continue();});
   await context.addInitScript(fixture,{role,session:true});await context.addInitScript(inventoryClient,{role,shopId:id(10)});
   const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
   await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);await page.waitForSelector('#content:not(.hidden)');
   const click=selector=>mobile?page.locator(selector).tap():page.click(selector);
   const ready=()=>page.waitForFunction(()=>!document.getElementById('inventoryReload').disabled);
   const current=async()=> (await db.query('select * from public.guigs_inventories order by started_at desc limit 1')).rows[0];
   const items=async()=> (await db.query('select * from public.guigs_inventory_items order by product_name,location')).rows;
   const confirm=async()=>{await page.waitForSelector('#operationConfirmDialog[open]');await click('#confirmOperation');};
   check(calls.length===0,'RPCs de inventário não são consultadas fora da view');
   await click('#navInventory');await page.waitForSelector('#inventoryView:not(.hidden)');await page.waitForFunction(()=>document.getElementById('inventoryPage').textContent.includes('Página'));
   check(await page.getAttribute('#navInventory','aria-current')==='page','Navegação Inventário ativa');
   check(!await page.isVisible('#overviewView')&&!await page.isVisible('#historyView'),'Inventário em view própria');
   if(role==='owner'){
    await click('#newInventory');await page.fill('#inventoryObservation','Contagem artificial de teste');
    await page.evaluate(()=>window.__test.inventoryDelay=150);await click('#inventoryCreateSubmit');
    await page.dispatchEvent('#inventoryCreateForm','submit');await page.waitForSelector('#inventoryDetail:not(.hidden)');await ready();
    check(calls.filter(call=>call.name==='guigs_create_inventory').length===1,'Duplo envio de criação bloqueado');
   }else{
    check(!await page.isVisible('#newInventory'),'Atendente não cria inventário');
    await page.locator('#inventoryList button').first().click();await page.waitForSelector('#inventoryDetail:not(.hidden)');
   }
   check(await page.locator('.inventory-item').count()===4,'Snapshot UI com dois lotes e duas localizações');
   if(process.env.TEST_ARTIFACTS_DIR){fs.mkdirSync(process.env.TEST_ARTIFACTS_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.TEST_ARTIFACTS_DIR,`inventario-contagem-${role}-${mobile?'mobile':'desktop'}.png`),fullPage:true});}
   check(await page.locator('.inventory-item').first().textContent().then(text=>text.includes('Contagem cega')&&!text.includes('Esperado inicial')),'Contagem cega antes de registrar');
   await click('#inventoryItemSelectSearch');await page.fill('#inventoryItemSelectSearch','2103');
   check(await page.locator('#inventoryItemSelectOptions [role="option"]').count()===2,'Busca existente encontra lote nos dois locais');
   await page.keyboard.press('Enter');check(await page.locator('.inventory-item').count()===1,'Selecionar item pesquisado filtra cards');
   await page.selectOption('#inventoryItemSelect','',{force:true});
   await page.selectOption('#inventoryLocation','stock');check(await page.locator('.inventory-item').count()===2,'Filtro estoque seco');
   await page.selectOption('#inventoryLocation','fridge');check(await page.locator('.inventory-item').count()===2,'Filtro geladeira');
   await page.selectOption('#inventoryLocation','');
   const first=(await items()).find(item=>item.lot_id===id(30)&&item.location==='stock');
   const other=(await items()).find(item=>item.lot_id===id(30)&&item.location==='fridge');
   await page.locator(`[data-item-id="${other.id}"] input`).fill('7');
   await page.selectOption('#inventoryLocation','stock');await page.selectOption('#inventoryLocation','');
   check(await page.locator(`[data-item-id="${other.id}"] input`).inputValue()==='7','Rascunho não salvo permanece ao filtrar, sem escrita');
   await callRPC(db,'attendant','guigs_count_inventory_item',{p_shop_id:id(10),p_inventory_id:(await current()).id,p_item_id:other.id,p_quantity:8,p_version:other.version});
   await page.locator(`[data-item-id="${other.id}"] button[type="submit"]`).click();
   await page.waitForFunction(()=>document.getElementById('inventoryMessage').textContent.includes('outra pessoa'));await ready();
   check((await items()).find(item=>item.id===other.id).counted_quantity===8,'Contagem simultânea não é sobrescrita silenciosamente');
   await click('#inventoryReload');await ready();
   await page.waitForFunction(id=>!document.getElementById(`count-${id}`),other.id);
   const card=()=>page.locator(`[data-item-id="${first.id}"]`);
   await card().locator('input').fill('9');await card().locator('button[type="submit"]').click();
   await page.waitForFunction(()=>document.getElementById('inventoryMessage').textContent.includes('Contagem salva'));await ready();
   check((await db.query('select count(*)::int as n from public.guigs_movements')).rows[0].n===3,'Salvar contagem não altera estoque');
   await page.selectOption('#inventoryFilter','divergent');check(await page.locator('.inventory-item').count()===1,'Filtro de divergentes');
   check((await card().textContent()).includes('Diferença negativa'),'Diferença negativa claramente indicada');
   await page.selectOption('#inventoryFilter','counted');check(await page.locator('.inventory-item').count()===2,'Filtro de conferidos');
   await page.selectOption('#inventoryFilter','all');
   await card().getByRole('button',{name:'Recontar',exact:true}).click();await confirm();
   await page.waitForFunction(()=>document.getElementById('inventoryMessage').textContent.includes('Recontagem preparada'));await ready();
   check((await db.query("select previous_quantity from public.guigs_inventory_audit where action='recount'")).rows[0].previous_quantity===9,'Auditoria guarda contagem anterior');
   check((await card().textContent()).includes('Contagem cega'),'Recontagem retorna à contagem cega');
   // Movimento interveniente pelo mecanismo oficial, no banco artificial.
   await asUser(db,'owner',tx=>tx.query('select public.guigs_adjust_stock($1,$2,$3,$4,$5)',[id(10),id(30),'stock',11,'Movimento artificial no inventário UI']));
   await click('#inventoryReload');await page.waitForFunction(()=>!document.getElementById('inventoryMovementWarning').classList.contains('hidden'));
   check((await page.textContent('#inventoryMovementWarning')).includes('1 movimentação'),'Movimentos posteriores sinalizados');
   check((await card().textContent()).includes('Movimentado após'),'Produto/local afetado tem aviso');
   await card().getByRole('button',{name:'Recontar',exact:true}).click();await confirm();await ready();
   await page.waitForFunction(()=>document.querySelector('.inventory-count-input')!==null);
   await card().locator('input').fill('10');await card().locator('button[type="submit"]').click();await ready();
   await page.waitForFunction(()=>document.getElementById('inventoryMessage').textContent.includes('Contagem salva'));
   check((await (await items()).find(item=>item.id===first.id)).expected_initial===10,'Snapshot inicial não é sobrescrito no rebase');
   await page.selectOption('#inventoryFilter','all');await page.selectOption('#inventoryLocation','');
   for(const item of (await items()).filter(item=>item.counted_quantity===null)){
    const row=page.locator(`[data-item-id="${item.id}"]`);await row.locator('input').fill(String(item.basis_quantity));await row.locator('button[type="submit"]').click();await ready();
    await page.waitForFunction(id=>!document.getElementById(`count-${id}`),item.id);
    await page.selectOption('#inventoryFilter','all');
   }
   check((await page.textContent('#inventoryTotals')).includes('Pendentes: 0'),'Resumo não mistura unidades e mostra pendências');
   if(role==='owner'){
    await click('#inventoryReview');await page.waitForFunction(()=>document.getElementById('inventoryDetailTitle').textContent.includes('Em revisão'));await ready();
    check((await page.textContent('#inventoryDifferences')).includes('11 → contado 10'),'Revisão mostra base atual e diferença');
    check(await page.isDisabled('#inventoryComplete'),'Fechamento exige revisão explícita');
    if(process.env.TEST_ARTIFACTS_DIR)await page.screenshot({path:path.join(process.env.TEST_ARTIFACTS_DIR,`inventario-revisao-${mobile?'mobile':'desktop'}.png`),fullPage:true});
    await page.check('#inventoryReviewCheck');await click('#inventoryComplete');await page.waitForSelector('#operationConfirmDialog[open]');
    if(mobile)await page.setViewportSize({width:390,height:420});
    check(await page.locator('#operationConfirmDialog').evaluate(node=>node.getBoundingClientRect().height<=innerHeight),'Confirmação cabe na viewport reduzida');
    await click('#cancelOperation');await ready();check((await current()).status==='review','Cancelar confirmação não aplica ajustes');
    if(mobile)await page.setViewportSize({width:390,height:700});
    await context.setOffline(true);check(await page.isDisabled('#inventoryComplete'),'Offline bloqueia fechamento');
    await context.setOffline(false);await ready();await page.check('#inventoryReviewCheck');await click('#inventoryComplete');await confirm();
    await page.waitForFunction(()=>document.getElementById('inventoryDetailTitle').textContent.includes('Concluído'));await ready();
    check((await db.query("select count(*)::int as n from public.guigs_movements where note like 'Ajuste por inventário%'")).rows[0].n===1,'Fechamento gera ajuste oficial, somente após confirmação');
    check(await page.locator('.inventory-count-input').count()===0,'Concluído abre somente leitura');
    check((await page.textContent('#inventoryLastCompleted')).includes('Último concluído:'),'Último concluído no histórico');
    check((await page.textContent('#inventoryAudit')).includes('Fechamento'),'Auditoria de conclusão exibida');
    await click('#newInventory');await click('#inventoryCreateSubmit');await page.waitForFunction(()=>document.getElementById('inventoryDetailTitle').textContent.includes('Aberto'));await ready();
    await db.query("insert into public.guigs_lots(shop_id,product_id,code,expiry) values($1,$2,'NOVO-UI',current_date+100)",[id(10),id(20)]);
    await click('#inventoryReload');await page.waitForSelector('#inventoryScope:not(.hidden)');
    await click('#inventoryScope');await confirm();await page.waitForFunction(()=>document.getElementById('inventoryTotals').textContent.includes('Itens: 6'));await ready();
    check((await page.textContent('#inventoryItems')).includes('NOVO-UI'),'Novos lotes incluídos explicitamente para contagem');
    await click('#inventoryCancel');await confirm();await page.waitForFunction(()=>document.getElementById('inventoryDetailTitle').textContent.includes('Cancelado'));await ready();
    check((await current()).status==='cancelled','Cancelamento preservado no histórico');
   }else{
    check(!await page.isVisible('#inventoryReview')&&!await page.isVisible('#inventoryCancel')&&!await page.isVisible('#inventoryComplete'),'Atendente sem finalizar/revisar/cancelar');
    check(calls.every(call=>!['guigs_set_inventory_status','guigs_complete_inventory'].includes(call.name)),'Nenhuma chamada administrativa do atendente');
   }
   await context.setOffline(true);check(await page.isVisible('#inventoryOffline'),'Offline informa modo consulta');
   check(await page.locator('.inventory-count-input:enabled').count()===0,'Contagem offline bloqueada');
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Sem zoom ou scroll horizontal na página de inventário');
   await context.setOffline(false);await ready();
   await page.evaluate(()=>window.__test.inventoryMissing=true);await click('#inventoryReload');
   await page.waitForFunction(()=>document.getElementById('inventoryMessage').textContent.includes('migration 007'));
   check((await page.textContent('#inventoryMessage')).includes('não execute em produção'),'Ambiente sem migration tem erro claro sem aplicar SQL');
   await page.evaluate(()=>window.__test.inventoryMissing=false);
   await click('#navHistory');await page.waitForSelector('#historyView:not(.hidden)');await click('#navOverview');await page.waitForSelector('#overviewView:not(.hidden)');
   check(await page.isVisible('#products'),'Retorno às views antigas preservado');
   if(process.env.TEST_ARTIFACTS_DIR){fs.mkdirSync(process.env.TEST_ARTIFACTS_DIR,{recursive:true});await click('#navInventory');await page.screenshot({path:path.join(process.env.TEST_ARTIFACTS_DIR,`inventario-${role}-${mobile?'mobile':'desktop'}.png`),fullPage:true});}
   check(external.length===0,'Zero rede externa/produção');check(errors.length===0,`Sem erros JS: ${errors.join('; ')}`);
   await context.close();await rpcQueue;await db.close();db=null;
   console.log(`Inventário UI: ${role} / ${mobile?'mobile':'desktop'} aprovado.`);
  }
  console.log(`Inventário navegador: ${checks} verificações passaram; mocks e PGlite local.`);
 }finally{if(browser)await browser.close();if(db)await db.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
