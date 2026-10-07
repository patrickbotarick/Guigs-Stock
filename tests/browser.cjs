// UI real no Edge/Chromium; cliente Supabase simulado, sem credenciais ou dados reais.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const artifacts = process.env.TEST_ARTIFACTS_DIR;
let checks = 0;
const check = (value, message) => {assert.ok(value, message); checks++;};

function fixture({role, session}) {
  const user = {id: 'user-test', email: `${role}@test.invalid`};
  const product = {id: 'product-1', name: 'Coca-Cola 2L', category: 'Refrigerante', min_total: 1, target_total: 20, min_fridge: 1, target_fridge: 10, active: true};
  const lots = [
    {id: 'lot-a', product_id: product.id, code: 'LOTE-A', expiry: '2026-11-10', created_at: '2026-10-01T10:00:00Z', supplier_id: null},
    {id: 'lot-b', product_id: product.id, code: 'LOTE-B', expiry: '2026-12-10', created_at: '2026-10-02T10:00:00Z', supplier_id: 'supplier-1'}
  ];
  const suppliers = [{id: 'supplier-1', name: 'Distribuidora teste', active: true}, {id: 'supplier-off', name: 'Inativo teste', active: false}];
  const balances = [{lot_id:'lot-a', stock:10, fridge:0}, {lot_id:'lot-b', stock:10, fridge:0}];
  const calls = [];
  const listeners = [];
  const history = Array.from({length: 45}, (_, i) => ({id:`move-${i}`,lot_id:'lot-b',lot_code:'LOTE-B',product_id:product.id,product_name:product.name,movement_type:i%2?'sale':'receipt',location:'stock',delta:1,actor_id:user.id,actor_email:user.email,note:i===0?'Fornecedor: Distribuidora teste':'',created_at:'2026-10-07T12:00:00Z'}));
  window.__test = {calls, lots, suppliers, balances, history};
  function from(table) {
    const builder = {
      select() {return this;}, eq() {return this;}, range() {return this;},
      then(resolve, reject) {
        if (!navigator.onLine) return Promise.resolve({error: {message:'Failed to fetch'}}).then(resolve,reject);
        const data = table === 'guigs_memberships' ? [{shop_id:'shop-test',role,active:true}] :
          table === 'guigs_products' ? [product] : table === 'guigs_lots' ? lots : suppliers;
        return Promise.resolve({data:structuredClone(data),error:null}).then(resolve,reject);
      }
    };
    return builder;
  }
  window.__mockClient = {
    from,
    auth: {
      async getUser() {return navigator.onLine ? {data:{user},error:null} : {data:{user:null},error:{message:'Failed to fetch'}};},
      async getSession() {return {data:{session: session ? {user} : null}};},
      onAuthStateChange(callback) {listeners.push(callback);},
      async signInWithPassword() {session = true; for (const listener of listeners) listener('SIGNED_IN',{user}); return {error:null};},
      async signOut() {session = false; return {error:null};}
    },
    async rpc(name,args) {
      calls.push({name,args:structuredClone(args)});
      if (!navigator.onLine) return {error:{message:'Failed to fetch'}};
      let data;
      if (name === 'guigs_get_lot_balances') data = structuredClone(balances);
      else if (name === 'guigs_get_history_actors') data = [{actor_id:user.id,actor_email:user.email}];
      else if (name === 'guigs_get_history') {
        let selected = history.filter(m => (!args.p_product || m.product_id===args.p_product) && (!args.p_type || m.movement_type===args.p_type) && (!args.p_actor || m.actor_id===args.p_actor) && (!args.p_date_from || m.created_at>=args.p_date_from) && (!args.p_date_to || m.created_at<=args.p_date_to) && (!args.p_search || [m.product_name,m.lot_code,m.note].some(s => s.includes(args.p_search))));
        data = selected.slice(args.p_offset,args.p_offset+args.p_limit).map(m => ({...m,total_count:selected.length}));
      } else if (name === 'guigs_create_supplier') {
        data = `supplier-${suppliers.length+1}`;
        suppliers.push({id:data,name:args.p_name,active:args.p_active});
      } else if (name === 'guigs_update_supplier') {
        Object.assign(suppliers.find(s => s.id===args.p_supplier_id),{name:args.p_name,active:args.p_active}); data = true;
      } else if (name === 'guigs_receive_stock') {
        const id = `lot-${lots.length+1}`;
        lots.push({id,product_id:args.p_product_id,code:args.p_lot_code,expiry:args.p_expiry,supplier_id:args.p_supplier_id,created_at:new Date().toISOString()});
        balances.push({lot_id:id,stock:args.p_quantity,fridge:0});
        data = {success:true,quantity:args.p_quantity,lot_id:id};
      } else if (name === 'guigs_get_fefo_candidates') {
        if (window.__test.fefoDelay) await new Promise(resolve => setTimeout(resolve, window.__test.fefoDelay));
        if (window.__test.fefoError) return {error:{message:'Consulta FEFO indisponível'}};
        const selected = lots.find(l => l.id===args.p_lot_id);
        data = lots.filter(l => l.id!==selected.id && l.product_id===selected.product_id && (l.expiry<selected.expiry || (l.expiry===selected.expiry && l.created_at<selected.created_at)) && balances.find(b=>b.lot_id===l.id)?.stock>0)
          .sort((a,b) => a.expiry.localeCompare(b.expiry)||a.created_at.localeCompare(b.created_at))
          .map(l => ({...l,lot_id:l.id,stock:balances.find(b=>b.lot_id===l.id).stock}));
      } else if (name === 'guigs_transfer_stock') {
        const b = balances.find(b => b.lot_id===args.p_lot_id);
        if (b[args.p_from_location]<args.p_quantity) return {error:{message:'Saldo insuficiente'}};
        b[args.p_from_location]-=args.p_quantity; b[args.p_to_location]+=args.p_quantity;
        data = {success:true,quantity:args.p_quantity};
      }
      return {data,error:null};
    }
  };
}

