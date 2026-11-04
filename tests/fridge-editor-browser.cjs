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
      [args?.p_shop_id,args?.p_kind,JSON.stringify(args?.p_values??null),args?.p_id,args?.p_revision]]
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
  c.rpc=(name,args)=>/^(guigs_get_fridge_map|guigs_save_fridge_layout)$/.test(name)?send({name,args}):original(name,args);
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
    console.log(`Editor espacial: ${checks} verificações passaram; navegador e PGlite artificiais.`);
  }finally{
    if(browser)await browser.close();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    if(db)await db.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
