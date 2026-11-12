const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const {fixture} = require('./browser.cjs');

const root = path.resolve(__dirname,'..');
const allowed = new Set(require('../scripts/build.cjs').files);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const server = http.createServer((req,res)=>{
  const file = new URL(req.url,'http://127.0.0.1').pathname.slice(1) || 'index.html';
  if(file.startsWith('storage/v1/object/sign/guigs-product-images/')){
    if(!file.endsWith('/photo.png')){res.statusCode=404;return res.end();}
    res.setHeader('content-type','image/png');return res.end(png);
  }
  if(file==='config.js'){
    res.setHeader('content-type','text/javascript');
    return res.end("window.GUIGS_SUPABASE_CONFIG={url:'https://test.supabase.co',publishableKey:'sb_publishable_TEST'};");
  }
  if(file==='fake.js'){res.setHeader('content-type','text/javascript');return res.end('export const createClient=()=>window.__mockClient;');}
  if(!allowed.has(file)){res.statusCode=404;return res.end();}
  res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.png')?'image/png':'application/json');
  const asset=fs.readFileSync(path.join(root,file));
  res.end(file.endsWith('.js')?asset.toString().replace('https://esm.sh/@supabase/supabase-js@2','./fake.js'):asset);
});

function installInventory() {
  const client=window.__mockClient;
  window.__test.products.push({...window.__test.products[0],id:'p-1',image_path:'fixture/photo.png'},
    {...window.__test.products[0],id:'p-2',image_path:'fixture/missing.png'});
  client.supabaseUrl=location.origin;
  client.storage={from:bucket=>({
    async createSignedUrls(paths){
      return {data:paths.map(path=>({path,signedUrl:location.origin+'/storage/v1/object/sign/'+bucket+'/'+path}))};
    }
  })};
  const inventory={id:'inventory-fixture',status:'open',version:1,spatial:true};
  const items=[];
  for(let n=1;n<=100;n++){
    const product=Math.ceil(n/5);
    const locations=n===1?['stock','unallocated','a','b']:n===2?['stock','a']:['stock','unallocated','a'];
    for(const partition of locations){
      const physical=['a','b'].includes(partition);
      items.push({id:'row-'+n+'-'+partition,product_id:'p-'+product,product_name:product===1?'Água mineral':'Produto '+product,
        lot_id:'lot-'+n,lot_code:'REF-'+String(n).padStart(3,'0'),expiry:'2031-01-10',
        location:partition==='stock'?'stock':'fridge',slot_id:physical?partition:null,
        fridge_id:physical?'fridge-'+partition:null,
        slot_label:physical?(partition==='a'?'Imbera':'Metalfrio')+' / Prateleira 1 / Bebidas':null,
        counted_quantity:null,version:1,conflict:false});
    }
  }
  const original=client.rpc.bind(client);
  client.rpc=async(name,args)=>{
    if(name==='guigs_list_inventories')return {data:{inventories:[{...inventory,item_count:items.length,
      counted_count:items.filter(i=>i.counted_quantity!==null).length,divergent_count:null}],total:1}};
    if(name==='guigs_get_spatial_inventory')return {data:structuredClone({inventory,items,audit:[],new_lots:0,movements_after_start:0})};
    if(name==='guigs_count_spatial_inventory_item'){
      window.__test.calls.push({name,args});
      const item=items.find(i=>i.id===args.p_item_id);
      item.counted_quantity=args.p_quantity;
      item.version++;
      return {data:true};
    }
    return original(name,args);
  };
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser, checks=0;
  const check=(value,label)=>{assert.ok(value,label);checks++;};
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
    const viewports=[[1920,1080],[1366,768],[1280,800],[1024,768],[390,844],[360,780]];
    for(const [width,height] of viewports){
      const context=await browser.newContext({viewport:{width,height},hasTouch:width<=1280,isMobile:width<500,serviceWorkers:'block'});
      await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
      await context.addInitScript(fixture,{role:'attendant',session:true});
      await context.addInitScript(installInventory);
      const page=await context.newPage(), errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto('http://127.0.0.1:'+server.address().port+'/#inventario');
      const start=Date.now();
      await page.locator('#inventoryList button').click();
      await page.waitForSelector('.inventory-lot');
      const timing=Date.now()-start;
      check((await page.textContent('#inventoryTotals')).includes('Produtos: 20 · Lotes: 100 · Locais distintos: 4 · Posições de contagem: 300'),'Totais de escopo separados');
      check(await page.locator('.inventory-lot').count()===24,'Renderização limitada a uma página');
      check(timing<3000,'Primeira página carregada em até três segundos');
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Tela sem rolagem horizontal a '+width+' px');
      await page.click('#inventoryLotNext');
      check((await page.textContent('#inventoryLotPage')).includes('2 de 5'),'Página seguinte dos lotes');
      await page.fill('#inventorySearch','agua');
      check(await page.locator('.inventory-product').count()===1&&await page.locator('.inventory-lot').count()===5,'Busca sem acento mantém lotes distintos do produto');
      await page.fill('#inventorySearch','REF-001');
      const lot=page.locator('.inventory-lot');
      check(await lot.count()===1&&await lot.locator('.inventory-item').count()===4,'Um lote contém quatro localizações');
      check((await lot.locator('h4').allTextContents()).join('|')==='Estoque seco|Geladeira — não alocado|Imbera / Prateleira 1 / Bebidas|Metalfrio / Prateleira 1 / Bebidas','Ordem e rótulos das posições');
      check((await page.textContent('#inventoryFilterSummary')).includes('296 ocultas'),'Filtro informa itens ocultos');
      await page.click('#inventoryTools summary');
      await page.selectOption('#inventoryFridge','fridge-b');
      check(await lot.locator('.inventory-item').count()===1&&(await lot.locator('h4').textContent()).includes('Metalfrio'),'Filtro por geladeira física');
      check((await lot.locator('summary').textContent()).includes('0 de 4'),'Filtro conserva o denominador do lote');
      await page.selectOption('#inventoryFridge','');
      await page.selectOption('#inventoryLocation','unallocated');
      check((await lot.locator('h4').textContent()).includes('não alocado'),'Filtro não alocado é separado do slot');
      await page.selectOption('#inventoryLocation','');
      const row=lot.locator('[data-item-id="row-1-stock"]');
      const input=row.getByRole('spinbutton',{name:/Água mineral.*REF-001.*Estoque seco/});
      await row.getByRole('button',{name:'Salvar contagem'}).click();
      check(await input.evaluate(node=>node.validity.valueMissing),'Campo vazio tem validação nativa');
      check(await page.evaluate(()=>window.__test.calls.filter(c=>c.name==='guigs_count_spatial_inventory_item').length)===0,'Vazio não grava');
      await input.fill('0');
      await input.press('Enter');
      await page.waitForFunction(()=>document.querySelector('.inventory-lot summary')?.textContent.includes('1 de 4'));
      check((await lot.locator('.inventory-lot-progress').textContent()).includes('25% · Total contado: 0 un.'),'Zero registrado conta no progresso sem virar vazio');
      await page.selectOption('#inventoryFilter','pending');
      check(await lot.locator('.inventory-item').count()===3,'Filtro pendente respeita contagem zero');
      await page.selectOption('#inventoryFilter','counted');
      check(await lot.locator('.inventory-item').count()===1,'Filtro conferido mostra zero registrado');
      check(!(await lot.textContent()).includes('Diferença:')&&!await page.locator('#inventoryDifferencesPanel').isVisible(),'Contagem cega não revela saldo no resumo');
      await page.waitForFunction(()=>document.querySelector('.inventory-photo img')?.naturalWidth>0);
      await page.fill('#inventorySearch','Produto 2');
      await page.selectOption('#inventoryFilter','all');
      await page.waitForFunction(()=>document.querySelector('.inventory-photo')?.textContent==='▧');
      check(await page.locator('.inventory-photo img').count()===0,'Falha de imagem preserva fallback');
      check(errors.length===0,'Sem erro JavaScript');
      console.log(width+'×'+height+': primeira página em '+timing+' ms');
      await context.close();
    }
    console.log('Inventário agrupado: '+checks+' verificações passaram no navegador com 20 produtos, 100 lotes e 300 posições.');
  }finally{
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