(async () => {
  // Lista explícita; config.js real nunca é lido nem servido.
  const files = ['index.html','auth-preview.html','reset-password.html','cloud-dashboard.js','auth-preview.js','reset-password.js','pwa.js','service-worker.js','manifest.webmanifest','logo-guigs.png'];
  const server = http.createServer((req,res) => {
    const file = new URL(req.url,'http://localhost').pathname.slice(1) || 'index.html';
    res.setHeader('Cache-Control','no-store');
    if (file==='config.js') {res.setHeader('Content-Type','text/javascript'); return res.end('window.GUIGS_SUPABASE_CONFIG={url:"https://test.supabase.co",publishableKey:"sb_publishable_TEST"};');}
    if (file==='tests-fake-client.js') {res.setHeader('Content-Type','text/javascript'); return res.end('export const createClient=()=>window.__mockClient;');}
    if (!files.includes(file) && !/^icons\/guigs-stock-(192|512|maskable-512)\.png$/.test(file)) {res.statusCode=404; return res.end();}
    let contents = fs.readFileSync(path.join(root,file));
    if (file.endsWith('.js')) contents = contents.toString().replace(/https:\/\/esm\.sh\/@supabase\/supabase-js@2/g,'./tests-fake-client.js');
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.png')?'image/png':'application/json');
    res.end(contents);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
    const context = await browser.newContext({viewport:{width:1440,height:900}});
    await context.addInitScript(fixture,{role:'owner',session:false});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if (message.type()==='error') errors.push(message.text());});
    await page.goto(`${base}/auth-preview.html`);
    await page.fill('#email','owner@test.invalid'); await page.fill('#password','test-only');
    await page.click('#enter');
    await page.waitForURL('**/index.html');
    await page.waitForSelector('#content:not(.hidden)');
    check((await page.textContent('#identity')).includes('Proprietário'), 'Login owner e dashboard');
    check(await page.isVisible('#overviewView') && !await page.isVisible('#historyView'), 'Overview inicial sem histórico');
    check((await page.textContent('#lots')).includes('Fornecedor: Não informado') && (await page.textContent('#lots')).includes('Fornecedor: Distribuidora teste'), 'Lotes novos/antigos exibem fornecedor');
    check(await page.evaluate(() => getComputedStyle(document.querySelector('.side')).position==='fixed'), 'Sidebar desktop fixa');
    const sideY = await page.evaluate(() => document.querySelector('.side').getBoundingClientRect().y);
    await page.evaluate(() => window.scrollTo(0,document.body.scrollHeight));
    check(await page.evaluate(() => document.querySelector('.side').getBoundingClientRect().y)===sideY, 'Sidebar permanece fixa com scroll');
    await page.click('#navHistory');
    check(await page.isVisible('#historyView') && !await page.isVisible('#overviewView'), 'Navegação para Histórico');
    check(await page.getAttribute('#navHistory','aria-current')==='page', 'Menu ativo acessível');
    check((await page.textContent('#page')).includes('1/3') && await page.locator('#history tr').count()===20, 'Histórico pagina 20 de 45');
    await page.click('#next');
    await page.waitForFunction(() => document.getElementById('page').textContent.startsWith('2/3'));
    check(await page.evaluate(() => window.__test.calls.filter(c=>c.name==='guigs_get_history').at(-1).args.p_offset)===20, 'Paginação envia offset ao servidor');
    await page.selectOption('#historyType','sale');
    await page.waitForFunction(() => document.getElementById('page').textContent.includes('22 lançamentos'));
    check(await page.locator('#history .movement-type.sale').count()===20, 'Filtro tipo preservado');
    await page.selectOption('#historyProduct','product-1');
    await page.selectOption('#historyActor','user-test');
    await page.fill('#historyDateFrom','2026-10-01'); await page.dispatchEvent('#historyDateFrom','change');
    await page.fill('#historyDateTo','2026-10-08'); await page.dispatchEvent('#historyDateTo','change');
    check(await page.evaluate(() => window.__test.calls.filter(c=>c.name==='guigs_get_history').at(-1).args.p_actor)==='user-test', 'Filtros produto/responsável/data enviados');
    await page.click('#clearHistoryFilters');
    await page.fill('#search','Distribuidora teste');
    await page.waitForFunction(() => document.getElementById('page').textContent.includes('1 lançamentos'));
    check((await page.textContent('#history')).includes('Fornecedor: Distribuidora teste'), 'Busca e contexto do recebimento');
    await page.click('#navOverview');
    check(await page.isVisible('#overviewView') && !await page.isVisible('#historyView'), 'Retorno à Visão geral');
    await page.click('#navHistory');
    check(await page.inputValue('#search')==='Distribuidora teste', 'Filtros preservados entre views');
    if (artifacts) {fs.mkdirSync(artifacts,{recursive:true}); await page.screenshot({path:path.join(artifacts,'historico-desktop.png'),fullPage:true});}
    await page.click('#navOverview');

    await page.click('#receiveStock');
    check(await page.locator('#receiveSupplier option').count()===2, 'Lista somente fornecedores ativos');
    await page.click('#newReceiveSupplier');
    await page.fill('#supplierName','Fornecedor novo'); await page.click('#saveSupplier');
    await page.waitForFunction(() => !document.getElementById('supplierDialog').open);
    check(await page.inputValue('#receiveSupplier')==='supplier-3', 'Novo fornecedor selecionado no recebimento');
    await page.fill('#lotCode','LOTE-C'); await page.fill('#expiry','2027-01-10'); await page.fill('#receiveQuantity','3');
    await page.click('#saveReceipt');
    await page.waitForFunction(() => !document.getElementById('receiveDialog').open);
    check((await page.textContent('#lots')).includes('Fornecedor: Fornecedor novo'), 'Receber e visualizar fornecedor');
    check(await page.evaluate(() => window.__test.calls.find(c=>c.name==='guigs_receive_stock').args.p_supplier_id)==='supplier-3', 'Recebimento envia supplier_id');
    await page.click('#manageSuppliers'); await page.selectOption('#supplierSelect','supplier-3');
    await page.selectOption('#supplierActive','false'); await page.click('#saveSupplier');
    await page.waitForFunction(() => !document.getElementById('supplierDialog').open);
    await page.click('#receiveStock');
    check(!(await page.textContent('#receiveSupplier')).includes('Fornecedor novo'), 'Fornecedor inativo sai do recebimento');
    await page.click('[data-close="receiveDialog"]');

    const transfers = () => page.evaluate(() => window.__test.calls.filter(c=>c.name==='guigs_transfer_stock').length);
    const openB = async () => {await page.click('#transferStock'); await page.selectOption('#transferLot','lot-b'); await page.fill('#transferQuantity','5');};
    await openB(); await page.click('#saveTransfer');
    await page.waitForSelector('#fefoDialog[open]');
    check((await page.textContent('#fefoCandidates')).includes('LOTE-A') && (await page.textContent('#fefoCandidates')).includes('10 unidades'), 'Aviso FEFO identifica lote A e saldo');
    if (artifacts) await page.screenshot({path:path.join(artifacts,'fefo-desktop.png')});
    await page.click('#cancelFefo');
    await page.waitForFunction(() => !document.getElementById('saveTransfer').disabled);
    check(await transfers()===0, 'Cancelar FEFO não movimenta');
    await page.click('#saveTransfer'); await page.waitForSelector('#fefoDialog[open]'); await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('saveTransfer').disabled);
    check(await transfers()===0, 'Esc cancela sem escrita');
    await page.click('#saveTransfer'); await page.waitForSelector('#fefoDialog[open]'); await page.click('#continueFefo');
    await page.waitForFunction(() => !document.getElementById('transferDialog').open);
    check(await transfers()===1, 'Continuar movimenta uma única vez');
    check(await page.evaluate(() => {const b=window.__test.balances.find(b=>b.lot_id==='lot-b'); return b.stock===5 && b.fridge===5; }), 'Saldo B após mover 5');
    await page.evaluate(() => window.__test.balances.find(b=>b.lot_id==='lot-a').stock=0);
    await openB(); await page.fill('#transferQuantity','1'); await page.click('#saveTransfer');
    await page.waitForFunction(() => !document.getElementById('transferDialog').open);
    check(!await page.isVisible('#fefoDialog') && await transfers()===2, 'Lote A com seco zero não alerta');
    await page.click('#transferStock'); await page.selectOption('#transferDirection','fridge-stock');
    const fefoQueries = await page.evaluate(() => window.__test.calls.filter(c=>c.name==='guigs_get_fefo_candidates').length);
    await page.click('#saveTransfer'); await page.waitForFunction(() => !document.getElementById('transferDialog').open);
    check(await page.evaluate(() => window.__test.calls.filter(c=>c.name==='guigs_get_fefo_candidates').length)===fefoQueries, 'Retorno geladeira não consulta FEFO');
    await openB(); await page.evaluate(() => window.__test.fefoError=true); const countBeforeError=await transfers();
    await page.click('#saveTransfer'); await page.waitForFunction(() => document.getElementById('transferMessage').textContent.includes('indisponível'));
    check(await transfers()===countBeforeError, 'Falha FEFO permite tentar novamente sem movimentação silenciosa');
    await page.click('[data-close="transferDialog"]'); await page.evaluate(() => window.__test.fefoError=false);

    await openB(); await page.fill('#transferQuantity','1');
    await page.evaluate(() => window.__test.fefoDelay=300);
    const countBeforeCancel=await transfers();
    await page.click('#saveTransfer'); await page.click('[data-close="transferDialog"]');
    await page.waitForFunction(() => !document.getElementById('saveTransfer').disabled);
    check(await transfers()===countBeforeCancel && !await page.isVisible('#fefoDialog'), 'Cancelar enquanto consulta FEFO aguarda não executa transferência');
    await page.evaluate(() => window.__test.fefoDelay=0);

    await page.evaluate(() => window.__test.balances.find(b=>b.lot_id==='lot-a').stock=10);
    await openB(); await page.fill('#transferQuantity','1'); await page.click('#saveTransfer'); await page.waitForSelector('#fefoDialog[open]');
    const countBeforeOffline=await transfers();
    await context.setOffline(true); await page.click('#continueFefo');
    await page.waitForFunction(() => document.getElementById('transferMessage').textContent.includes('internet'));
    check(await transfers()===countBeforeOffline, 'Perda de conexão durante confirmação FEFO não envia escrita');
    await context.setOffline(false); await page.waitForFunction(() => document.getElementById('status').textContent.includes('sincronizado'));
    await page.click('[data-close="transferDialog"]');

    await page.setViewportSize({width:390,height:844});
    check(await page.evaluate(() => getComputedStyle(document.querySelector('.side')).position==='static'), 'Sidebar mobile não ocupa lateral');
    check(await page.evaluate(() => document.documentElement.scrollWidth<=window.innerWidth), 'Sem scroll horizontal na página mobile');
    await page.click('#navHistory');
    check(await page.isVisible('#historyView') && await page.isVisible('#navOverview'), 'Histórico acessível no celular');
    if (artifacts) await page.screenshot({path:path.join(artifacts,'historico-mobile.png'),fullPage:true});
    await page.click('#navOverview');
    check(await page.isVisible('#overviewView'), 'Retorno mobile');
    await openB(); await page.fill('#transferQuantity','1'); await page.click('#saveTransfer'); await page.waitForSelector('#fefoDialog[open]');
    check(await page.isVisible('#cancelFefo') && await page.isVisible('#continueFefo'), 'Ações FEFO acessíveis mobile');
    if (artifacts) await page.screenshot({path:path.join(artifacts,'fefo-mobile.png')});
    await page.click('#cancelFefo'); await page.click('[data-close="transferDialog"]');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    check(await page.evaluate(async () => (await caches.keys()).includes('guigs-stock-shell-v6')), 'Novo cache PWA instalado');
    await context.setOffline(true);
    await page.waitForFunction(() => document.getElementById('receiveStock').disabled);
    check((await page.textContent('#status')).includes('sem conexão'), 'Offline informa indisponibilidade e desabilita operações');
    check(await page.isDisabled('#manageSuppliers'), 'Fornecedores desabilitados offline');
    await context.setOffline(false);
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('sincronizado'));
    check(!await page.isDisabled('#receiveStock'), 'Online restaura operações');
    await page.goto(`${base}/index.html#historico`); await page.waitForSelector('#content:not(.hidden)');
    check(await page.isVisible('#historyView'), 'Link direto por hash');
    await context.setOffline(true);
    await page.goto(`${base}/auth-preview.html`);
    check((await page.textContent('#message')).includes('sem conexão'), 'Login offline abre pelo cache e informa limitação');
    await context.setOffline(false);
    await context.close();

    const attendantContext = await browser.newContext({viewport:{width:1280,height:800}});
    await attendantContext.addInitScript(fixture,{role:'attendant',session:false});
    const attendant = await attendantContext.newPage(); attendant.on('pageerror',e=>errors.push(e.message));
    await attendant.goto(`${base}/auth-preview.html`); await attendant.fill('#email','attendant@test.invalid'); await attendant.fill('#password','test-only'); await attendant.click('#enter');
    await attendant.waitForURL('**/index.html'); await attendant.waitForSelector('#content:not(.hidden)');
    check((await attendant.textContent('#identity')).includes('Atendente'), 'Login attendant');
    check(!await attendant.isVisible('#manageSuppliers') && !await attendant.isVisible('#newProduct'), 'Atendente sem controles administrativos');
    await attendant.click('#receiveStock');
    check(await attendant.isVisible('#receiveSupplier') && !await attendant.isVisible('#newReceiveSupplier'), 'Atendente seleciona, sem cadastrar fornecedor');
    await attendant.selectOption('#receiveSupplier','supplier-1'); await attendant.fill('#lotCode','ATENDENTE'); await attendant.fill('#expiry','2027-02-10'); await attendant.click('#saveReceipt');
    await attendant.waitForFunction(() => !document.getElementById('receiveDialog').open);
    check(await attendant.evaluate(() => window.__test.calls.some(c=>c.name==='guigs_receive_stock')), 'Recebimento por atendente');
    await attendantContext.close();
    check(errors.length===0, `Console sem erros críticos: ${errors.join('; ')}`);
    console.log(`Navegador: ${checks} verificações passaram (owner, attendant, desktop, mobile, FEFO e PWA).`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error => {console.error(error); process.exitCode=1;});
