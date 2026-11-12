const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const {fixture}=require('./browser.cjs');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
const {files}=require('../scripts/build.cjs');
const root=path.resolve(__dirname,'..'),shop=id(10),source=id(60),destination=id(61),lot=id(30),product=id(20);
const signatures={
  guigs_get_fridge_map:['p_shop_id'],
  guigs_get_fridge_slot_history:['p_shop_id','p_slot_id','p_limit','p_before_at','p_before_event'],
  guigs_quote_fridge_slot_move:['p_shop_id','p_source','p_destination','p_lot','p_quantity'],
  guigs_apply_fridge_slot_move:['p_shop_id','p_request_id','p_source','p_destination','p_lot','p_quantity','p_expected']
};
let db, queue=Promise.resolve(), checks=0;
const check=(condition,label)=>{assert.ok(condition,label);checks++;};
const server=http.createServer(async(req,res)=>{
  const file=new URL(req.url,'http://127.0.0.1').pathname.slice(1)||'index.html';
  if(file==='map-fixture'&&req.method==='POST'){
    let body='';for await(const chunk of req)body+=chunk;
    const {role,name,args}=JSON.parse(body);
    const job=queue.then(()=>asUser(db,role,async tx=>{
      if(!signatures[name]||!['owner','attendant'].includes(role))throw Error('Fixture inválida');
      const values=signatures[name].map(key=>args[key]);
      return (await tx.query('select public.'+name+'('+values.map((_,i)=>'$'+(i+1)).join(',')+') data',values)).rows[0].data;
    }));queue=job.catch(()=>{});
    res.setHeader('content-type','application/json');
    try{res.end(JSON.stringify({data:await job,error:null}));}
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

function bridge({role,shop,names}){
  const client=window.__mockClient,from=client.from.bind(client),rpc=client.rpc.bind(client);
  client.from=table=>table==='guigs_memberships'?{
    select(){return this;},eq(){return this;},then(resolve){return Promise.resolve({data:[{shop_id:shop,role,active:true}]}).then(resolve);}
  }:from(table);
  client.rpc=(name,args)=>names.includes(name)?fetch('/map-fixture',{method:'POST',body:JSON.stringify({role,name,args})}).then(r=>r.json()):rpc(name,args);
}

(async()=>{
  let browser;
  try{
    db=await createTestDatabase({groupedInventory:true});
    await db.exec(`
      insert into public.guigs_lots(id,shop_id,product_id,code,expiry) values('${id(32)}','${shop}','${product}','PRÓXIMO',current_date+5);
      insert into public.guigs_fridges(id,shop_id,name) values('${id(40)}','${shop}','Metalfrio'),('${id(41)}','${shop}','Imbera');
      insert into public.guigs_fridge_shelves(id,shop_id,fridge_id,name) values
        ('${id(50)}','${shop}','${id(40)}','Prateleira origem'),('${id(51)}','${shop}','${id(41)}','Prateleira destino');
      insert into public.guigs_fridge_slots(id,shop_id,fridge_id,shelf_id,product_id,name,min_quantity,target_quantity,capacity_quantity)
        values ('${source}','${shop}','${id(40)}','${id(50)}','${product}','Origem',10,15,20),
        ('${destination}','${shop}','${id(41)}','${id(51)}','${product}','Destino',0,10,24),
        ('${id(62)}','${shop}','${id(41)}','${id(51)}','${product}','Cheio',0,3,3),
        ('${id(63)}','${shop}','${id(41)}','${id(51)}','${product}','Pendente',null,null,null);
      insert into public.guigs_fridge_shelves(id,shop_id,fridge_id,name,sort_order)
        select ('20000000-0000-0000-0000-'||lpad((100+n)::text,12,'0'))::uuid,'${shop}',
          case when n%2=0 then '${id(40)}'::uuid else '${id(41)}'::uuid end,'Prateleira '||n,n from generate_series(1,24) n;
      insert into public.guigs_fridge_slots(shop_id,fridge_id,shelf_id,product_id,name,min_quantity,target_quantity,capacity_quantity,x_ratio,width_ratio)
        select h.shop_id,h.fridge_id,h.id,'${id(21)}','Reserva '||n,0,1,20,(n-1)*0.5,0.4
        from public.guigs_fridge_shelves h cross join generate_series(1,2) n where h.sort_order>0;
      insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,slot_id,spatial)
        values('${shop}','${lot}',gen_random_uuid(),'receipt','fridge',6,'${id(1)}','${source}',true),
          ('${shop}','${id(32)}',gen_random_uuid(),'receipt','fridge',2,'${id(1)}','${source}',true),
          ('${shop}','${lot}',gen_random_uuid(),'receipt','fridge',3,'${id(1)}','${id(62)}',true);
      insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,slot_id,spatial,created_at)
        select '${shop}','${lot}',gen_random_uuid(),'adjust','fridge',d,'${id(1)}','${source}',true,now()-n*interval '1 minute'
        from generate_series(1,100) n cross join (values(1),(-1)) legs(d) order by n,d desc;
    `);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
    const open=async(role,width,height)=>{
      const context=await browser.newContext({viewport:{width,height},isMobile:width<500,hasTouch:width<=1280});
      await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
      await context.addInitScript(fixture,{role,session:true});await context.addInitScript(bridge,{role,shop,names:Object.keys(signatures)});
      const page=await context.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
      await page.goto(base+'/#geladeiras');await page.waitForSelector('.fridge-slot-open');
      return {page,context,errors};
    };
    for(const [width,height] of [[1920,1080],[1366,768],[1280,800],[1024,768],[390,844],[360,800]]){
      const {page,context,errors}=await open('attendant',width,height);
      check(await page.locator('.fridge-slot:visible').count()===52,'Todos mostra 52 blocos');
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mapa cabe em '+width);
      check(await page.locator('#fridgeSearchTool, #fridgeFilterTool').evaluateAll(items=>items.every(item=>!item.open)),'Mapa inicia com ferramentas recolhidas');
      await page.locator('#fridgePicker').selectOption({index:1});
      check(await page.locator('.fridge-cabinet:visible').count()===1,'Selecionar geladeira preserva só o gabinete escolhido');
      await page.selectOption('#fridgePicker','');
      check(await page.locator('.fridge-slot:visible').count()===52,'Voltar a todas restaura os blocos');
      await page.locator('#fridgeSearchTool summary').click();
      await page.fill('#fridgeMapSearch','metalfrio prateleira origem');
      check(await page.locator('.fridge-slot:visible').count()===1,'Busca combina geladeira, prateleira e bloco');
      await page.fill('#fridgeMapSearch','coca');
      check(await page.locator('.fridge-slot:visible').count()===4,'Busca encontra o produto');
      await page.fill('#fridgeMapSearch','');
      await page.keyboard.press('Escape');
      check(await page.locator('#fridgeSearchTool').evaluate(e=>!e.open),'Escape recolhe a busca do mapa');
      const mapTop=await page.locator('#fridgeMap').evaluate(e=>e.offsetTop);
      await page.locator('#fridgeFilterTool summary').click();
      check(await page.locator('#fridgeMap').evaluate(e=>e.offsetTop)===mapTop,'Abrir filtros não desloca o mapa');
      await page.selectOption('#fridgeMapStock','stock');check(await page.locator('.fridge-slot:visible').count()===2,'Filtro com estoque');
      await page.selectOption('#fridgeMapStock','empty');check(await page.locator('.fridge-slot:visible').count()===50,'Filtro vazio');
      await page.selectOption('#fridgeMapStock','all');
      for(const flag of ['low','full','pending','expiry']){
        const input=page.locator('#fridgeMapFilters input[value="'+flag+'"]');
        await input.check();check(await page.locator('.fridge-slot:visible').count()===1,'Filtro '+flag);await input.uncheck();
      }
      await page.locator('#fridgeMapFilters input[value=low]').check();
      await page.locator('#fridgeMapFilters input[value=expiry]').check();
      check((await page.locator('.fridge-slot:visible').textContent()).includes('Abaixo do mínimo')&&
        (await page.locator('.fridge-slot:visible').textContent()).includes('Atenção à validade'),'Alertas coexistem');
      check((await page.locator('#fridgeFilterBadge').textContent()).includes('2 ativo'),'Resumo identifica filtros ativos');
      await page.click('#fridgeClearFilters');
      check(await page.locator('.fridge-slot:visible').count()===52,'Limpar filtros restaura os blocos');
      check(!errors.length,'Sem erro de navegador em '+width);
      await context.close();
    }
    const attendant=await open('attendant',390,844),page=attendant.page;
    const openBlock=async(page,slot)=>page.locator('[data-open-slot="'+slot+'"]').click();
    await openBlock(page,source);
    await page.locator('#fridgeSlotHistory summary').click();
    await page.waitForFunction(()=>document.querySelectorAll('.fridge-history-entry').length===12);
    await page.click('#fridgeSlotHistoryMore');
    await page.waitForFunction(()=>document.querySelectorAll('.fridge-history-entry').length===24);
    check(await page.locator('.fridge-history-entry').evaluateAll(rows=>new Set(rows.map(row=>row.dataset.eventId)).size)===24,'Paginação sem duplicar eventos');
    const choose=async(page,all=false)=>{
      await page.click('#fridgeDetailMove');
      if(all)await page.selectOption('#fridgeMoveMode','all');
      else{await page.selectOption('#fridgeMoveLot',lot);await page.fill('#fridgeMoveQuantity','2');}
      await page.selectOption('#fridgeMoveFridge',id(41));
      await page.selectOption('#fridgeMoveShelf',id(51));
      const pending=await page.locator('#fridgeMoveDestination option[value="'+id(63)+'"]').evaluate(option=>({disabled:option.disabled,label:option.textContent}));
      check(pending.disabled&&pending.label.includes('Capacidade pendente'),'Destino com capacidade pendente bloqueado: '+JSON.stringify(pending));
      await page.selectOption('#fridgeMoveDestination',destination);
      await page.click('#fridgeMoveQuote');
      await page.waitForSelector('#fridgeMoveSummary:not(.hidden)');
      check((await page.textContent('#fridgeMoveSummary')).includes('Metalfrio')&&
        (await page.textContent('#fridgeMoveSummary')).includes('Imbera'),'Resumo mostra origem e destino');
      check(await page.locator('#fridgeMoveDialog').evaluate(el=>el.getBoundingClientRect().height<=innerHeight),'Modal cabe na viewport');
    };
    await choose(page);
    const keys=[];
    await page.route('**/map-fixture',async route=>{
      const payload=route.request().postDataJSON();
      if(payload.name!=='guigs_apply_fridge_slot_move')return route.continue();
      keys.push(payload.args.p_request_id);
      if(keys.length>1)return route.continue();
      const response=await route.fetch();
      assert.ok((await response.json()).data.event_id);
      return route.fulfill({json:{data:null,error:{message:'Failed to fetch'}}});
    });
    await page.locator('#fridgeMoveConfirm').evaluate(btn=>{btn.click();btn.click();});
    await page.waitForFunction(()=>document.querySelector('#fridgeMoveMessage').textContent.includes('Resultado incerto'));
    check(keys.length===1,'Duplo clique gera uma única escrita');
    check((await page.locator('[data-slot-id="'+source+'"]').textContent()).includes('8 un.'),'Resposta incerta não finge atualização');
    await page.click('#fridgeMoveConfirm');
    await page.waitForFunction(()=>document.querySelector('#fridgeSlotHistoryEntries').textContent.includes('Reorganização'));
    check(keys.length===2&&keys[0]===keys[1],'Retry usa a chave da resposta perdida');
    check((await page.locator('[data-slot-id="'+source+'"]').textContent()).includes('6 un.'),'Mapa atualizado após sucesso');
    await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
    await attendant.context.setOffline(true);
    check(await page.isDisabled('#fridgeDetailMove'),'Offline bloqueia nova movimentação');
    await page.reload();
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('sem conexão'));
    check(await page.evaluate(async()=> (await caches.keys()).includes('guigs-stock-shell-v21')),'Shell do mapa abre offline no cache v21');
    check(keys.length===2,'Reload offline não enfileira movimentos');
    check(!attendant.errors.length,'Fluxo do atendente sem erros JavaScript');
    await attendant.context.close();
    const owner=await open('owner',1024,768);
    await openBlock(owner.page,source);await choose(owner.page,true);
    check((await owner.page.locator('#fridgeMoveSummary li').count())===2,'Consolidação mantém dois lotes no resumo');
    await owner.page.click('#fridgeMoveConfirm');
    await owner.page.waitForFunction(()=>document.querySelector('#fridgeSlotHistoryEntries').textContent.includes('Reorganização'));
    const rows=(await db.query('select lot_id,sum(delta)::int quantity from public.guigs_movements where slot_id=$1 group by lot_id order by lot_id',[destination])).rows;
    assert.deepEqual(rows,[{lot_id:lot,quantity:6},{lot_id:id(32),quantity:2}]);checks++;
    check(!owner.errors.length,'Fluxo do owner sem erros JavaScript');
    await owner.context.close();
    console.log('Mapa v1.8D navegador: '+checks+' verificações passaram em seis viewports, com 52 blocos e mais de 200 movimentos.');
  }finally{
    if(browser)await browser.close();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    if(db)await db.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
