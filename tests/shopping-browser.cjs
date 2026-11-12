const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const {fixture}=require('./browser.cjs');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
const {files}=require('../scripts/build.cjs');
const root=path.resolve(__dirname,'..'),shop=id(10),product=id(20),manual=id(21),supplier=id(40);
const signatures={
 guigs_get_shopping_board:['p_shop_id','p_limit','p_offset'],
 guigs_get_purchase_order:['p_shop_id','p_order_id'],
 guigs_apply_shopping_command:['p_shop_id','p_request_id','p_action','p_payload']
};
let db,queue=Promise.resolve(),checks=0;
const calls=[];
const check=(condition,label)=>{assert.ok(condition,label);checks++;};
const server=http.createServer(async(req,res)=>{
 const file=new URL(req.url,'http://127.0.0.1').pathname.slice(1)||'index.html';
 if(file==='storage/v1/object/sign/guigs-product-images/fixture/photo.png'){
   res.setHeader('content-type','image/png');return res.end(fs.readFileSync(path.join(root,'icons/guigs-stock-192.png')));
 }
 if(file==='shopping-fixture'&&req.method==='POST'){
   let body='';for await(const chunk of req)body+=chunk;
   const {role,name,args}=JSON.parse(body);
   const query=queue.then(()=>asUser(db,role,async tx=>{
     const values=signatures[name];
     if(!values||!['owner','attendant'].includes(role))throw Error('Fixture inválida');
     calls.push({role,name,args});
     const result=(await tx.query('select public.'+name+'('+values.map((_,i)=>'$'+(i+1)).join(',')+') data',
       values.map(key=>args[key]))).rows[0].data;
     if(name==='guigs_get_shopping_board')result.needs.find(item=>item.product_id===product).image_path='fixture/photo.png';
     return result;
   }));queue=query.catch(()=>{});
   res.setHeader('content-type','application/json');
   try{res.end(JSON.stringify({data:await query,error:null}));}
   catch(error){res.end(JSON.stringify({data:null,error:{message:error.message,code:error.code}}));}
   return;
 }
 if(file==='config.js'){res.setHeader('content-type','text/javascript');return res.end("window.GUIGS_SUPABASE_CONFIG={url:'https://test.supabase.co',publishableKey:'sb_publishable_TEST'};");}
 if(file==='fake.js'){res.setHeader('content-type','text/javascript');return res.end('export const createClient=()=>window.__mockClient;');}
 if(!files.includes(file)){res.statusCode=404;return res.end();}
 res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.png')?'image/png':'application/json');
 const bytes=fs.readFileSync(path.join(root,file));
 res.end(file.endsWith('.js')?bytes.toString().replace('https://esm.sh/@supabase/supabase-js@2','./fake.js'):bytes);
});

function bridge({role,shop,actor,names}){
 const client=window.__mockClient,originalFrom=client.from.bind(client),originalRpc=client.rpc.bind(client);
 client.auth.getUser=async()=>({data:{user:{id:actor,email:role+'@test.invalid'}},error:null});
 client.from=table=>table==='guigs_memberships'?{
  select(){return this;},eq(){return this;},then(resolve){return Promise.resolve({data:[{shop_id:shop,role,active:true}]}).then(resolve);}
 }:originalFrom(table);
 client.rpc=(name,args)=>names.includes(name)?fetch('/shopping-fixture',{method:'POST',body:JSON.stringify({role,name,args})}).then(r=>r.json()):originalRpc(name,args);
 client.supabaseUrl=location.origin;
 client.storage={from:bucket=>({async createSignedUrls(paths){
   return {data:paths.map(path=>({path,signedUrl:location.origin+'/storage/v1/object/sign/'+bucket+'/'+path}))};
 }})};
 Object.defineProperty(navigator,'clipboard',{value:{async writeText(value){window.__test.copied=value;}}});
}

