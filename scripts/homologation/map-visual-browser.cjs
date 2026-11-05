// Build isolado + Auth/RPC/Storage reais SOMENTE no projeto descartável de target.cjs.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {adminClient,BUCKET}=require('./fridge-storage.cjs');
const {client,URL_BASE,PUBLIC_KEY,privateDir,privatePath}=require('./live.cjs');
const {files,build}=require('../build.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
let stage='inicialização',checks=0;
const check=(v,label)=>{assert.ok(v,label);checks++;console.log('PASS '+label);};
const date=days=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
(async()=>{
 const reuse=process.argv.includes('--reuse-fixture');
 const profile=reuse?JSON.parse(fs.readFileSync(privatePath(path.join(privateDir,'visual-ux-auth.json')),'utf8')):null;
 if(profile)assert.equal(profile.projectRef,new URL(URL_BASE).hostname.split('.')[0]);
 const admin=adminClient(),code=randomUUID().slice(0,8),users=profile?.users||{},clients={};
 const shop=profile?.shop||randomUUID(),folder=fs.mkdtempSync(path.join(os.tmpdir(),'guigs-map-ux-'));
 const required=(r,label)=>{if(r.error)throw Error(label);return r.data;};
 stage='fixture artificial';
 if(!reuse)required(await admin.from('guigs_shops').insert({id:shop,name:'Fixture mapa visual UX '+code}),'SHOP');
 for(const role of ['owner','attendant','delegate']){
  if(!reuse){
  const user={email:'ux-'+role+'-'+code+'@example.com',password:randomUUID()+randomUUID()};
  const created=required(await admin.auth.admin.createUser({...user,email_confirm:true}),'AUTH');user.id=created.user.id;users[role]=user;
  required(await admin.from('guigs_memberships').insert({shop_id:shop,user_id:user.id,role:role==='owner'?'owner':'attendant',manage_fridge_layout:role==='delegate'}),'MEMBERSHIP');
  }
  const user=users[role],c=client();required(await c.auth.signInWithPassword({email:user.email,password:user.password}),'LOGIN');clients[role]=c;
 }
 fs.writeFileSync(path.join(privateDir,'visual-ux-auth.json'),JSON.stringify({projectRef:new URL(URL_BASE).hostname.split('.')[0],shop,users}),{mode:0o600});
 const rpc=async(name,args={})=>required(await clients.owner.rpc(name,{p_shop_id:shop,...args}),name);
 if(!reuse){
 const products=[];for(const name of ['Bebida rubi artificial','Bebida cítrica artificial','Água artificial'])products.push(await rpc('guigs_create_product',{p_name:name}));
 for(const [i,p]of products.entries())for(const days of [15,60])await rpc('guigs_receive_stock',{p_product_id:p,p_lot_code:'UX-'+i+'-'+days,p_expiry:date(days),p_quantity:30,p_note:'Fixture artificial UX',p_supplier_id:null});
 const slots=[];
 for(const [index,name,levels]of [[0,'Expositora A · artificial',3],[1,'Expositora B · artificial',4]]){
  const f=await rpc('guigs_save_fridge_layout',{p_kind:'fridge',p_values:{name,width_ratio:1,sort_order:index}});
  for(let j=0;j<levels;j++){
   const h=await rpc('guigs_save_fridge_layout',{p_kind:'shelf',p_values:{name:'Nível '+(j+1),fridge_id:f.id,y_ratio:j/levels,height_ratio:1/levels,sort_order:j}});
   const pieces=index===0?[1,2,2][j]:[3,3,1,1][j];
   for(let k=0;k<pieces;k++){
    const number=slots.length;
    slots.push(await rpc('guigs_save_fridge_layout',{p_kind:'slot',p_values:{name:'Bloco artificial '+(number+1),fridge_id:f.id,shelf_id:h.id,product_id:number===12?null:products[number%3],capacity_quantity:number===11?null:12,min_quantity:4,target_quantity:10,x_ratio:k/pieces,width_ratio:1/pieces,sort_order:k}}));
   }
  }
 }
 for(const [slot,quantity]of [[slots[0],10],[slots[1],2],[slots[2],6]]){
  const quote=await rpc('guigs_get_fridge_replenishment',{p_slot_id:slot.id,p_quantity:quantity});
  await rpc('guigs_replenish_fridge_slot',{p_request_id:randomUUID(),p_slot_id:slot.id,p_quantity:quote.quantity,p_plan:quote.plan});
 }
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
 const imagePath=shop+'/'+products[0]+'/'+randomUUID()+'.png';
 required(await clients.owner.storage.from(BUCKET).upload(imagePath,png,{contentType:'image/png',upsert:false}),'PHOTO');
 await rpc('guigs_set_product_image',{p_product_id:products[0],p_path:imagePath,p_expected_path:null});
 }
 const before=await rpc('guigs_get_fridge_map');
 const attentionSlot=before.slots.find(s=>Number(s.quantity)===2);
 assert.ok(attentionSlot);
 const movementsBefore=required(await clients.owner.from('guigs_movements').select('*').eq('shop_id',shop).order('id'),'LEDGER');
 check(before.fridges.length===2&&before.shelves.length===7&&before.slots.length===13,'Fixture 2/7/13 exclusivamente artificial');
 stage='build homolog';
 const root=path.resolve(__dirname,'../..');
 for(const file of files){const dest=path.join(folder,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,file),dest);}
 const artifact=build({sourceRoot:folder,env:{GUIGS_SUPABASE_URL:URL_BASE,GUIGS_SUPABASE_PUBLISHABLE_KEY:PUBLIC_KEY}});
 const server=http.createServer((req,res)=>{
  const file=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  if(!artifact.files.includes(file)){res.statusCode=404;return res.end();}
  res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.png')?'image/png':'application/json');res.end(fs.readFileSync(path.join(artifact.directory,file)));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 let browser;const errors=[],blocked=[];
 try{
  browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  for(const [role,viewport]of [['owner',{width:1280,height:800}],['attendant',{width:1024,height:768}],['delegate',{width:390,height:844}]]){
   stage='UI '+role;
   const ctx=await browser.newContext({viewport,hasTouch:true,serviceWorkers:'allow'});
   await ctx.route('**/*',r=>{
    const q=r.request(),u=new URL(q.url());
    const auth=u.origin===URL_BASE&&u.pathname.startsWith('/auth/v1/')&&['GET','POST'].includes(q.method());
    const read=['GET','HEAD','OPTIONS'].includes(q.method())&&['127.0.0.1','esm.sh',new URL(URL_BASE).hostname].includes(u.hostname);
    const call=u.pathname.match(/^\/rest\/v1\/rpc\/(guigs_get_fridge_map|guigs_get_history_actors|guigs_get_history|guigs_get_spatial_history|guigs_get_lot_balances|guigs_list_fridge_layout_access|guigs_get_fridge_replenishment)$/);
    const signBase='/storage/v1/object/sign/'+BUCKET;const sign=u.origin===URL_BASE&&(u.pathname===signBase||u.pathname.startsWith(signBase+'/'));
    if(read||auth||u.origin===URL_BASE&&q.method()==='POST'&&(call||sign))return r.continue();
    blocked.push(u.pathname);return r.abort();
   });
   const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
   stage='UI '+role+' login page';await page.goto(base+'/auth-preview.html');
   stage='UI '+role+' login fields';await page.locator('#email').fill(users[role].email);await page.locator('#password').fill(users[role].password);await page.locator('#enter').click();
   stage='UI '+role+' dashboard';await page.waitForSelector('#content:not(.hidden)');await page.click('#navFridges');await page.waitForSelector('#fridgeMap .fridge-slot');
   check(await page.locator('#fridgeMap .fridge-slot').count()===13,'Mapa real '+role+' 13 blocos');
   await page.waitForFunction(()=>[...document.querySelectorAll('#fridgeMap img')].some(i=>i.complete&&i.naturalWidth>0));
   check(true,'URL assinada e imagem real de homolog '+role);
   check(await page.isVisible('#fridgeEdit')===(role!=='attendant'),'Permissão do editor '+role);
   await page.locator('[data-open-slot="'+attentionSlot.id+'"]').tap();
   check(await page.isEnabled('#fridgeDetailReplenish'),'Modal permite reposição '+role);
   check(await page.isVisible('#fridgeDetailEdit')===(role!=='attendant'),'Permissão no modal '+role);
   await page.click('#fridgeDetailReplenish');await page.waitForFunction(()=>!document.querySelector('#fridgeReplenishConfirm').disabled);
   check((await page.textContent('#fridgeReplenishPlan')).includes('UX-1-15'),'Plano FEFO do servidor '+role);
   await page.click('#fridgeReplenishCancel');
   if(role!=='attendant'){
    await page.click('#fridgeEdit');check(await page.locator('#fridgeEditorPreview .fridge-draft-block').count()===13,'Prévia estrutural '+role);
    check(await page.isVisible('#fridgeLayoutAccess')===(role==='owner'),'Delegação administrativa só owner '+role);
    await page.click('#fridgeOperate');
   }
   await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
   const names=await page.evaluate(()=>caches.keys());check(names.includes('guigs-stock-shell-v13'),'PWA v13 '+role);
   await ctx.setOffline(true);await page.waitForFunction(()=>!document.querySelector('#fridgeOffline').classList.contains('hidden'));
   check(await page.isDisabled('#fridgeOperateStock'),'Operação bloqueada offline '+role);
   await page.reload();await page.waitForFunction(()=>document.querySelector('#status')?.textContent.toLowerCase().includes('sem conexão'));
   check(true,'Reload offline '+role);
   await ctx.setOffline(false);await page.reload();await page.waitForSelector('#fridgeMap .fridge-slot');
   check(await page.locator('#fridgeMap .fridge-slot').count()===13,'Reconexão '+role);
   await ctx.close();
  }
  const after=await rpc('guigs_get_fridge_map');assert.deepEqual(after,before);check(true,'Mapa integral de homolog preservado pelo smoke');
  const movementsAfter=required(await clients.owner.from('guigs_movements').select('*').eq('shop_id',shop).order('id'),'LEDGER');
  assert.deepEqual(movementsAfter,movementsBefore);check(true,'Ledger de homolog preservado pelo smoke');
  check(errors.length===0&&blocked.length===0,'Sem erros JS ou tentativas de mutação no navegador');
  fs.writeFileSync(path.join(privateDir,'visual-ux-browser-results.json'),JSON.stringify({projectRef:new URL(URL_BASE).hostname.split('.')[0],shop,checks,passed:true,stage:'complete',fixtureOnly:true},null,2));
  console.log(JSON.stringify({passed:true,checks,project:'homolog',fixtureOnly:true,artifact:folder}));
 }finally{if(blocked.length)console.log(JSON.stringify({blockedPaths:blocked}));if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error('Homologação visual interrompida em '+stage+' ('+e.name+'). Credenciais e respostas privadas omitidas.');process.exitCode=1;});
