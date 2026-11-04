const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const {fixture}=require('./browser.cjs');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
const {files}=require('../scripts/build.cjs');
const root=path.resolve(__dirname,'..'),allowed=new Set(files),shop=id(10);
let checks=0,db,pending=Promise.resolve();
function check(value,msg){assert.ok(value,msg);checks++;}
async function dispatch({role,table,name,args}){
  if(!['owner','attendant'].includes(role))throw Error('Perfil de fixture inválido');
  const tables={guigs_products:'public.guigs_products',guigs_lots:'public.guigs_lots',guigs_suppliers:'public.guigs_suppliers'};
  const calls={
    guigs_get_fridge_map:['select public.guigs_get_fridge_map($1) as data',[args?.p_shop_id]],
    guigs_save_fridge_layout:['select public.guigs_save_fridge_layout($1,$2,$3,$4,$5) as data',
      [args?.p_shop_id,args?.p_kind,JSON.stringify(args?.p_values??null),args?.p_id,args?.p_revision]],
    guigs_allocate_fridge_stock:['select public.guigs_allocate_fridge_stock($1,$2,$3) as data',
      [args?.p_shop_id,args?.p_request_id,JSON.stringify(args?.p_entries??null)]],
    guigs_get_fridge_replenishment:['select public.guigs_get_fridge_replenishment($1,$2,$3) as data',
      [args?.p_shop_id,args?.p_slot_id,args?.p_quantity]],
    guigs_replenish_fridge_slot:['select public.guigs_replenish_fridge_slot($1,$2,$3,$4,$5) as data',
      [args?.p_shop_id,args?.p_request_id,args?.p_slot_id,args?.p_quantity,JSON.stringify(args?.p_plan??null)]],
    guigs_get_fridge_operation:['select public.guigs_get_fridge_operation($1,$2) as data',[args?.p_shop_id,JSON.stringify(args?.p_spec)]],
    guigs_apply_fridge_operation:['select public.guigs_apply_fridge_operation($1,$2,$3,$4,$5) as data',
      [args?.p_shop_id,args?.p_request_id,JSON.stringify(args?.p_spec),JSON.stringify(args?.p_expected),args?.p_note]],
    guigs_list_inventories:['select public.guigs_list_inventories($1,$2,$3) as data',[args?.p_shop_id,args?.p_limit,args?.p_offset]],
    guigs_create_spatial_inventory:['select public.guigs_create_spatial_inventory($1,$2) as data',[args?.p_shop_id,args?.p_observation]],
    guigs_get_spatial_inventory:['select public.guigs_get_spatial_inventory($1,$2) as data',[args?.p_shop_id,args?.p_inventory_id]],
    guigs_count_spatial_inventory_item:['select public.guigs_count_spatial_inventory_item($1,$2,$3,$4,$5) as data',
      [args?.p_shop_id,args?.p_inventory_id,args?.p_item_id,args?.p_quantity,args?.p_version]]
  };
  return asUser(db,role,async tx=>{
    if(tables[table])return (await tx.query('select * from '+tables[table]+' where shop_id=$1 order by id',[shop])).rows;
    if(calls[name])return (await tx.query(...calls[name])).rows[0].data;
    throw Error('Operação de fixture não permitida');
  });
}
const server=http.createServer(async(req,res)=>{
  const f=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  if(f==='fixture'&&req.method==='POST'){
    let body='';for await(const chunk of req)body+=chunk;
    const task=pending.then(()=>dispatch(JSON.parse(body)));pending=task.catch(()=>{});
    res.setHeader('content-type','application/json');
    try{res.end(JSON.stringify({data:await task,error:null}));}
    catch(e){res.end(JSON.stringify({data:null,error:{message:e.message}}));}
    return;
  }
  if(f==='config.js'){res.setHeader('content-type','text/javascript');return res.end("window.GUIGS_SUPABASE_CONFIG={url:'https://test.supabase.co',publishableKey:'sb_publishable_TEST_ONLY'};");}
  if(f==='fake.js'){res.setHeader('content-type','text/javascript');return res.end('export const createClient=()=>window.__mockClient;');}
  if(!allowed.has(f)){res.statusCode=404;return res.end();}
  res.setHeader('content-type',f.endsWith('.js')?'text/javascript':f.endsWith('.html')?'text/html':f.endsWith('.png')?'image/png':'application/json');
  const raw=fs.readFileSync(path.join(root,f));
  res.end(f.endsWith('.js')?raw.toString().replace('https://esm.sh/@supabase/supabase-js@2','./fake.js'):raw);
});
function bridge({role,shop}){
  const c=window.__mockClient, original=c.rpc.bind(c), originalFrom=c.from.bind(c);
  const send=data=>fetch('/fixture',{method:'POST',body:JSON.stringify({role,...data})}).then(r=>r.json());
  c.rpc=(name,args)=>/^(guigs_get_fridge_map|guigs_save_fridge_layout|guigs_allocate_fridge_stock|guigs_get_fridge_replenishment|guigs_replenish_fridge_slot|guigs_get_fridge_operation|guigs_apply_fridge_operation|guigs_list_inventories|guigs_create_spatial_inventory|guigs_get_spatial_inventory|guigs_count_spatial_inventory_item)$/.test(name)?send({name,args}):original(name,args);
  c.from=table=>{
    if(table==='guigs_memberships')return {select(){return this},eq(){return this},then(a,b){return Promise.resolve({data:[{shop_id:shop,role,active:true}],error:null}).then(a,b)}};
    if(!['guigs_products','guigs_lots','guigs_suppliers'].includes(table))return originalFrom(table);
    return {select(){return this},eq(){return this},range(){return this},then(a,b){return send({table}).then(a,b)}};
  };
}
(async()=>{
  let browser;
  try{
    db=await createTestDatabase();
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261104123035_spatial_fridge_foundation.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261104124433_spatial_fridge_allocation.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261104124855_spatial_fridge_replenishment.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261104125329_spatial_fridge_operations.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261104125833_spatial_fridge_inventory.sql'),'utf8'));
    const ledger=()=>db.query('select id,delta,slot_id from public.guigs_movements order by id').then(r=>r.rows);
    const before=await ledger();
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url='http://127.0.0.1:'+server.address().port+'/#geladeiras';
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
    async function open(role,viewport){
      const context=await browser.newContext({viewport,serviceWorkers:'block'});
      await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
      await context.addInitScript(fixture,{role,session:true});
      await context.addInitScript(bridge,{role,shop});
      const page=await context.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      page.setDefaultTimeout(10000);await page.goto(url);await page.waitForSelector('#content:not(.hidden) #fridgesView:not(.hidden)');
      return {context,page,errors};
    }
    const {context,page,errors}=await open('owner',{width:1200,height:850});
    await page.click('#fridgeEdit');
    check(await page.isVisible('#fridgeEditor'),'Owner entra no editor');
    const fill=(name,value)=>page.fill('#fridgeField_'+name,String(value));
    const choose=(name,value)=>page.selectOption('#fridgeField_'+name,value);
    const newKind=async kind=>{await page.selectOption('#fridgeEditKind',kind);await page.selectOption('#fridgeEditItem','');};
    const save=async()=>{
      await page.click('#fridgeSaveLayout');
      await page.waitForFunction(()=>document.querySelector('#fridgeMessage').textContent.startsWith('Layout salvo')&&!document.querySelector('#fridgeSaveLayout').disabled);
      const value=await page.inputValue('#fridgeEditItem');check(!!value,'Layout persistido e selecionado');
      return value;
    };
    await fill('name','Geladeira A');await fill('width_ratio',65);const a=await save();
    await newKind('fridge');await fill('name','Geladeira B');await fill('sort_order',4);const b=await save();
    for(const [fridge,name] of [[a,'A1'],[a,'A2'],[b,'B1']]){
      await newKind('shelf');await choose('fridge_id',fridge);await fill('name',name);await fill('height_ratio',50);await save();
    }
    const h=(await db.query("select id from public.guigs_fridge_shelves where name='A1'")).rows[0].id;
    await newKind('slot');await choose('fridge_id',a);await choose('shelf_id',h);await choose('product_id',id(20));
    await fill('name','Coca A1');await fill('width_ratio',60);await fill('target_quantity',12);await fill('min_quantity',4);await fill('capacity_quantity',18);
    const x=await save();
    await fill('width_ratio',50);await fill('x_ratio',25);await fill('sort_order',2);await save();
    await page.reload();await page.click('#fridgeEdit');await page.selectOption('#fridgeEditKind','slot');await page.selectOption('#fridgeEditItem',x);
    check(await page.inputValue('#fridgeField_width_ratio')==='50','Resize persiste após reload');
    check(await page.inputValue('#fridgeField_x_ratio')==='25','Reposicionamento persiste');
    check(await page.inputValue('#fridgeField_sort_order')==='2','Ordem persiste');
    check(await page.inputValue('#fridgeField_product_id')===id(20),'Associação persiste');
    check((await db.query('select count(*)::int as n from public.guigs_fridge_shelves where fridge_id=$1',[a])).rows[0].n===2,'Geladeira A tem duas prateleiras');
    check((await db.query('select count(*)::int as n from public.guigs_fridge_shelves where fridge_id=$1',[b])).rows[0].n===1,'Geladeira B tem uma prateleira');
    await context.setOffline(true);
    await page.waitForFunction(()=>document.querySelector('#fridgeSaveLayout').disabled);
    check(await page.isVisible('#fridgeOffline'),'Offline bloqueia edição e informa estado');
    check(errors.length===0,'Sem erro JavaScript desktop');
    await context.close();
    const mobile=await open('attendant',{width:390,height:844});
    await mobile.page.waitForFunction(()=>document.querySelector('#fridgeMap').textContent.includes('Coca A1'));
    check(!(await mobile.page.isVisible('#fridgeEdit')),'Atendente sem editor');
    check(await mobile.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile sem rolagem horizontal global');
    check(mobile.errors.length===0,'Sem erro JavaScript mobile');
    await mobile.context.close();
    assert.deepEqual(await ledger(),before);checks++;
    const editorChecks=checks;checks=0;
    const {fridgeSlotState}=await import('../fridges.js');
    for(const [quantity,expected] of [[0,'VAZIO'],[1,'CRÍTICO'],[2,'ATENÇÃO'],[4,'OK'],[6,'OK']])
      check(fridgeSlotState({quantity,min_quantity:2,target_quantity:4,capacity_quantity:6})===expected,'Estado no limite '+quantity);
    const create=async(kind,values)=>(await dispatch({role:'owner',name:'guigs_save_fridge_layout',args:{p_shop_id:shop,p_kind:kind,p_values:values,p_id:null,p_revision:null}}));
    const critical=await create('slot',{fridge_id:a,shelf_id:h,name:'Crítico',product_id:id(20),min_quantity:2,target_quantity:4,capacity_quantity:6,x_ratio:.15,width_ratio:.2});
    const ok=await create('slot',{fridge_id:a,shelf_id:h,name:'Pronto',product_id:id(20),min_quantity:1,target_quantity:2,capacity_quantity:6,x_ratio:.75,width_ratio:.25});
    await create('slot',{fridge_id:a,shelf_id:h,name:'Vazio',x_ratio:0,width_ratio:.15});
    await db.transaction(async tx=>{
      const e=(await tx.query('select gen_random_uuid() as id')).rows[0].id;
      for(const [slot,delta] of [[null,-7],[x,4],[critical.id,1],[ok.id,2]])
        await tx.query("insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,slot_id,spatial) values($1,$2,$3,'adjust','fridge',$4,$5,$6,true)",[shop,id(30),e,delta,id(1),slot]);
    });
    const waitMap=p=>p.waitForSelector('.fridge-unallocated');
    const desktop=await open('attendant',{width:1440,height:950});await waitMap(desktop.page);
    check(await desktop.page.locator('.fridge-cabinet').count()===2,'Duas geladeiras em desktop');
    check(await desktop.page.locator('.fridge-cabinet').evaluateAll(ns=>Math.abs(ns[0].getBoundingClientRect().top-ns[1].getBoundingClientRect().top)<2),'Geladeiras lado a lado quando há espaço');
    for(const state of ['VAZIO','CRÍTICO','ATENÇÃO','OK'])
      check(await desktop.page.locator('.fridge-state').filter({hasText:state}).count()===1,'Mapa exibe estado '+state);
    check(await desktop.page.locator('.fridge-photo-fallback').count()===4,'Placeholders sem imagem');
    check((await desktop.page.locator('.fridge-unallocated').textContent()).includes('1 un. sem posição física'),'Saldo não alocado separado do mapa');
    const slot=desktop.page.locator('[data-slot-id="'+x+'"]');
    check(await slot.getByRole('meter',{name:'Ocupação de Coca A1'}).count()===1,'Ocupação com nome acessível');
    await slot.getByText('Lotes e validade').focus();await desktop.page.keyboard.press('Enter');
    check(await slot.locator('details[open]').count()===1,'Validade acessível por teclado');
    check(desktop.errors.length===0,'Mapa sem erro JavaScript');
    await desktop.context.close();
    await db.query('update public.guigs_fridges set active=false where id=$1',[b]);
    const tablet=await open('attendant',{width:820,height:900});await waitMap(tablet.page);
    check(await tablet.page.locator('.fridge-cabinet').count()===1,'Uma geladeira ativa em tablet');
    check(await tablet.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Tablet sem rolagem horizontal global');
    await tablet.context.close();
    await db.query('update public.guigs_fridges set active=true where id=$1',[b]);
    for(let i=3;i<=5;i++){
      const f=await create('fridge',{name:'Geladeira '+i,width_ratio:.35+i*.1,sort_order:i});
      for(let j=0;j<i-2;j++)await create('shelf',{name:'Prateleira '+j,fridge_id:f.id,y_ratio:j*.2,height_ratio:.2});
    }
    const small=await open('attendant',{width:360,height:740});await waitMap(small.page);
    check(await small.page.locator('.fridge-cabinet').count()===5,'Cinco geladeiras no celular');
    check(await small.page.locator('.fridge-cabinet').evaluateAll(ns=>ns.every((n,i)=>i===0||n.getBoundingClientRect().top>ns[i-1].getBoundingClientRect().top)),'Geladeiras empilhadas no celular');
    check(await small.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Celular sem rolagem horizontal global');
    await small.context.close();
    const mapChecks=checks;checks=0;
    const owner=await open('owner',{width:390,height:844});await waitMap(owner.page);
    const beforeCancel=await ledger();
    await owner.page.click('#fridgeAllocate');await owner.page.fill('#allocate-'+x,'1');await owner.page.click('#fridgeCancelAllocation');
    assert.deepEqual(await ledger(),beforeCancel);checks++;
    await owner.page.click('#fridgeAllocate');await owner.page.fill('#allocate-'+x,'1');
    check((await owner.page.textContent('#fridgeAllocationSummary')).includes('Restam não alocadas: 0'),'Resumo antes da confirmação');
    await owner.page.click('#fridgeConfirmAllocation');
    await owner.page.waitForFunction(()=>document.querySelector('.fridge-unallocated').textContent.includes('0 un. sem posição física'));
    check((await owner.page.locator('[data-slot-id="'+x+'"]').textContent()).includes('5 / 18 un.'),'Mapa atualizado depois da distribuição');
    check((await db.query("select sum(delta)::int as n from public.guigs_movements where location='fridge'")).rows[0].n===8,'Saldo global preservado pelo fluxo UI');
    check(owner.errors.length===0,'Fluxo de distribuição sem erro JavaScript');
    await owner.context.close();
    const allocationChecks=checks;checks=0;
    const worker=await open('attendant',{width:390,height:844});await waitMap(worker.page);
    const keys=[];
    await worker.page.route('**/fixture',async route=>{
      const request=route.request().postDataJSON();
      if(request?.name!=='guigs_replenish_fridge_slot')return route.fallback();
      keys.push(request.args.p_request_id);
      if(keys.length!==1)return route.fallback();
      const response=await route.fetch();
      assert.equal((await response.json()).error,null,'Fixture confirmou no servidor antes da falha de transporte');
      return route.fulfill({json:{data:null,error:{message:'Conexão interrompida. Tente novamente.'}}});
    });
    await worker.page.getByRole('button',{name:'Repor Coca A1'}).click();
    await worker.page.waitForFunction(()=>!document.querySelector('#fridgeReplenishConfirm').disabled);
    check(await worker.page.inputValue('#fridgeReplenishQuantity')==='7','Sugestão até a meta no modal');
    await worker.page.fill('#fridgeReplenishQuantity','3');
    check(await worker.page.isDisabled('#fridgeReplenishConfirm'),'Mudança de quantidade exige recalcular FEFO');
    await worker.page.click('#fridgeReplenishQuote');
    await worker.page.waitForFunction(()=>!document.querySelector('#fridgeReplenishConfirm').disabled);
    await worker.page.locator('#fridgeReplenishConfirm').evaluate(b=>{b.click();b.click();});
    await worker.page.waitForFunction(()=>document.querySelector('#fridgeReplenishMessage').textContent.includes('interrompida'));
    check(keys.length===1,'Duplo clique gera uma requisição');
    await worker.page.click('#fridgeReplenishConfirm');
    await worker.page.waitForFunction(slot=>document.querySelector('[data-slot-id="'+slot+'"]').textContent.includes('8 / 18 un.'),x);
    check(keys.length===2&&keys[0]===keys[1],'Retry após resposta perdida preserva a chave');
    check((await db.query("select count(*)::int as n from public.guigs_movements where movement_type='transfer' and spatial")).rows[0].n===2,'Retry não duplica o débito/crédito');
    check(worker.errors.length===0,'Reposição sem erro JavaScript');
    const replenishChecks=checks;checks=0;
    await worker.page.click('#fridgeOperateStock');
    check(await worker.page.locator('#fridgeStockKind option[value="adjust"]').count()===0,'Atendente não vê ajuste');
    check(await worker.page.inputValue('#fridgeStockOrigin')==='auto','Origem automática FEFO por padrão');
    await worker.page.fill('#fridgeStockQuantity','4');await worker.page.click('#fridgeStockQuote');
    await worker.page.waitForFunction(()=>!document.querySelector('#fridgeStockConfirm').disabled);
    check(await worker.page.locator('#fridgeStockPlan li').count()===3,'Venda apresenta split antes de confirmar');
    await worker.page.click('#fridgeStockConfirm');
    await worker.page.waitForFunction(slot=>document.querySelector('[data-slot-id="'+slot+'"]').textContent.includes('7 / 18 un.'),x);
    check((await db.query("select count(distinct event_id)::int as events,count(*)::int as lines from public.guigs_movements where movement_type='sale' and spatial")).rows[0].lines===3,'Venda split gravada no ledger');
    check((await db.query("select count(distinct event_id)::int as n from public.guigs_movements where movement_type='sale' and spatial")).rows[0].n===1,'Split tem um único evento');
    check(worker.errors.length===0,'Saída sem erro JavaScript');
    const operationChecks=checks;checks=0;
    await worker.page.click('#fridgeRestockMode');
    check(await worker.page.locator('#fridgeRestockList [data-restock-slot]').count()===3,'Lista inclui apenas posições abaixo da meta com produto');
    check((await worker.page.textContent('#fridgeRestockSummary')).includes('Pegar até 7 de 11 un.'),'Resumo não conta o mesmo estoque seco duas vezes');
    await worker.page.selectOption('#fridgeRestockFilter','shortage');
    const target=worker.page.locator('[data-restock-slot="'+x+'"]');
    check(await worker.page.locator('#fridgeRestockList [data-restock-slot]').count()===1,'Filtro mostra falta de estoque');
    await target.getByRole('button',{name:'Conferir reposição'}).click();
    await worker.page.waitForFunction(()=>!document.querySelector('#fridgeReplenishConfirm').disabled);
    check(await worker.page.inputValue('#fridgeReplenishQuantity')==='1','Lista abre plano FEFO limitado à estimativa da posição');
    await worker.page.click('#fridgeReplenishConfirm');
    await worker.page.waitForFunction(slot=>document.querySelector('[data-restock-slot="'+slot+'"]').textContent.includes('8 / 18'),x);
    check((await target.textContent()).includes('Sem estoque seco elegível para esta posição.'),'Lista atualizada após reposição');
    await worker.page.selectOption('#fridgeRestockFilter','available');
    check(await target.count()===0,'Filtro com disponibilidade oculta posição sem unidades a pegar');
    check(await worker.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Reposição mobile sem rolagem horizontal global');
    await worker.context.close();
    const restockChecks=checks;checks=0;
    const countBefore=await ledger();
    const inventory=await open('owner',{width:390,height:844});
    await inventory.page.click('#navInventory');
    await inventory.page.click('#newSpatialInventory');
    await inventory.page.click('#inventoryCreateSubmit');
    await inventory.page.waitForSelector('#inventoryDetail:not(.hidden) .inventory-item');
    check((await inventory.page.textContent('#inventoryDetailInfo')).includes('Por posição'),'Novo inventário espacial identificado');
    check(await inventory.page.isVisible('#inventoryPosition'),'Filtro de posição exposto');
    await inventory.page.selectOption('#inventoryPosition',x);
    check(await inventory.page.locator('.inventory-item').count()===1,'Filtro deixa apenas o lote da posição');
    check((await inventory.page.locator('.inventory-item').textContent()).includes('Contagem cega'),'Esperado não exibido antes da contagem');
    await inventory.page.locator('.inventory-count-input').fill('6');
    await inventory.page.locator('.inventory-count-form button[type=submit]').click();
    await inventory.page.waitForFunction(()=>document.querySelector('#inventoryTotals').textContent.includes('Conferidos: 1'));
    assert.deepEqual(await ledger(),countBefore);checks++;
    check(inventory.errors.length===0,'Inventário espacial sem erro JavaScript');
    await inventory.context.close();
    console.log(`Fluxos espaciais: ${editorChecks+mapChecks+allocationChecks+replenishChecks+operationChecks+restockChecks+checks} verificações passaram (${editorChecks} editor, ${mapChecks} mapa, ${allocationChecks} distribuição, ${replenishChecks} reposição, ${operationChecks} saída, ${restockChecks} lista, ${checks} inventário); navegador e PGlite artificiais.`);
  }finally{
    if(browser)await browser.close();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    if(db)await db.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
