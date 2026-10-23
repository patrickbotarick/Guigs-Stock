// HTML/JS reais, dados artificiais e Supabase simulado; nenhuma rede externa.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const {fixture} = require('./browser.cjs');
let checks = 0;
const check = (value,message) => {assert.ok(value,message);checks++;};
const root = path.resolve(__dirname,'..');
const allowed = ['index.html','cloud-dashboard.js','inventory.js','reports.js','pwa.js','manifest.webmanifest','logo-guigs.png'];
const server = http.createServer((req,res)=>{
  const file=new URL(req.url,'http://localhost').pathname.slice(1);
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.png')?'image/png':'application/json');
  if(file==='config.js')return res.end('window.GUIGS_SUPABASE_CONFIG={url:"https://test.supabase.co",publishableKey:"sb_publishable_TEST"};');
  if(file==='fake.js')return res.end('export const createClient=()=>window.__mockClient;');
  if(!allowed.includes(file)){res.statusCode=404;return res.end();}
  let data=fs.readFileSync(path.join(root,file));
  if(file.endsWith('.js'))data=data.toString().replace('https://esm.sh/@supabase/supabase-js@2','./fake.js');
  res.end(data);
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
    for(const mobile of [false,true])for(const role of ['owner','attendant']){
      const context=await browser.newContext({viewport:mobile?{width:390,height:700}:{width:1440,height:900},hasTouch:mobile,isMobile:mobile,serviceWorkers:'block'});
      const external=[];const errors=[];
      await context.route('**/*',route=>{
        if(new URL(route.request().url()).hostname!=='127.0.0.1'){external.push(route.request().url());return route.abort();}
        return route.continue();
      });
      await context.addInitScript(fixture,{role,session:true,operations:true});
      const page=await context.newPage();page.setDefaultTimeout(7000);
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
      await page.waitForSelector('#content:not(.hidden)');
      const click=async selector=>mobile?page.locator(selector).tap():page.click(selector);
      const choose=async (id,value)=>page.selectOption(`#${id}`,value,{force:true});
      const count=async name=>page.evaluate(name=>window.__test.calls.filter(call=>call.name===name).length,name);
      const submit=async form=>page.evaluate(id=>document.getElementById(id).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})),form);
      const settled=async form=>page.waitForFunction(id=>!document.getElementById(id).hasAttribute('aria-busy'),form);
      const closed=async dialog=>page.waitForFunction(id=>!document.getElementById(id).open,dialog);
      const confirm=async()=>{await page.waitForSelector('#operationConfirmDialog[open]');await click('#confirmOperation');};
      const close=async dialog=>click(`[data-close="${dialog}"]`);
      const repeatDuringWrite=async(form,button,name,before)=>{
        await page.waitForFunction(({name,before})=>window.__test.calls.filter(call=>call.name===name).length===before+1,{name,before});
        await page.waitForFunction(id=>document.getElementById(id).textContent==='Salvando…',button);
        check(await page.isDisabled(`#${button}`),'Botão desabilitado enquanto salva');
        await page.keyboard.press('Escape');
        check(await page.locator(`#${form}`).evaluate(e=>e.closest('dialog').open),'Esc não sugere cancelar gravação já em andamento');
        await submit(form);await submit(form);await page.keyboard.press('Enter');
        check(await count(name)===before+1,`${name}: somente uma chamada durante envio repetido`);
      };

      const card=page.locator('[data-product-id="product-1"]');
      check((await card.textContent()).includes('Sugestão de reposição: 7'),'Meta menos saldo atual na geladeira');
      check((await card.textContent()).includes('Primeiro lote FEFO: LOTE-A'),'Orientação FEFO usa primeiro lote não vencido');
      check((await card.textContent()).includes('Estoque seco: 37 (30 não vencidas)'),'Estoque vencido excluído da sugestão');
      check((await page.locator('[data-product-id="product-juice"]').textContent()).includes('Sugestão de reposição: 3'),'Sugestão limitada pelo estoque seco');
      check((await page.locator('[data-product-id="product-juice"]').textContent()).includes('faltam 5'),'Falta de estoque explicitada');
      check(await page.locator('[data-product-id="product-off"]').count()===0,'Produto inativo sem sugestão');
      check((await page.textContent('#products')).includes('Total: mínimo 30 / meta 60'),'Mínimo e meta diferenciados');
      const initialStock=await page.textContent('#stock');
      for(const filter of ['minimum','replenish','near','expired']){
        const writesBefore=await page.evaluate(()=>window.__test.calls.filter(c=>!c.name.startsWith('guigs_get_')).length);
        await click(`[data-attention="${filter}"]`);
        check(await page.getAttribute(`[data-attention="${filter}"]`,'aria-pressed')==='true',`Filtro ${filter} acessível`);
        check(await page.textContent('#stock')===initialStock,'Filtro não altera métrica global');
        if(filter==='expired')check(await page.locator('#lots tr').count()===1 && (await page.textContent('#lots')).includes('VENCIDO'),'Filtro vencidos mantém só lote vencido');
        if(filter==='near')check(!(await page.textContent('#lots')).includes('VENCIDO') && !(await page.textContent('#lots')).includes('UVA-01'),'Próximos exclui vencidos e mais de 30 dias');
        check(await page.evaluate(()=>window.__test.calls.filter(c=>!c.name.startsWith('guigs_get_')).length)===writesBefore,'Filtros/sugestões não escrevem');
      }
      await click('[data-attention="all"]');
      if(process.env.TEST_ARTIFACTS_DIR){fs.mkdirSync(process.env.TEST_ARTIFACTS_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.TEST_ARTIFACTS_DIR,`operacao-${role}-${mobile?'mobile':'desktop'}.png`),fullPage:true});}

      // Perda sempre confirma; cancelar não escreve nem perde os campos.
      await click('#registerLoss');await choose('lossLot','lot-a');
      await page.fill('#lossQuantity','2');await page.fill('#lossNote','Garrafa danificada');
      const losses=await count('guigs_register_loss');
      await click('#saveLoss');await page.waitForSelector('#operationConfirmDialog[open]');
      const summary=await page.textContent('#operationConfirmSummary');
      check(summary.includes('Coca-Cola 2L')&&summary.includes('LOTE-A')&&summary.includes('Estoque seco')&&summary.includes('Garrafa danificada')&&summary.includes('2 unidade'),'Perda apresenta contexto completo');
      if(process.env.TEST_ARTIFACTS_DIR)await page.screenshot({path:path.join(process.env.TEST_ARTIFACTS_DIR,`confirmacao-${role}-${mobile?'mobile':'desktop'}.png`)});
      await submit('lossForm');check(await count('guigs_register_loss')===losses,'Enter/submit repetido durante confirmação não escreve');
      await page.keyboard.press('Escape');await settled('lossForm');
      check(await count('guigs_register_loss')===losses && await page.inputValue('#lossNote')==='Garrafa danificada','Cancelar preserva dados e saldo');
      await page.evaluate(()=>window.__test.writeDelay=400);
      await click('#saveLoss');await confirm();
      await repeatDuringWrite('lossForm','saveLoss','guigs_register_loss',losses);
      await closed('lossDialog');await settled('lossForm');
      check((await page.textContent('#operationFeedback')).includes('Perda registrada: 2'),'Feedback de perda permanece após fechar');
      check(await page.evaluate(()=>window.__test.calls.find(call=>call.name==='guigs_register_loss').args.p_quantity)===2,'Quantidade confirmada preservada na RPC');

      // Erro recuperável não trava o formulário.
      await click('#registerLoss');await choose('lossLot','lot-a');await page.fill('#lossNote','Teste artificial de erro');
      await page.evaluate(()=>window.__test.writeError=true);
      await click('#saveLoss');await confirm();await settled('lossForm');
      check(!await page.isDisabled('#saveLoss')&&(await page.textContent('#lossMessage')).includes('Falha de gravação'),'Erro libera botão e informa falha');
      check(await page.inputValue('#lossNote')==='Teste artificial de erro','Erro preserva preenchimento');
      await page.evaluate(()=>window.__test.writeError='network');
      await click('#saveLoss');await confirm();await settled('lossForm');
      check((await page.textContent('#lossMessage')).includes('Confira o histórico antes de repetir'),'Falha de rede com resultado incerto não incentiva reenvio cego');
      await page.evaluate(()=>window.__test.writeError=false);await close('lossDialog');

      // Desconexão entre confirmação e gravação nunca escreve.
      await click('#registerLoss');await choose('lossLot','lot-a');await page.fill('#lossNote','Cancelamento offline');
      const beforeOffline=await count('guigs_register_loss');await click('#saveLoss');await page.waitForSelector('#operationConfirmDialog[open]');
      await context.setOffline(true);await click('#confirmOperation');await settled('lossForm');
      check(await count('guigs_register_loss')===beforeOffline,'Confirmação offline não envia RPC');
      check(await page.isDisabled('#saveLoss')&&await page.isVisible('#products'),'Offline bloqueia operação e preserva dados exibidos');
      await context.setOffline(false);await page.waitForFunction(()=>!document.getElementById('registerLoss').disabled);await close('lossDialog');

      // Venda cotidiana não pede confirmação; zerar a geladeira pede.
      await click('#registerSale');await choose('saleLot','lot-a');await page.fill('#saleQuantity','1');
      const sales=await count('guigs_register_sale');await click('#saveSale');
      await repeatDuringWrite('saleForm','saveSale','guigs_register_sale',sales);await closed('saleDialog');await settled('saleForm');
      check((await page.textContent('#operationFeedback')).includes('Venda registrada: 1'),'Venda simples com feedback sem confirmação extra');
      await click('#registerSale');await choose('saleLot','lot-a');await page.fill('#saleQuantity','3');await click('#saveSale');
      await page.waitForSelector('#operationConfirmDialog[open]');
      check((await page.textContent('#operationConfirmReason')).includes('zerar'),'Saída que zera localização exige contexto');
      await click('#cancelOperation');await settled('saleForm');await close('saleDialog');

      // Movimentação fora de FEFO conserva o aviso existente e inclui quantidade.
      await click('#transferStock');await choose('transferLot','lot-b');await page.fill('#transferQuantity','2');await click('#saveTransfer');
      await page.waitForSelector('#fefoDialog[open]');
      check((await page.textContent('#fefoSelected')).includes('2 unidade(s)'),'FEFO mostra quantidade e origem/destino');
      await click('#cancelFefo');await settled('transferForm');await close('transferDialog');
      await click('#transferStock');await choose('transferLot','lot-a');await page.fill('#transferQuantity','1');
      // O lote vencido mantém prioridade no servidor; não é descartado pelo frontend.
      await page.evaluate(()=>window.__test.balances.find(b=>b.lot_id==='lot-expired').stock=0);
      const transfers=await count('guigs_transfer_stock');await click('#saveTransfer');
      await repeatDuringWrite('transferForm','saveTransfer','guigs_transfer_stock',transfers);await closed('transferDialog');await settled('transferForm');
      check((await page.textContent('#operationFeedback')).includes('movidas para geladeira'),'Feedback de movimentação');

      // Recebimento: normal sem confirmação; alta quantidade exige revisão.
      await click('#receiveStock');await choose('receiveProduct','product-1');await choose('receiveSupplier','supplier-1');
      await page.fill('#lotCode','RECEBIMENTO-ARTIFICIAL');await page.fill('#expiry','2030-12-31');await page.fill('#receiveQuantity','2');
      const receipts=await count('guigs_receive_stock');await click('#saveReceipt');
      await repeatDuringWrite('receiveForm','saveReceipt','guigs_receive_stock',receipts);await closed('receiveDialog');await settled('receiveForm');
      check((await page.textContent('#operationFeedback')).includes('Recebimento registrado: +2 Coca-Cola 2L'),'Feedback de recebimento com produto');
      await click('#receiveStock');await choose('receiveSupplier','supplier-1');await page.fill('#lotCode','QUANTIDADE-ALTA');
      await page.fill('#expiry','2030-12-31');await page.fill('#receiveQuantity','48');await click('#saveReceipt');await page.waitForSelector('#operationConfirmDialog[open]');
      check((await page.textContent('#operationConfirmReason')).includes('Quantidade alta'),'Limite de atenção 48 documentado na confirmação');
      if(mobile)await page.setViewportSize({width:390,height:420});
      check(await page.locator('#operationConfirmDialog').evaluate(e=>e.getBoundingClientRect().height<=innerHeight),'Confirmação dentro da viewport');
      await click('#cancelOperation');await settled('receiveForm');await close('receiveDialog');
      if(mobile)await page.setViewportSize({width:390,height:700});

      if(role==='owner'){
        await click('#adjustStock');await choose('adjustLot','lot-a');await page.fill('#adjustQuantity','4');await page.fill('#adjustNote','Contagem física artificial');
        check((await page.textContent('#adjustImpact')).includes('Novo saldo: 4'),'Resumo de ajuste atualiza antes de submeter');
        const adjustments=await count('guigs_adjust_stock');await click('#saveAdjust');await page.waitForSelector('#operationConfirmDialog[open]');
        check((await page.textContent('#operationConfirmSummary')).includes('Diferença'),'Ajuste mostra saldo atual, novo e diferença');
        await click('#cancelOperation');await settled('adjustForm');check(await count('guigs_adjust_stock')===adjustments,'Cancelar ajuste não escreve');
        await click('#saveAdjust');await confirm();await repeatDuringWrite('adjustForm','saveAdjust','guigs_adjust_stock',adjustments);await closed('adjustDialog');await settled('adjustForm');
        check((await page.textContent('#operationFeedback')).includes('Ajuste aplicado'),'Feedback de ajuste');
        await click('#adjustStock');await choose('adjustLot','lot-a');await page.fill('#adjustNote','Contagem sem diferença');
        await click('#saveAdjust');await closed('adjustDialog');await settled('adjustForm');
        check((await page.textContent('#operationFeedback')).includes('Nenhuma diferença encontrada'),'Ajuste sem diferença mantém comportamento e evita confirmação extra');

        await click('#editProduct');await choose('editProductSelect','product-1');await page.fill('#editProductName','Coca-Cola 2L revisada');
        const edits=await count('guigs_update_product');await click('#saveProductEdit');await repeatDuringWrite('editProductForm','saveProductEdit','guigs_update_product',edits);await closed('editProductDialog');await settled('editProductForm');
        check((await page.textContent('#operationFeedback')).includes('Produto atualizado'),'Feedback de edição de produto');

        await click('#newProduct');await page.fill('#productName','Produto artificial');
        const creates=await count('guigs_create_product');await click('#saveProduct');await repeatDuringWrite('productForm','saveProduct','guigs_create_product',creates);await closed('productDialog');await settled('productForm');
        check((await page.textContent('#operationFeedback')).includes('Produto cadastrado'),'Cadastro de produto protegido');

        await click('#manageSuppliers');await page.fill('#supplierName','Fornecedor artificial');
        const supplierCreates=await count('guigs_create_supplier');await click('#saveSupplier');await repeatDuringWrite('supplierForm','saveSupplier','guigs_create_supplier',supplierCreates);await closed('supplierDialog');await settled('supplierForm');
        check((await page.textContent('#operationFeedback')).includes('Fornecedor cadastrado'),'Feedback de fornecedor');
        await click('#manageSuppliers');await choose('supplierSelect','supplier-1');await page.fill('#supplierName','Fornecedor revisado');
        const supplierEdits=await count('guigs_update_supplier');await click('#saveSupplier');await repeatDuringWrite('supplierForm','saveSupplier','guigs_update_supplier',supplierEdits);await closed('supplierDialog');await settled('supplierForm');
        check((await page.textContent('#operationFeedback')).includes('Fornecedor atualizado'),'Feedback de edição de fornecedor');
      }else{
        check(!await page.isVisible('#adjustStock')&&!await page.isVisible('#editProduct')&&!await page.isVisible('#manageSuppliers'),'Atendente sem novas ações administrativas');
        await page.evaluate(()=>document.getElementById('adjustDialog').showModal());
        await submit('adjustForm');check(await count('guigs_adjust_stock')===0,'Submit administrativo forjado pelo DOM não chama RPC');
        await close('adjustDialog');
      }

      // Sucesso seguido de falha na atualização não convida a repetir escrita.
      await click('#registerLoss');await choose('lossLot','lot-a');await page.fill('#lossNote','Falha artificial de atualização');
      await page.evaluate(()=>window.__test.failRefreshAfterWrite=true);await click('#saveLoss');await confirm();await closed('lossDialog');await settled('lossForm');
      check((await page.textContent('#operationFeedback')).includes('Não repita a operação'),'Falha de leitura após sucesso não parece falha de gravação');
      check(await page.isVisible('#products'),'Falha de atualização preserva os dados anteriores');
      await page.evaluate(()=>{window.__test.failRefreshAfterWrite=false;window.__test.readError=false;});

      // Limites de validade existentes, incluindo hoje.
      await page.evaluate(()=>{
        for(const days of [0,15,16,30,31]){
          const d=new Date();d.setDate(d.getDate()+days);const expiry=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
          const id=`boundary-${days}`;window.__test.lots.push({id,product_id:'product-1',code:id,expiry,created_at:'2026-01-01'});window.__test.balances.push({lot_id:id,stock:1,fridge:0});
        }
      });
      await click('#refresh');await page.waitForFunction(()=>document.getElementById('lots').textContent.includes('boundary-31'));
      for(const [days,label] of [[0,'Urgente'],[15,'Urgente'],[16,'Atenção'],[30,'Atenção'],[31,'OK']])check((await page.locator('#lots tr').filter({hasText:`boundary-${days}`}).locator('.expiry-status').textContent())===label,`Validade ${days}: ${label}`);
      await page.evaluate(()=>window.__test.balances.find(balance=>balance.lot_id==='lot-juice').stock=0);
      await click('#refresh');await page.waitForFunction(()=>document.getElementById('replenishmentList').textContent.includes('Sem estoque seco não vencido'));
      check((await page.locator('[data-product-id="product-juice"]').textContent()).includes('Sugestão de reposição: 0'),'Ausência de estoque gera sugestão zero explícita');
      check(external.length===0,'Zero requisições externas/produção');
      check(errors.length===0,`Sem erros JS: ${errors.join('; ')}`);
      console.log(`${role} / ${mobile?'mobile':'desktop'}: operação validada.`);
      await context.close();
    }
    console.log(`Operação: ${checks} verificações passaram; somente mocks e dados artificiais.`);
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