(async()=>{
 let browser;
 try{
  db=await createTestDatabase({groupedInventory:true});
  await db.query('update public.guigs_products set min_total=20,target_total=45 where id=$1',[product]);
  await db.query('update public.guigs_products set min_total=null,target_total=null where id=$1',[manual]);
  await db.query('insert into public.guigs_suppliers(id,shop_id,name) values($1,$2,$3)',[supplier,shop,'Distribuidora fixture']);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  const view=async(role,width,height)=>{
    const context=await browser.newContext({viewport:{width,height},hasTouch:width<=1280,isMobile:width<500,acceptDownloads:true});
    await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
    await context.addInitScript(fixture,{role,session:true});
    await context.addInitScript(bridge,{role,shop,actor:id(role==='owner'?1:2),names:Object.keys(signatures)});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
    await page.goto(base+'/#compras');await page.waitForSelector('#shoppingNeeds [data-product-id]');
    return {page,context,errors};
  };
  for(const [width,height] of [[1920,1080],[1366,768],[1280,800],[1024,768],[390,844],[360,780]]){
    const {page,context,errors}=await view('attendant',width,height);
    check(await page.getAttribute('#navShopping','aria-current')==='page','Compras tem navegação própria');
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Sem rolagem horizontal em '+width);
    check((await page.textContent('#shoppingMetrics')).includes('Produtos sem configuração'),'Indicadores visíveis');
    if(width===390)check(await page.locator('#shoppingNew').evaluate(e=>e.getBoundingClientRect().bottom<=innerHeight),
      'Novo rascunho encontrado na primeira dobra em 390×844');
    check(!(await page.getByRole('button',{name:'Editar mínimo e meta'}).count()),'Atendente não edita parâmetros');
    check(!errors.length,'Sem erro JavaScript em '+width);
    await context.close();
  }
  const before=(await db.query('select * from public.guigs_movements order by id')).rows;
  const attendant=await view('attendant',390,844), p=attendant.page;
  const card=p.locator('[data-product-id="'+product+'"]');
  await card.scrollIntoViewIfNeeded();
  await p.waitForFunction(id=>document.querySelector('[data-product-id="'+id+'"] img')?.naturalWidth>0,product);
  check((await p.locator('[data-product-id="'+manual+'"] .shopping-photo').textContent())==='▧','Imagem assinada e fallback coexistem');
  check(await card.locator('.shopping-need-priority dd').textContent()==='27','Sugestão visível na área prioritária');
  const details=card.locator('.shopping-need-details');
  check(!await details.evaluate(e=>e.open),'Dados complementares começam recolhidos');
  await details.locator('summary').click();
  check(await details.getByText('Fornecedor a escolher no rascunho.').isVisible(),'Fornecedor e saldos por local continuam acessíveis');
  await p.click('#shoppingTools summary');
  await p.selectOption('#shoppingFilter','unconfigured');
  check(await p.locator('#shoppingNeeds article').count()===1&&(await p.textContent('#shoppingNeeds')).includes('Não configurado'),'Filtro de parâmetros pendentes');
  await p.selectOption('#shoppingFilter','all');
  await card.getByRole('button',{name:'Adicionar sugestão'}).click();
  const line=p.locator('[data-line-product="'+product+'"]');
  await line.getByLabel('Quantidade solicitada').fill('24');
  await line.getByLabel('Fornecedor',{exact:true}).selectOption(supplier);
  await line.getByLabel('Observação do item').fill('=Fórmula artificial');
  await p.selectOption('#shoppingManualProduct',manual);
  await p.click('#shoppingAddManual');
  const hand=p.locator('[data-line-product="'+manual+'"]');
  check(await hand.getByLabel('Quantidade solicitada').inputValue()==='','Manual começa sem quantidade inventada');
  await p.click('#shoppingSave');
  check(calls.filter(c=>c.name==='guigs_apply_shopping_command').length===0,'Campo manual vazio impede gravação');
  await hand.getByLabel('Quantidade solicitada').fill('3');
  await p.fill('#shoppingNote','Compra da semana');
  await p.click('#shoppingClose');
  await p.click('#cancelOperation');
  check(await p.inputValue('#shoppingNote')==='Compra da semana','Cancelar descarte mantém rascunho não salvo');
  const writeKeys=[];
  await p.route('**/shopping-fixture',async route=>{
    const request=route.request().postDataJSON();
    if(request.name!=='guigs_apply_shopping_command'||request.args.p_action!=='save')return route.continue();
    writeKeys.push(request.args.p_request_id);
    if(writeKeys.length>1)return route.continue();
    const response=await route.fetch();
    assert.ok((await response.json()).data.id);
    return route.fulfill({json:{data:null,error:{message:'Failed to fetch'}}});
  });
  await p.click('#shoppingSave');
  await p.waitForFunction(()=>document.querySelector('#shoppingMessage').textContent.includes('Resultado incerto'));
  await p.click('#shoppingSave');
  await p.waitForFunction(()=>document.querySelector('#shoppingDetailTitle').textContent.includes('Lista · Rascunho'));
  check(writeKeys.length===2&&writeKeys[0]===writeKeys[1],'Retry usa a chave da resposta perdida');
  check(await p.locator('#shoppingOrders article').count()===1,'Rascunho persistido e listado');
  await p.getByRole('button',{name:'Revisar texto e exportar'}).click();
  await p.selectOption('#shoppingShareSupplier',supplier);
  const share=await p.inputValue('#shoppingShareText');
  const url=new URL(await p.getAttribute('#shoppingWhatsApp','href'));
  check(url.origin==='https://wa.me'&&url.searchParams.get('text')===share,'Link do WhatsApp contém o texto revisado');
  check(share.includes('24 un.')&&share.includes('Distribuidora fixture')&&!share.includes('SUCO UVA'),'Compartilhamento filtra por fornecedor');
  check(!share.includes(shop)&&!share.includes('attendant@test.invalid'),'Compartilhamento usa apenas dados operacionais');
  await p.click('#shoppingCopy');
  check(await p.evaluate(()=>window.__test.copied)===share,'Cópia usa o texto revisado');
  const download=p.waitForEvent('download');await p.click('#shoppingCsv');
  const csv=fs.readFileSync(await (await download).path(),'utf8');
  check(csv.includes('"27";"24"')&&csv.includes('"\'=Fórmula artificial"')&&!csv.includes('SUCO UVA'),'CSV preserva snapshot e neutraliza fórmula');
  await p.click('[data-close="shoppingShareDialog"]');
  await p.getByRole('button',{name:'Preparar pedido'}).click();
  await p.click('#confirmOperation');
  await p.waitForFunction(()=>document.querySelector('#shoppingDetailTitle').textContent.includes('Pendente'));
  check(await card.locator('dl div').filter({hasText:'Em pedido'}).locator('dd').textContent()==='24'&&
    await card.locator('.shopping-need-priority dd').textContent()==='3','Pedido aberto reduz apenas a sugestão adicional');
  check(!await p.getByRole('button',{name:'Marcar pedido realizado'}).count(),'Atendente não finaliza pedido');
  await p.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await attendant.context.setOffline(true);
  check(await p.isDisabled('#shoppingNew')&&await p.isVisible('#shoppingOffline'),'Offline bloqueia gravações');
  const beforeOffline=calls.length;
  await p.reload();
  await p.waitForFunction(()=>document.getElementById('status').textContent.includes('sem conexão'));
  check(await p.evaluate(async()=> (await caches.keys()).includes('guigs-stock-shell-v21')),'PWA abre shell de compras offline');
  check(calls.length===beforeOffline,'Reload offline não enfileira comandos');
  check(!attendant.errors.length,'Fluxo mobile sem erro JavaScript');
  await attendant.context.close();
  const owner=await view('owner',1280,800), q=owner.page;
  await q.locator('#shoppingOrders button').first().click();
  await q.getByRole('button',{name:'Marcar pedido realizado'}).click();await q.click('#confirmOperation');
  await q.waitForFunction(()=>document.querySelector('#shoppingDetailTitle').textContent.includes('Pedido realizado'));
  await q.getByRole('button',{name:'Marcar recebido',exact:true}).click();await q.click('#confirmOperation');
  await q.waitForFunction(()=>document.querySelector('#shoppingDetailTitle').textContent.includes('Recebido'));
  check((await q.textContent('#shoppingEvents')).includes('Recebimento administrativo'),'Histórico mantém confirmação administrativa');
  check((await q.locator('#shoppingSavedItems').textContent()).includes('Sem fornecedor'),'Pedido conserva item manual sem fornecedor');
  assert.deepEqual((await db.query('select * from public.guigs_movements order by id')).rows,before);checks++;
  await q.locator('[data-product-id="'+product+'"]').getByRole('button',{name:'Editar mínimo e meta'}).click();
  await q.fill('#shoppingMinimum','20');await q.fill('#shoppingTarget','19');
  await q.getByRole('button',{name:'Salvar parâmetros'}).click();
  check((await q.textContent('#shoppingLimitsMessage')).includes('maior ou igual'),'Tela rejeita meta inferior ao mínimo');
  await q.fill('#shoppingTarget','46');await q.getByRole('button',{name:'Salvar parâmetros'}).click();
  await q.waitForSelector('#shoppingLimitsDialog',{state:'hidden'});
  check((await db.query('select target_total from public.guigs_products where id=$1',[product])).rows[0].target_total===46,'Owner configura meta pelo servidor');
  await q.getByRole('button',{name:'Abrir recebimento físico'}).click();
  check(await q.isVisible('#receiveDialog'),'Atalho abre recebimento físico sem confirmar');
  check(!owner.errors.length,'Fluxo tablet sem erro JavaScript');
  await owner.context.close();

  const longName='Refrigerante artesanal de teste com nome extenso para validar a leitura em telas estreitas';
  const additional=Array.from({length:12},(_,index)=>[id(200+index),index===0?longName:'Produto fictício '+index]);
  for(const [productId,name] of additional)await db.query(
    'insert into public.guigs_products(id,shop_id,name,min_total,target_total) values($1,$2,$3,0,0)',[productId,shop,name]);
  await db.query('update public.guigs_lots set expiry=current_date-1 where id=$1',[id(30)]);
  for(const [role,width,height] of [['owner',1366,768],['attendant',320,700]]){
    const sample=await view(role,width,height);
    const cards=sample.page.locator('#shoppingNeeds .shopping-need');
    check(await cards.count()>=14,'Catálogo longo renderizado');
    const long=cards.filter({hasText:longName});
    check(await long.getByText('Estoque adequado').isVisible(),'Nome longo e estoque adequado legíveis');
    const expired=cards.filter({has:sample.page.getByText('Lotes vencidos',{exact:true})});
    check(await expired.count()===1&&await expired.locator('[data-tone=critical]').isVisible(),'Validade crítica tem rótulo e estado distintos');
    check(await sample.page.evaluate(()=>document.documentElement.scrollWidth===document.documentElement.clientWidth),'Cards sem overflow');
    if(process.env.TEST_ARTIFACTS_DIR)await long.screenshot({path:path.join(process.env.TEST_ARTIFACTS_DIR,'r5c-card-longo-'+width+'.png')});
    await sample.context.close();
  }
  console.log('Compras navegador: '+checks+' verificações passaram em seis viewports com dados artificiais.');
 }finally{
  if(browser)await browser.close();
  if(server.listening)await new Promise(resolve=>server.close(resolve));
  if(db)await db.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
