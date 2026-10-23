// SDK simulado e RPC de relatório encaminhada exclusivamente ao PGlite local.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const {fixture}=require('./browser.cjs');const {seed,report,id}=require('./reports-support.cjs');
let checks=0,db,queue=Promise.resolve();const calls=[];
const check=(value,message)=>{assert.ok(value,message);checks++;};
const root=path.resolve(__dirname,'..');
const allowed=['index.html','cloud-dashboard.js','inventory.js','reports.js','pwa.js','manifest.webmanifest','logo-guigs.png'];
const server=http.createServer(async(req,res)=>{
 const file=new URL(req.url,'http://localhost').pathname.slice(1);
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/json');
 if(file==='test-report'&&req.method==='POST'){
  let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);calls.push(request);
  const run=queue.then(()=>report(db,request.role,request.args));queue=run.catch(()=>{});
  try{res.end(JSON.stringify({data:await run,error:null}));}catch(error){res.end(JSON.stringify({data:null,error:{message:error.message,code:error.code}}));}return;
 }
 if(file==='config.js')return res.end('window.GUIGS_SUPABASE_CONFIG={url:"https://test.supabase.co",publishableKey:"sb_publishable_TEST"};');
 if(file==='fake.js')return res.end('export const createClient=()=>window.__mockClient;');
 if(!allowed.includes(file)){res.statusCode=404;return res.end();}
 let content=fs.readFileSync(path.join(root,file));if(file.endsWith('.js'))content=content.toString().replace('https://esm.sh/@supabase/supabase-js@2','./fake.js');res.end(content);
});
function reportsClient({role,shopId}) {
 const oldFrom=window.__mockClient.from,oldRPC=window.__mockClient.rpc;
 window.__mockClient.from=table=>table==='guigs_memberships'?{select(){return this;},eq(){return this;},then(resolve,reject){return Promise.resolve({data:[{shop_id:shopId,role,active:true}],error:null}).then(resolve,reject);}}:oldFrom(table);
 window.__mockClient.rpc=async(name,args)=>{
  if(name!=='guigs_get_reports')return oldRPC(name,args);
  if(window.__test.reportMissing)return {error:{code:'PGRST202',message:'missing'}};
  if(window.__test.reportDelay)await new Promise(resolve=>setTimeout(resolve,window.__test.reportDelay));
  return (await fetch('/test-report',{method:'POST',body:JSON.stringify({role,args})})).json();
 };
}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try {
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  for(const mobile of [false,true])for(const role of ['owner','attendant']) {
   db=await seed();calls.length=0;
   const context=await browser.newContext({viewport:mobile?{width:390,height:700}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile,timezoneId:'America/Sao_Paulo',serviceWorkers:'block',acceptDownloads:true});
   const external=[],errors=[];
   await context.route('**/*',route=>{if(new URL(route.request().url()).hostname!=='127.0.0.1'){external.push(route.request().url());return route.abort();}return route.continue();});
   await context.addInitScript(fixture,{role,session:true});await context.addInitScript(reportsClient,{role,shopId:id(10)});
   const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
   await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);await page.waitForSelector('#content:not(.hidden)');
   check(calls.length===0,'Relatórios consultados somente na própria view');
   const ready=()=>page.waitForFunction(()=>!document.getElementById('reportsReload').disabled);
   const click=selector=>mobile?page.locator(selector).tap():page.click(selector);
   if(role==='attendant') {
    check(!await page.isVisible('#navReports'),'Atendente sem entrada gerencial');
    await page.evaluate(()=>location.hash='#relatorios');await page.waitForFunction(()=>document.getElementById('reportsMessage').textContent.includes('apenas ao proprietário'));
    check(calls.length===0,'Hash direto de atendente não chama relatório');
    await page.evaluate(()=>document.getElementById('reportsReload').dispatchEvent(new Event('click')));
    await page.evaluate(()=>document.getElementById('reportsExport').dispatchEvent(new Event('click')));
    check(calls.length===0&&await page.locator('#reportsSummary .report-card').count()===0,'Manipulação do DOM não carrega dados');
   }else {
    await click('#navReports');await page.waitForSelector('#reportsView:not(.hidden)');await ready();
    check(await page.getAttribute('#navReports','aria-current')==='page','View e navegação por hash');
    check(!await page.isVisible('#overviewView')&&!await page.isVisible('#historyView')&&!await page.isVisible('#inventoryView'),'View de relatórios independente');
    await page.fill('#reportsFrom','2026-10-01');await page.fill('#reportsTo','2026-10-31');await click('#reportsReload');await ready();
    check((await page.textContent('#reportsSummary')).includes('125 unidades · 3 operações'),'Resumo distingue unidades e operações');
    check((await page.textContent('#reportsSummary')).includes('7 unidades · 2 operações'),'Transferência não dobra unidades/contagens');
    check((await page.textContent('#reportsSummary')).includes('3 unidades de variação líquida'),'Ajuste líquido identificado');
    check((await page.textContent('#reportsSales')).includes('COCA COLA 2L'),'Ranking de saídas');
    check((await page.textContent('#reportsLosses')).includes('L3-2103')&&(await page.textContent('#reportsLosses')).includes('avaria'),'Perda com lote e observação');
    check((await page.textContent('#reportsLossRanking')).includes('3 unidades'),'Ranking de perdas');
    check((await page.textContent('#reportsSuppliers')).includes('BEBIDAS ÁGUA')&&(await page.textContent('#reportsSuppliers')).includes('Não informado'),'Fornecedor histórico e legado');
    check(!(await page.textContent('#reportsSuppliers')).includes('Nome atual diferente'),'Sem reatribuir fornecedor atual ao passado');
    check((await page.textContent('#reportsActivity')).includes('Movimentações: 2'),'Atividade conta operações');
    check((await page.textContent('#reportsInventories')).includes('Concluído')&&(await page.textContent('#reportsInventories')).includes('Cancelado'),'Estados de inventário');
    check((await page.textContent('#reportsInventories')).includes('Divergentes: 1'),'Divergências históricas');
    check((await page.textContent('#reportsStockDate')).includes('não é fotografia do período'),'Fotografia atual explicitada');
    for(const label of ['Vencidos','Vencem em até 15 dias','Vencem entre 16–30 dias','Acima de 30 dias'])check((await page.textContent('#reportsExpiry')).includes(label),`Faixa ${label}`);
    const buckets=await page.locator('#reportsExpiry .report-card').allTextContents();
    check(buckets[0].includes('1 lote · 1 unidade')&&buckets[1].includes('2 lotes · 2 unidades')&&buckets[2].includes('2 lotes · 2 unidades'),'Limites -1,0,15,16,30 e lote zero excluído');
    check((await page.textContent('#reportsRestock')).includes('Abaixo do mínimo total')&&(await page.textContent('#reportsRestock')).includes('Abaixo do mínimo da geladeira'),'Mínimos do cadastro');
    check((await page.textContent('#reportsRestock')).includes('Reposição sugerida: 17 unidades'),'Reposição usa regra da visão geral');
    check((await page.textContent('#reportsRestock')).includes('faltam 10 unidades'),'Reposição insuficiente exclui seco vencido');
    const downloadPromise=page.waitForEvent('download');await click('#reportsExport');const download=await downloadPromise;
    const stream=await download.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);const csv=Buffer.concat(chunks).toString('utf8');
    check(csv.startsWith('\ufeff')&&csv.includes('Responsável')&&csv.includes('2026-10-01'),'CSV UTF8/acento/período');
    check(csv.includes("'=SUM")&&csv.includes('""avaria""'),'CSV protege fórmula e escapa aspas');
    check(!csv.includes(id(30))&&!csv.includes('actor_id'),'CSV sem UUIDs técnicos');
    if(process.env.TEST_ARTIFACTS_DIR){
     fs.mkdirSync(process.env.TEST_ARTIFACTS_DIR,{recursive:true});
     await page.evaluate(()=>window.scrollTo(0,0));
     await page.screenshot({path:path.join(process.env.TEST_ARTIFACTS_DIR,`relatorios-${mobile?'mobile':'desktop'}.png`),fullPage:true});
     await page.screenshot({path:path.join(process.env.TEST_ARTIFACTS_DIR,`relatorios-${mobile?'mobile':'desktop'}-topo.png`)});
     await page.locator('#reportsStockDate').locator('..').screenshot({path:path.join(process.env.TEST_ARTIFACTS_DIR,`relatorios-${mobile?'mobile':'desktop'}-estoque.png`)});
    }
    await db.query(`insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,created_at)
      select $1,$2,gen_random_uuid(),'loss','stock',-1,$3,'Página artificial','2026-10-15T12:00:00Z'::timestamptz+n*interval '1 second' from generate_series(1,51)n`,[id(10),id(30),id(1)]);
    await db.query(`insert into public.guigs_inventories(shop_id,status,started_by,started_at,cancelled_at,start_movement_count)
      select $1,'cancelled',$2,'2026-10-14T12:00:00Z'::timestamptz+n*interval '1 second','2026-10-15T12:00:00Z'::timestamptz+n*interval '1 second',0 from generate_series(1,51)n`,[id(10),id(1)]);
    await page.evaluate(()=>window.__test.reportDelay=150);const beforeReload=calls.length;
    await click('#reportsReload');await page.evaluate(()=>document.getElementById('reportsReload').dispatchEvent(new Event('click')));await ready();
    check(calls.length===beforeReload+1,'Uma consulta pendente por vez');
    await page.evaluate(()=>window.__test.reportDelay=0);
    check(await page.locator('#reportsLosses .report-card').count()===50,'Página de perdas limitada a 50');
    await click('#reportsLossNext');await ready();
    check(await page.locator('#reportsLosses .report-card').count()===2&&(await page.textContent('#reportsLossPage')).includes('Página 2'),'Próxima página de perdas');
    const downloadNext=page.waitForEvent('download');await click('#reportsExport');
    check((await downloadNext).suggestedFilename().includes('pagina-2'),'CSV identifica página filtrada');
    await click('#reportsLossPrevious');await ready();
    check((await page.textContent('#reportsLossPage')).includes('Página 1'),'Página anterior de perdas');
    await click('#reportsInventoryNext');await ready();
    check(await page.locator('#reportsInventories .report-card').count()===3&&(await page.textContent('#reportsInventoryPage')).includes('Página 2'),'Paginação de inventários independente');
    check((await page.textContent('#reportsLossPage')).includes('Página 1'),'Página do inventário não altera perdas');
    await click('#reportsInventoryPrevious');await ready();
    for(const period of ['today','7','30','month','previous']) {
     await page.selectOption('#reportsPeriod',period);check(await page.isDisabled('#reportsExport'),'Filtro pendente bloqueia exportação');await click('#reportsReload');await ready();
     const request=calls.at(-1).args;
     check(new Date(request.p_to)>new Date(request.p_from),`Intervalo rápido ${period}`);
     check(request.p_from.endsWith('03:00:00.000Z')&&request.p_to.endsWith('03:00:00.000Z'),'Dias completos no fuso local');
    }
    await page.fill('#reportsFrom','2025-01-01');await page.fill('#reportsTo','2025-01-02');await click('#reportsReload');await ready();
    check((await page.textContent('#reportsSummary')).includes('Nenhuma operação registrada'),'Resumo vazio com contexto');
    check((await page.textContent('#reportsLosses')).includes('Nenhuma perda registrada')&&(await page.textContent('#reportsSuppliers')).includes('Nenhum recebimento registrado'),'Empty states por seção');
    check(await page.isDisabled('#reportsExport'),'Sem CSV vazio');
    check((await page.textContent('#reportsExpiry')).includes('Vencidos'),'Fotografia atual preservada no período vazio');
    const count=calls.length;await page.fill('#reportsFrom','2026-10-20');await page.fill('#reportsTo','2026-10-01');await click('#reportsReload');
    check(calls.length===count&&(await page.textContent('#reportsMessage')).includes('posterior'),'Intervalo invertido bloqueado');
    await page.fill('#reportsFrom','2026-10-01');await page.fill('#reportsTo','2026-10-31');await click('#reportsReload');await ready();
    await page.evaluate(()=>window.__test.reportMissing=true);await click('#reportsReload');await ready();
    check((await page.textContent('#reportsMessage')).includes('indisponíveis neste ambiente')&&await page.isDisabled('#reportsExport'),'Migration ausente com erro claro e sem exportar dados antigos');
    await page.evaluate(()=>window.__test.reportMissing=false);await click('#reportsReload');await ready();
    const displayed=await page.textContent('#reportsSummary');await context.setOffline(true);await page.evaluate(()=>window.dispatchEvent(new Event('offline')));
    check(await page.isVisible('#reportsOffline')&&await page.isDisabled('#reportsReload')&&await page.isDisabled('#reportsExport'),'Offline bloqueia atualizar/exportar');
    check(await page.textContent('#reportsSummary')===displayed,'Offline mantém leitura já renderizada');
    const offlineCalls=calls.length;await page.evaluate(()=>document.getElementById('reportsReload').dispatchEvent(new Event('click')));
    check(calls.length===offlineCalls,'Clique artificial offline sem RPC');
    await context.setOffline(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await ready();
    check(await page.evaluate(()=>localStorage.length===0),'Sem persistência local dos relatórios');
    await db.exec('delete from public.guigs_movements');await click('#reportsReload');await ready();
    check((await page.textContent('#reportsExpiry')).includes('Nenhum lote com saldo atual'),'Estoque vazio não cria risco de validade');
    check((await page.textContent('#reportsExpiryNote')).includes('Nenhum lote próximo'),'Empty state de validade');
   }
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Sem scroll horizontal global');
   check(errors.length===0,`Sem erros JS: ${errors}`);check(external.length===0,'Nenhum acesso externo');
   await context.close();await queue;await db.close();db=null;
  }
  console.log(`Relatórios navegador: ${checks} verificações passaram.`);
 }finally{if(db)await db.close();if(browser)await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
