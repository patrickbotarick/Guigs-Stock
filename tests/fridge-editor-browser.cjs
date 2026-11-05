const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const {fixture}=require('./browser.cjs');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
const {files}=require('../scripts/build.cjs');
const {randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..'),allowed=new Set(files),shop=id(10);
let checks=0,db,pending=Promise.resolve();
function check(value,msg){assert.ok(value,msg);checks++;}
async function snapshot(page,name){if(process.env.TEST_ARTIFACTS_DIR){fs.mkdirSync(process.env.TEST_ARTIFACTS_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.TEST_ARTIFACTS_DIR,'map-'+name+'.png')});}}
async function dispatch({role,table,name,args}){
  if(!['owner','attendant'].includes(role))throw Error('Perfil de fixture inválido');
  const tables={guigs_products:'public.guigs_products',guigs_lots:'public.guigs_lots',guigs_suppliers:'public.guigs_suppliers'};
  const calls={
    guigs_register_product_image:['select public.guigs_register_product_image($1,$2,$3,$4,$5,$6,$7) data',[args?.p_shop_id,args?.p_path,args?.p_original_filename,args?.p_display_name,args?.p_mime_type,args?.p_bytes,args?.p_sha256]],
    guigs_list_product_images:['select public.guigs_list_product_images($1,$2,$3,$4) data',[args?.p_shop_id,args?.p_search,args?.p_limit,args?.p_offset]],
    guigs_set_product_image:['select public.guigs_set_product_image($1,$2,$3,$4) as data',[args?.p_shop_id,args?.p_product_id,args?.p_path,args?.p_expected_path]],
    guigs_list_fridge_layout_access:['select public.guigs_list_fridge_layout_access($1) as data',[args?.p_shop_id]],
    guigs_set_fridge_layout_access:['select public.guigs_set_fridge_layout_access($1,$2,$3) as data',[args?.p_shop_id,args?.p_user_id,args?.p_allowed]],
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
      [args?.p_shop_id,args?.p_inventory_id,args?.p_item_id,args?.p_quantity,args?.p_version]],
    guigs_get_spatial_history:['select public.guigs_get_spatial_history($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as data',
      [args?.p_shop,args?.p_limit,args?.p_offset,args?.p_product,args?.p_type,args?.p_actor,args?.p_date_from,args?.p_date_to,args?.p_search,args?.p_partition]],
    guigs_get_reports:['select public.guigs_get_reports($1,$2,$3,$4,$5,$6) as data',
      [args?.p_shop_id,args?.p_from,args?.p_to,args?.p_limit,args?.p_loss_offset,args?.p_inventory_offset]]
  };
  return asUser(db,role,async tx=>{
    if(name==='storage_upload'){
      if(!['image/png','image/jpeg','image/webp'].includes(args.type)||args.size>2097152)throw Error('Arquivo inválido');
      await tx.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)',['guigs-product-images',args.name,JSON.stringify({mimetype:args.type,size:args.size})]);return {path:args.name};
    }
    if(name==='storage_remove')return (await tx.query('delete from storage.objects where name=any($1) returning name',[args.names])).rows;
    if(table==='guigs_product_images')return(await tx.query('select * from public.guigs_product_images where shop_id=$1 and sha256=$2',[shop,args.sha])).rows;
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
  c.supabaseUrl=location.origin;
  const fixturePng=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0));
  c.storage={from:()=>({upload:(name,bytes,opts)=>send({name:'storage_upload',args:{name,type:opts.contentType,size:bytes.length}}),download:async()=>({data:new Blob([fixturePng]),error:null}),remove:names=>send({name:'storage_remove',args:{names}}),createSignedUrls:async paths=>({data:paths.map(path=>({path,signedUrl:location.origin+'/storage/v1/object/sign/guigs-product-images/'+path}))})})};
  c.rpc=(name,args)=>/^(guigs_register_product_image|guigs_list_product_images|guigs_set_product_image|guigs_list_fridge_layout_access|guigs_set_fridge_layout_access|guigs_get_fridge_map|guigs_save_fridge_layout|guigs_allocate_fridge_stock|guigs_get_fridge_replenishment|guigs_replenish_fridge_slot|guigs_get_fridge_operation|guigs_apply_fridge_operation|guigs_list_inventories|guigs_create_spatial_inventory|guigs_get_spatial_inventory|guigs_count_spatial_inventory_item|guigs_get_spatial_history|guigs_get_reports)$/.test(name)?send({name,args}):original(name,args);
  c.from=table=>{
    if(table==='guigs_product_images')return {select(){return this},eq(k,v){if(k==='sha256')this.sha=v;return this},async maybeSingle(){const r=await send({table,args:{sha:this.sha}});return {data:r.data?.[0]||null,error:r.error}}};
    if(table==='guigs_memberships')return {select(){return this},eq(){return this},then(a,b){return Promise.resolve({data:[{shop_id:shop,role,active:true}],error:null}).then(a,b)}};
    if(!['guigs_products','guigs_lots','guigs_suppliers'].includes(table))return originalFrom(table);
    return {select(){return this},eq(){return this},range(){return this},then(a,b){return send({table}).then(a,b)}};
  };
}
(async()=>{
  let browser;
  try{
    db=await createTestDatabase();
    await db.exec("create schema storage;create table storage.objects(bucket_id text,name text,metadata jsonb default jsonb_build_object('size','1','mimetype','image/png'),primary key(bucket_id,name));alter table storage.objects enable row level security;grant usage on schema storage to authenticated;grant select,insert,update,delete on storage.objects to authenticated;");
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261104123035_spatial_fridge_foundation.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261104124433_spatial_fridge_allocation.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261104124855_spatial_fridge_replenishment.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261104125329_spatial_fridge_operations.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261104125833_spatial_fridge_inventory.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261104130828_spatial_fridge_observability.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261104183000_spatial_fridge_pending_capacity.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261105120000_modular_fridge_layout_access.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261104132033_spatial_fridge_product_images.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261105124008_map_image_storage_access.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261105170140_product_image_library.sql'),'utf8'));
    const ledger=()=>db.query('select id,delta,slot_id from public.guigs_movements order by id').then(r=>r.rows);
    const before=await ledger();
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url='http://127.0.0.1:'+server.address().port+'/#geladeiras';
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
    async function open(role,viewport){
      const context=await browser.newContext({viewport,hasTouch:viewport.width<=1280,serviceWorkers:'block'});
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
    const fill=async(name,value)=>{const input=page.locator('#fridgeField_'+name),advanced=input.locator('xpath=ancestor::details');if(await advanced.count()&&(await advanced.getAttribute('open'))===null)await advanced.locator('summary').click();await input.fill(String(value));};
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
    await fill('name','Coca A1');await fill('width_ratio',60);await fill('target_quantity',12);await fill('min_quantity',4);check(await page.inputValue('#fridgeField_capacity_quantity')==='','Capacidade começa em branco');
    const x=await save();
    await page.click('#fridgeOperate');
    const pendingCard=page.locator('[data-slot-id="'+x+'"]');
    check((await pendingCard.textContent()).includes('Configuração pendente'),'Mapa mostra estado pendente');
    check(await pendingCard.locator('meter,[data-replenish]').count()===0,'Pendência não calcula ocupação nem oferece reposição');
    await pendingCard.locator('button').click();
    check(await page.locator('#fridgeDetailDialog').isVisible(),'Toque no bloco pendente abre modal');
    check((await page.textContent('#fridgeDetailBody')).includes('Defina a capacidade'),'Modal explica capacidade pendente');
    check(await page.locator('#fridgeDetailBody meter').count()===0,'Pendência não mostra ocupação falsa');
    check(await page.isDisabled('#fridgeDetailReplenish'),'Repor bloqueado sem capacidade');
    await page.keyboard.press('Escape');
    check(await pendingCard.locator('button').evaluate(e=>e===document.activeElement),'Escape devolve foco ao bloco');
    await page.click('#fridgeEdit');await page.selectOption('#fridgeEditItem',x);
    check(await page.inputValue('#fridgeField_capacity_quantity')==='','Capacidade pendente foi persistida');
    await fill('capacity_quantity',18);await save();
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
    await mobile.page.waitForSelector('#fridgeMap [data-open-slot]');
    check(!(await mobile.page.isVisible('#fridgeEdit')),'Atendente sem editor');
    check(await mobile.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile sem rolagem horizontal global');
    check(mobile.errors.length===0,'Sem erro JavaScript mobile');
    await mobile.context.close();
    const delegator=await open('owner',{width:1200,height:850});
    await delegator.page.click('#fridgeEdit');
    await delegator.page.locator('#fridgeLayoutAccessList input').check();
    await delegator.page.waitForFunction(()=>!document.querySelector('#fridgeLayoutAccessList input').disabled);
    check((await db.query('select manage_fridge_layout from public.guigs_memberships where user_id=$1',[id(2)])).rows[0].manage_fridge_layout,'Owner delega capacidade pelo editor');
    await delegator.context.close();
    const authorized=await open('attendant',{width:820,height:900});
    await authorized.page.waitForFunction(()=>!document.querySelector('#fridgeEdit').disabled);
    check(await authorized.page.isVisible('#fridgeEdit'),'Atendente autorizado vê editor');
    await authorized.page.click('#fridgeEdit');
    check(!(await authorized.page.isVisible('#fridgeLayoutAccess')),'Delegado não administra permissões');
    check(await authorized.page.isEnabled('#fridgeImageUpload'),'Delegado pode enviar fotos');
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
    const uploadPhoto=async()=>{
      await authorized.page.setInputFiles('#fridgeImageFile',{name:'artificial.png',mimeType:'image/png',buffer:png});
      await authorized.page.click('#fridgeImageUpload');
      await authorized.page.waitForFunction(()=>document.querySelector('#fridgeImageMessage').textContent==='Foto salva.'&&!document.querySelector('#fridgeImageUpload').disabled);
    };
    await uploadPhoto();
    const first=(await db.query('select image_path from public.guigs_products where id=$1',[id(20)])).rows[0].image_path;
    check(!!first,'Upload UI vincula imagem');
    await uploadPhoto();
    check((await db.query('select count(*)::int as n from storage.objects')).rows[0].n===1,'Duplicata UI reutiliza objeto pelo hash');
    await authorized.page.selectOption('#fridgeImageProduct',id(21));await authorized.page.click('#fridgeImageLibrary');
    await authorized.page.waitForSelector('.image-library-item');
    check(await authorized.page.locator('.image-library-item').count()===1,'Seletor carrega catálogo da loja');
    await authorized.page.fill('#imageLibrarySearch','COCA');
    await authorized.page.waitForFunction(()=>document.querySelector('#imageLibraryMessage').textContent==='1 imagens nesta página.');
    await authorized.page.locator('.image-library-item').first().click();await authorized.page.click('#imageLibraryApply');
    await authorized.page.waitForFunction(()=>document.querySelector('#imageLibraryMessage').textContent==='Imagem associada ao produto.');
    const linked=(await db.query('select image_path from public.guigs_products order by id')).rows;
    check(linked[0].image_path===linked[1].image_path,'Mesmo arquivo reutilizado em dois produtos');
    await authorized.page.click('#imageLibraryUnlink');try{await authorized.page.waitForFunction(()=>document.querySelector('#imageLibraryMessage').textContent.startsWith('Associação removida'));}catch{throw Error('Desvincular biblioteca: '+await authorized.page.textContent('#imageLibraryMessage'));}
    check((await db.query('select count(*)::int n from storage.objects')).rows[0].n===1,'Desvincular no seletor preserva arquivo compartilhado');
    await authorized.page.click('#imageLibraryClose');
    await authorized.page.reload();await authorized.page.click('#fridgeEdit');
    check(await authorized.page.isEnabled('#fridgeImageRemove'),'Reload mantém imagem vinculada');
    await authorized.page.click('#fridgeImageRemove');await authorized.page.click('#confirmOperation');
    await authorized.page.waitForFunction(()=>document.querySelector('#fridgeImageMessage').textContent==='Associação removida. O arquivo continua na biblioteca.');
    check((await db.query('select count(*)::int as n from storage.objects')).rows[0].n===1,'Remoção UI preserva arquivo na biblioteca');
    await authorized.page.selectOption('#fridgeEditKind','slot');
    await authorized.page.selectOption('#fridgeEditItem',x);
    await authorized.page.locator('.fridge-advanced summary').click();
    await authorized.page.fill('#fridgeField_width_ratio','45');
    await authorized.page.click('#fridgeSaveLayout');
    await authorized.page.waitForFunction(()=>document.querySelector('#fridgeMessage').textContent.startsWith('Layout salvo'));
    check(Number((await db.query('select width_ratio from public.guigs_fridge_slots where id=$1',[x])).rows[0].width_ratio)===.45,'Delegado salva proporção');
    const handle=authorized.page.getByRole('button',{name:'Redimensionar bloco',exact:true});
    await handle.scrollIntoViewIfNeeded();const box=await handle.boundingBox();await authorized.page.mouse.move(box.x+box.width/2,box.y+box.height/2);await authorized.page.mouse.down();await authorized.page.mouse.move(box.x+box.width/2+35,box.y+box.height/2,{steps:5});await authorized.page.mouse.up();
    check(Number(await authorized.page.inputValue('#fridgeField_width_ratio'))>45,'Handle redimensiona rascunho');
    check(Number((await db.query('select width_ratio from public.guigs_fridge_slots where id=$1',[x])).rows[0].width_ratio)===.45,'Arraste não persiste sem salvar');
    await snapshot(authorized.page,'editor');
    const structureCountBefore=(await db.query('select count(*)::int n from public.guigs_fridge_slots')).rows[0].n;
    await authorized.page.getByRole('button',{name:'Duplicar estrutura'}).click();
    check(await authorized.page.inputValue('#fridgeField_product_id')==='','Duplicar não associa produto');
    check(await authorized.page.inputValue('#fridgeField_capacity_quantity')==='','Duplicar não inventa capacidade');
    check((await db.query('select count(*)::int n from public.guigs_fridge_slots')).rows[0].n===structureCountBefore,'Duplicar prepara rascunho sem escrita');
    await asUser(db,'owner',tx=>tx.query('select public.guigs_set_fridge_layout_access($1,$2,false)',[shop,id(2)]));
    await authorized.page.click('#fridgeReload');
    await authorized.page.waitForFunction(()=>document.querySelector('#fridgeEdit').classList.contains('hidden'));
    check(!(await authorized.page.isVisible('#fridgeEditor')),'Revogação oculta editor na próxima leitura');
    await authorized.context.close();
    assert.deepEqual(await ledger(),before);checks++;
    const editorChecks=checks;checks=0;
    const {fridgeSlotState}=await import('../fridges.js');
    for(const [quantity,expected] of [[0,'VAZIO'],[1,'CRÍTICO'],[2,'ATENÇÃO'],[4,'OK'],[6,'OK']])
      check(fridgeSlotState({quantity,min_quantity:2,target_quantity:4,capacity_quantity:6})===expected,'Estado no limite '+quantity);
    const create=async(kind,values)=>(await dispatch({role:'owner',name:'guigs_save_fridge_layout',args:{p_shop_id:shop,p_kind:kind,p_values:values,p_id:null,p_revision:null}}));
    const critical=await create('slot',{fridge_id:a,shelf_id:h,name:'Crítico',product_id:id(20),min_quantity:2,target_quantity:4,capacity_quantity:6,x_ratio:.15,width_ratio:.2});
    const ok=await create('slot',{fridge_id:a,shelf_id:h,name:'Pronto',product_id:id(20),min_quantity:1,target_quantity:2,capacity_quantity:6,x_ratio:.75,width_ratio:.25});
    await create('slot',{fridge_id:a,shelf_id:h,name:'Vazio',product_id:id(20),capacity_quantity:24,x_ratio:0,width_ratio:.15});
    await db.transaction(async tx=>{
      const e=(await tx.query('select gen_random_uuid() as id')).rows[0].id;
      for(const [slot,delta] of [[null,-7],[x,4],[critical.id,1],[ok.id,2]])
        await tx.query("insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,slot_id,spatial) values($1,$2,$3,'adjust','fridge',$4,$5,$6,true)",[shop,id(30),e,delta,id(1),slot]);
    });
    const waitMap=p=>p.waitForSelector('.fridge-unallocated');
    const desktop=await open('attendant',{width:1440,height:950});await waitMap(desktop.page);
    check(await desktop.page.locator('.fridge-cabinet').count()===2,'Duas geladeiras em desktop');
    check(await desktop.page.locator('.fridge-cabinet').evaluateAll(ns=>Math.abs(ns[0].getBoundingClientRect().top-ns[1].getBoundingClientRect().top)<2),'Geladeiras lado a lado quando há espaço');
    for(const state of ['Vazio','Crítico','Atenção','Em dia'])
      check(await desktop.page.locator('#fridgeMap .fridge-state').filter({hasText:state}).count()===1,'Mapa exibe estado '+state);
    check(await desktop.page.locator('#fridgeMap .fridge-photo-fallback').count()===4,'Placeholders sem imagem');
    check((await desktop.page.locator('.fridge-unallocated').textContent()).includes('1 un. sem posição física'),'Saldo não alocado separado do mapa');
    check(await desktop.page.locator('#fridgeMap meter,#fridgeMap [data-replenish],#fridgeMap .fridge-slot details').count()===0,'Mapa compacto sem medidores, lotes ou botões técnicos');
    check(!await desktop.page.locator('#fridgeMap').textContent().then(t=>t.includes('Mínimo')||t.includes('Meta')),'Mínimo e meta fora da tela principal');
    await snapshot(desktop.page,'desktop');
    const slot=desktop.page.locator('[data-slot-id="'+x+'"]');
    await slot.locator('button').click();
    check(await desktop.page.getByRole('meter',{name:'Ocupação de Coca A1'}).count()===1,'Ocupação com nome acessível no modal');
    check((await desktop.page.textContent('#fridgeDetailBody')).includes('Bloco ativo'),'Modal mantém configuração ativa derivada do ledger');
    check(!(await desktop.page.isVisible('#fridgeDetailEdit')),'Atendente comum não vê edição no modal');
    check(!(await desktop.page.isVisible('#fridgeDetailProduct')),'Atendente comum não troca produto');
    check(await desktop.page.isEnabled('#fridgeDetailReplenish'),'Atendente pode usar reposição existente');
    await desktop.page.click('#fridgeDetailLibrary');await desktop.page.waitForSelector('.image-library-item');
    check(!(await desktop.page.isVisible('#imageLibraryApply')),'Atendente comum não associa imagem');
    check(!(await desktop.page.isVisible('#imageLibraryUploadLabel')),'Atendente comum não recebe upload');
    check(!(await desktop.page.isVisible('#imageLibraryUnlink')),'Atendente comum não remove associação');
    await desktop.page.click('#imageLibraryClose');await slot.locator('button').click();
    await snapshot(desktop.page,'modal');
    await desktop.page.locator('#fridgeDetailLots summary').focus();await desktop.page.keyboard.press('Enter');
    check(await desktop.page.locator('#fridgeDetailLots[open]').count()===1,'Validade acessível por teclado');
    await desktop.page.keyboard.press('Escape');
    await desktop.page.emulateMedia({reducedMotion:'reduce'});
    check(await desktop.page.locator('.fridge-slot-open').first().evaluate(e=>getComputedStyle(e).transitionDuration==='0s'),'Reduced motion elimina transições');
    const imagePath=shop+'/'+id(20)+'/'+id(404)+'.png';
    await db.query('update public.guigs_products set image_path=$1 where id=$2',[imagePath,id(20)]);
    await desktop.page.route('**/storage/v1/object/sign/**',r=>r.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')}));
    await desktop.page.reload();await desktop.page.waitForSelector('#fridgeMap img.fridge-photo');
    await desktop.page.waitForFunction(()=>[...document.querySelectorAll('#fridgeMap img')].every(i=>i.complete&&i.naturalWidth>0));
    check(await desktop.page.locator('#fridgeMap img.fridge-photo').first().evaluate(e=>getComputedStyle(e).objectFit==='contain'),'Thumbnail carregado e proporcional');
    await desktop.page.route('**/storage/v1/object/sign/**',r=>r.abort());await desktop.page.reload();
    await desktop.page.waitForFunction(()=>document.querySelectorAll('#fridgeMap .fridge-photo-fallback').length===4);
    check(await desktop.page.locator('#fridgeMap img').count()===0,'Arquivo ausente volta ao placeholder');
    await db.query('update public.guigs_products set image_path=null where id=$1',[id(20)]);
    check(desktop.errors.length===0,'Mapa sem erro JavaScript');
    await desktop.context.close();
    for(const viewport of [{width:1280,height:800},{width:1024,height:768}]){
      const touch=await open('attendant',viewport);await waitMap(touch.page);
      check(await touch.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Tablet '+viewport.width+' sem overflow');
      await touch.page.locator('[data-open-slot]').first().tap();
      check(await touch.page.locator('#fridgeDetailDialog').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}),'Modal cabe no tablet '+viewport.width);
      await touch.page.keyboard.press('Escape');await touch.page.locator('#fridgeMap').scrollIntoViewIfNeeded();await snapshot(touch.page,'tablet-'+viewport.width);await touch.context.close();
    }
    const volume=await open('attendant',{width:1280,height:800});await waitMap(volume.page);
    await volume.page.route('**/fixture',async route=>{
      if(route.request().postDataJSON().name!=='guigs_get_fridge_map')return route.fallback();
      const response=await route.fetch(),payload=await response.json();
      payload.data.slots=Array.from({length:100},(_,i)=>({...payload.data.slots[0],id:randomUUID(),name:'Bloco artificial '+i,x_ratio:(i%3)/3,width_ratio:1/3,sort_order:i}));
      return route.fulfill({response,json:payload});
    });
    const began=performance.now();await volume.page.click('#fridgeReload');await volume.page.waitForFunction(()=>document.querySelectorAll('#fridgeMap .fridge-slot').length===100);
    const renderMs=Math.round(performance.now()-began);check(renderMs<3000,'Leitura e render de 100 blocos em menos de 3s');
    console.log('Mapa DOM 100 blocos artificiais: '+renderMs+' ms.');
    await volume.page.locator('[data-open-slot]').first().click();check(await volume.page.locator('#fridgeDetailDialog').isVisible(),'Modal funciona com 100 blocos');await volume.context.close();
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
    check(await small.page.locator('#fridgeMap .fridge-slot-open').evaluateAll(rows=>rows.every(e=>{const r=e.getBoundingClientRect();return r.width>=44&&r.height>=44;})),'Alvos do mapa confortáveis no celular');
    await small.page.locator('[data-open-slot]').first().tap();
    check(await small.page.locator('#fridgeDetailDialog').evaluate(e=>e.getBoundingClientRect().width<=innerWidth),'Modal cabe em 360px');
    await snapshot(small.page,'mobile-modal');await small.page.keyboard.press('Escape');
    await small.context.close();
    const mapChecks=checks;checks=0;
    const owner=await open('owner',{width:390,height:844});await waitMap(owner.page);
    const beforeCancel=await ledger();
    await owner.page.locator('#fridgeMoreActions summary').click();
    await owner.page.click('#fridgeAllocate');await owner.page.fill('#allocate-'+x,'1');await owner.page.click('#fridgeCancelAllocation');
    assert.deepEqual(await ledger(),beforeCancel);checks++;
    await owner.page.click('#fridgeAllocate');await owner.page.fill('#allocate-'+x,'1');
    check((await owner.page.textContent('#fridgeAllocationSummary')).includes('Restam não alocadas: 0'),'Resumo antes da confirmação');
    await owner.page.click('#fridgeConfirmAllocation');
    await owner.page.waitForFunction(()=>document.querySelector('.fridge-unallocated').textContent.includes('0 un. sem posição física'));
    check((await owner.page.locator('[data-slot-id="'+x+'"]').textContent()).includes('5 un.'),'Mapa atualizado depois da distribuição');
    check((await db.query("select sum(delta)::int as n from public.guigs_movements where location='fridge'")).rows[0].n===8,'Saldo global preservado pelo fluxo UI');
    check(owner.errors.length===0,'Fluxo de distribuição sem erro JavaScript');
    let offlineChecks=0;
    const offline=(value,label)=>{assert.ok(value,label);offlineChecks++;};
    await owner.page.locator('[data-open-slot="'+x+'"]').click();await owner.context.setOffline(true);
    await owner.page.waitForFunction(()=>!document.querySelector('#fridgeOffline').classList.contains('hidden'));
    offline((await owner.page.locator('[data-slot-id="'+x+'"]').textContent()).includes('5 un.'),'Mapa anterior permanece visível offline');
    for(const selector of ['#fridgeEdit','#fridgeAllocate','#fridgeOperateStock','#fridgeDetailReplenish'])
      offline(await owner.page.isDisabled(selector),'Operação bloqueada offline: '+selector);
    await owner.context.setOffline(false);
    await owner.page.waitForFunction(()=>document.querySelector('#status').textContent.includes('sincronizado')
      &&!document.querySelector('#fridgeOperateStock').disabled&&!document.querySelector('#fridgeEdit').disabled);
    offline(await owner.page.isEnabled('#fridgeEdit'),'Reconexão restaura ações');
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
    await worker.page.locator('[data-open-slot="'+x+'"]').click();await worker.page.click('#fridgeDetailReplenish');
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
    await worker.page.waitForFunction(slot=>document.querySelector('[data-slot-id="'+slot+'"]').textContent.includes('8 un.'),x);
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
    await worker.page.waitForFunction(slot=>document.querySelector('[data-slot-id="'+slot+'"]').textContent.includes('7 un.'),x);
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
    const restockChecks=checks;checks=0;
    await worker.page.click('#fridgeOperateStock');
    await worker.page.selectOption('#fridgeStockKind','loss');
    await worker.page.selectOption('#fridgeStockOrigin',x);
    await worker.page.fill('#fridgeStockQuantity','1');
    await worker.page.fill('#fridgeStockNote','=Fórmula artificial');
    await worker.page.click('#fridgeStockQuote');
    await worker.page.waitForFunction(()=>!document.querySelector('#fridgeStockConfirm').disabled);
    await worker.page.click('#fridgeStockConfirm');
    await worker.page.waitForFunction(()=>!document.querySelector('#fridgeStockDialog').open&&!document.querySelector('#refresh').disabled);
    await worker.page.click('#navHistory');
    await worker.page.selectOption('#historyPartition','slot');
    await worker.page.waitForFunction(()=>document.querySelector('#history').textContent.includes('Estoque seco → Geladeira A'));
    check(await worker.page.locator('#history tr').filter({hasText:'Venda'}).count()===1,'Venda split agrupada no histórico');
    check(await worker.page.locator('#history tr').filter({hasText:'Coca A1'}).count()>1,'Histórico exibe destino/origem física');
    await worker.page.selectOption('#historyPartition','unallocated');
    await worker.page.waitForFunction(()=>!document.querySelector('#history').textContent.includes('Fórmula artificial'));
    check((await worker.page.textContent('#history')).includes('Geladeira — não alocado'),'Filtro inclui partição legada sem inventar posição');
    await worker.context.close();
    const historyChecks=checks;checks=0;
    const countBefore=await ledger();
    const inventory=await open('owner',{width:390,height:844});
    await inventory.page.click('#navReports');
    await inventory.page.waitForFunction(()=>document.querySelector('#reportsMessage').textContent.includes('Período aplicado'));
    check((await inventory.page.textContent('#reportsFridgeSummary')).includes('Venda: 4 un.'),'Relatório agrega venda por geladeira');
    const download=inventory.page.waitForEvent('download');
    await inventory.page.click('#reportsExport');
    const csv=fs.readFileSync(await (await download).path(),'utf8');
    check(csv.includes('"Local"')&&csv.includes('Geladeira A / A1 / Coca A1')&&csv.includes("'=Fórmula"),'CSV inclui posição e neutraliza fórmula');
    const reportingChecks=checks;checks=0;
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
    await inventory.context.setOffline(true);
    await inventory.page.waitForFunction(()=>document.querySelector('#newSpatialInventory').disabled);
    offline(await inventory.page.isDisabled('#inventoryReview'),'Inventário espacial sem mutações offline');
    await inventory.context.close();
    console.log(`Fluxos espaciais: ${editorChecks+mapChecks+allocationChecks+replenishChecks+operationChecks+restockChecks+historyChecks+reportingChecks+checks+offlineChecks} verificações passaram (${editorChecks} editor, ${mapChecks} mapa, ${allocationChecks} distribuição, ${replenishChecks} reposição, ${operationChecks} saída, ${restockChecks} lista, ${historyChecks+reportingChecks} observabilidade, ${checks} inventário, ${offlineChecks} offline); navegador e PGlite artificiais.`);
  }finally{
    if(browser)await browser.close();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    if(db)await db.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
