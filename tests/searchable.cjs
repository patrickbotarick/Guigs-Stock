// Somente DOM e Supabase simulado. Todas as requisições externas são bloqueadas.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const {fixture} = require('./browser.cjs');
let checks = 0;
const check = (value, message) => {assert.ok(value, message); checks++;};
const root = path.resolve(__dirname, '..');
const allowed = ['index.html','cloud-dashboard.js','pwa.js','manifest.webmanifest','logo-guigs.png'];
const server = http.createServer((req, res) => {
  const file = new URL(req.url, 'http://localhost').pathname.slice(1);
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'application/json');
  if (file === 'config.js') return res.end('window.GUIGS_SUPABASE_CONFIG={url:"https://test.supabase.co",publishableKey:"sb_publishable_TEST"};');
  if (file === 'fake.js') return res.end('export const createClient=()=>window.__mockClient;');
  if (!allowed.includes(file)) {res.statusCode = 404; return res.end();}
  let contents = fs.readFileSync(path.join(root, file));
  if (file.endsWith('.js')) contents = contents.toString().replace('https://esm.sh/@supabase/supabase-js@2', './fake.js');
  res.end(contents);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
    for (const mobile of [false, true]) {
      const context = await browser.newContext({viewport:mobile ? {width:390,height:700} : {width:1440,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
      const external = [];
      const errors = [];
      await context.route('**/*', route => {
        if (new URL(route.request().url()).hostname !== '127.0.0.1') {external.push(route.request().url()); return route.abort();}
        return route.continue();
      });
      await context.addInitScript(fixture, {role:'owner',session:true,searchable:true,readOnly:true});
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
      await page.waitForSelector('#content:not(.hidden)');
      const click = async locator => mobile ? locator.tap() : locator.click();
      const open = async id => {await click(page.locator(`#${id}Search`));};
      const rows = id => page.locator(`#${id}Options [role="option"]`);
      const filter = async (id, term) => {await open(id); await page.fill(`#${id}Search`,term);};
      await click(page.locator('#editProduct'));
      check(await page.locator('#editProductDialog label').allTextContents().then(labels => labels.filter(s => s==='Mínimo na geladeira').length===1), 'Rótulo mínimo sem duplicação');
      check(await page.locator('label[for="editTargetFridge"]').textContent()==='Meta na geladeira', 'Rótulo meta correto');
      check(await page.inputValue('#editMinFridge')==='1' && await page.inputValue('#editTargetFridge')==='10', 'Inputs mantêm min_fridge e target_fridge');
      await filter('editProductSelect','uVa');
      check(await rows('editProductSelect').count()===1, 'Busca de produto ignora caixa');
      await page.keyboard.press('Enter');
      check(await page.inputValue('#editProductSelect')==='product-2', 'Enter mantém product_id');
      check(await page.inputValue('#editProductName')==='SUCO UVA 1L', 'Change preenche produto escolhido');
      await click(page.locator('[data-close="editProductDialog"]'));

      await click(page.locator('#receiveStock'));
      await filter('receiveProduct','coca');
      check(await rows('receiveProduct').count()===2, 'Coca encontra as variantes');
      await page.fill('#receiveProductSearch','COCA');
      check(await rows('receiveProduct').count()===2, 'Coca ignora caixa');
      await page.fill('#receiveProductSearch','');
      check(await rows('receiveProduct').count()===80, 'Limpar restaura todos os produtos ativos');
      check(await page.locator('#receiveProductOptions').evaluate(e=>e.scrollHeight>e.clientHeight), 'Lista longa tem scroll');
      if (mobile) {
        const box = await page.locator('#receiveProductOptions').boundingBox();
        const cdp = await context.newCDPSession(page);
        const touch = (type,y) => cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd' ? [] : [{x:box.x+box.width/2,y}]});
        await touch('touchStart',box.y+box.height-20);
        for (let delta=30; delta<box.height-20; delta+=20) await touch('touchMove',box.y+box.height-delta);
        await touch('touchEnd',0);
        check(await page.getAttribute('#receiveProductSearch','aria-expanded')==='true', 'Gesto de scroll mantém lista aberta');
        check(await page.locator('#receiveProductOptions').evaluate(e=>e.scrollTop>0), 'Gesto de toque rola lista');
        await cdp.detach();
      }
      if (process.env.TEST_ARTIFACTS_DIR) {
        fs.mkdirSync(process.env.TEST_ARTIFACTS_DIR,{recursive:true});
        await page.screenshot({path:path.join(process.env.TEST_ARTIFACTS_DIR,`seletores-${mobile ? 'mobile' : 'desktop'}.png`)});
      }
      await page.fill('#receiveProductSearch','agua');
      check(await rows('receiveProduct').count()===77, 'Busca ignora acentos');
      await page.fill('#receiveProductSearch','zzzz');
      check(await page.locator('#receiveProductOptions [role="status"]').textContent()==='Nenhum resultado encontrado', 'Busca vazia informa resultado');
      await page.keyboard.press('Enter');
      check(await page.locator('#receiveDialog').evaluate(e=>e.open), 'Enter sem resultado não submete formulário');
      await page.keyboard.press('Escape');
      check(await page.getAttribute('#receiveProductSearch','aria-expanded')==='false' && await page.locator('#receiveDialog').evaluate(e=>e.open), 'Esc fecha somente lista');
      await open('receiveProduct');
      await page.keyboard.press('ArrowDown');
      check(!!await page.getAttribute('#receiveProductSearch','aria-activedescendant'), 'Setas atualizam opção ativa acessível');
      await page.keyboard.press('Tab');
      check(await page.getAttribute('#receiveProductSearch','aria-expanded')==='false', 'Tab fecha lista');
      await filter('receiveProduct','uva');
      await click(rows('receiveProduct').first());
      check(await page.inputValue('#receiveProduct')==='product-2' && await page.getAttribute('#receiveProductSearch','aria-expanded')==='false', 'Mouse/toque seleciona ID e fecha');
      await page.evaluate(()=>document.getElementById('receiveForm').reset());
      await page.waitForFunction(()=>document.getElementById('receiveProductSearch').value===document.getElementById('receiveProduct').selectedOptions[0].textContent);
      check(await page.locator('#receiveProduct').evaluate(e=>e.value===e.options[0].value), 'Reset restaura seleção e texto');
      await filter('receiveSupplier','pot');
      check(await rows('receiveSupplier').count()===1, 'Pesquisa fornecedor');
      await page.keyboard.press('Enter');
      check(await page.inputValue('#receiveSupplier')==='supplier-1', 'supplier_id preservado');
      await filter('receiveSupplier','cotuba');
      await click(rows('receiveSupplier').first());
      check(await page.inputValue('#receiveSupplier')==='supplier-2', 'Fornecedor pelo texto entre parênteses');
      await filter('receiveSupplier','inativo');
      check(await rows('receiveSupplier').count()===0, 'Fornecedor inativo continua excluído');
      await page.keyboard.press('Escape');
      await page.evaluate(() => {document.getElementById('receiveSupplier').value=''; document.getElementById('receiveForm').reportValidity();});
      check(await page.locator('#receiveSupplierSearch').evaluate(e=>e===document.activeElement), 'Validação required foca combobox');
      await click(page.locator('[data-close="receiveDialog"]'));

      for (const [button,dialog,id] of [['transferStock','transferDialog','transferLot'],['registerSale','saleDialog','saleLot'],['registerLoss','lossDialog','lossLot'],['adjustStock','adjustDialog','adjustLot']]) {
        await click(page.locator(`#${button}`));
        await page.waitForSelector(`#${dialog}[open]`);
        await filter(id,'coca');
        check(await rows(id).count()>0, `${id}: busca por produto`);
        await page.fill(`#${id}Search`,'2103');
        check(await rows(id).count()===1, `${id}: busca por lote`);
        const nativeLabel = await page.locator(`#${id} option[value="lot-a"]`).textContent();
        check(await rows(id).first().textContent()===nativeLabel, `${id}: rótulo completo e saldo preservados`);
        if (id==='saleLot') check(nativeLabel.includes('8 un.'), 'Quantidade da geladeira preservada');
        await page.keyboard.press('Enter');
        check(await page.inputValue(`#${id}`)==='lot-a', `${id}: lot_id preservado`);
        await open(id);
        if (mobile) await page.setViewportSize({width:390,height:420});
        const geometry = await page.locator(`#${dialog}`).evaluate(e=>({height:e.getBoundingClientRect().height,viewport:innerHeight,width:e.scrollWidth,client:e.clientWidth}));
        check(geometry.height<=geometry.viewport && geometry.width<=geometry.client+1, `${id}: modal dentro da viewport`);
        await click(page.locator(`[data-close="${dialog}"]`));
        check(!await page.locator(`#${dialog}`).evaluate(e=>e.open), `${id}: cancelar acessível com scroll`);
        if (mobile) await page.setViewportSize({width:390,height:700});
      }
      await click(page.locator('#manageSuppliers'));
      await filter('supplierSelect','inativo');
      check(await rows('supplierSelect').count()===1, 'Gestão mantém fornecedor inativo visível');
      await click(page.locator('[data-close="supplierDialog"]'));
      await click(page.locator('#navHistory'));
      await filter('historyProduct','uva'); await page.keyboard.press('Enter');
      check(await page.inputValue('#historyProduct')==='product-2', 'Histórico usa pesquisa por produto');
      await click(page.locator('#clearHistoryFilters'));
      check(await page.inputValue('#historyProduct')==='' && (await page.inputValue('#historyProductSearch')).includes('Todos'), 'Limpar histórico sincroniza texto e ID');
      check(await page.evaluate(()=>window.__test.calls.every(c=>c.name.startsWith('guigs_get_'))), 'Nenhuma RPC de escrita chamada');
      check(external.length===0, 'Nenhuma requisição externa/produção');
      check(errors.length===0, `Sem erros JS: ${errors.join('; ')}`);
      console.log(`${mobile ? 'Mobile/toque' : 'Desktop/mouse'}: verificações concluídas.`);
      await context.close();
    }
    console.log(`Seletores: ${checks} verificações passaram; somente DOM e mocks.`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
