// Apenas o Supabase descartável fixado em live.cjs, imagens e produtos artificiais.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {client,URL_BASE,PUBLIC_KEY,privateDir,privatePath,loginAll}=require('./live.cjs');
const {files,build}=require('../build.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
let checks=0,stage='setup';const check=(v,label)=>{assert.ok(v,label);checks++;console.log('PASS '+label);};
(async()=>{
 const profile=JSON.parse(fs.readFileSync(privatePath(path.join(privateDir,'visual-ux-auth.json')),'utf8'));
 assert.equal(profile.projectRef,'zthorgwmnigwceobbkoj');assert.equal(new URL(URL_BASE).hostname,profile.projectRef+'.supabase.co');
 const shop=profile.shop,clients={};for(const role of ['owner','attendant','delegate']){const c=client();const r=await c.auth.signInWithPassword(profile.users[role]);assert.ok(!r.error);clients[role]=c;}
 const foreign=(await loginAll()).clients.ownerB;
 const rpc=(c,n,args={})=>c.rpc(n,{p_shop_id:shop,...args});
 const ok=async(c,n,args)=>{const r=await rpc(c,n,args);assert.ok(!r.error,n);return r.data;};
 const before=(await clients.owner.from('guigs_movements').select('*').eq('shop_id',shop).order('id')).data;
 const {storeLibraryImage,deleteLibraryImage}=await import('../../image-library.js');
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'guigs-image-admin-'));const root=path.resolve(__dirname,'../..');
 for(const f of files){const to=path.join(folder,f);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(path.join(root,f),to);}
 const artifact=build({sourceRoot:folder,env:{GUIGS_SUPABASE_URL:URL_BASE,GUIGS_SUPABASE_PUBLISHABLE_KEY:PUBLIC_KEY}});
 const server=http.createServer((req,res)=>{const f=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';if(!artifact.files.includes(f)){res.statusCode=404;return res.end();}res.setHeader('content-type',f.endsWith('.js')?'text/javascript':f.endsWith('.html')?'text/html':f.endsWith('.png')?'image/png':'application/json');res.end(fs.readFileSync(path.join(artifact.directory,f)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 let browser;const allowedDeletes=new Set(),errors=[],blocked=[];
 try{
  browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  for(const role of ['owner','delegate']){
   stage=role;let failDeleteOnce=false,failFinishOnce=false;const context=await browser.newContext({viewport:{width:role==='owner'?1024:360,height:role==='owner'?768:800},hasTouch:true});
   await context.route('**/*',r=>{const q=r.request(),u=new URL(q.url());
    const local=u.hostname==='127.0.0.1',api=u.origin===URL_BASE;
    const read=['GET','HEAD','OPTIONS'].includes(q.method())&&[new URL(URL_BASE).hostname,'127.0.0.1','esm.sh'].includes(u.hostname);
    const auth=api&&u.pathname.startsWith('/auth/v1/')&&q.method()==='POST';
    const call=api&&q.method()==='POST'&&/^\/rest\/v1\/rpc\/guigs_(list_image_admin|edit_product_image|begin_image_delete|finish_image_delete|cancel_image_delete|list_product_images|get_fridge_map|get_history_actors|get_history|get_spatial_history|get_lot_balances|list_fridge_layout_access)$/.test(u.pathname);
    const sign=api&&q.method()==='POST'&&u.pathname==='/storage/v1/object/sign/guigs-product-images';
    const remove=api&&q.method()==='DELETE'&&u.pathname==='/storage/v1/object/guigs-product-images'&&q.postDataJSON()?.prefixes?.every(p=>allowedDeletes.has(p));
    if(remove&&failDeleteOnce){failDeleteOnce=false;return r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Falha de rede simulada no Storage'})});}
    if(call&&failFinishOnce&&u.pathname.endsWith('/guigs_finish_image_delete')){failFinishOnce=false;return r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Falha de rede simulada na confirmação'})});}
    if(read||auth||call||sign||remove)return r.continue();blocked.push(u.pathname);return r.abort();
   });
   const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
   const code=randomUUID().slice(0,8),data=await page.evaluate(color=>{const c=document.createElement('canvas');c.width=3;c.height=3;c.getContext('2d').fillStyle=color;c.getContext('2d').fillRect(0,0,3,3);return c.toDataURL().split(',')[1];},'#'+code.slice(0,6));
   const bytes=Buffer.from(data,'base64'),filename='QA excluir '+code+'.png';
   const uploaded=(await storeLibraryImage(clients.owner,shop,{name:filename,type:'image/png',arrayBuffer:async()=>Uint8Array.from(bytes).buffer})).image;allowedDeletes.add(uploaded.storage_path);
   const p=await ok(clients.owner,'guigs_create_product',{p_name:'QA imagem '+code});
   await ok(clients.owner,'guigs_set_product_image',{p_product_id:p,p_path:uploaded.storage_path,p_expected_path:null});
   for(const who of [clients.attendant,foreign])for(const [name,args]of [
    ['guigs_list_image_admin',{}],['guigs_edit_product_image',{p_image_id:uploaded.id,p_action:'rename',p_display_name:'Negado',p_expected_name:uploaded.display_name,p_expected_active:true}],
    ['guigs_begin_image_delete',{p_image_id:uploaded.id,p_expected_name:uploaded.display_name,p_expected_active:true}],['guigs_finish_image_delete',{p_image_id:uploaded.id}],['guigs_cancel_image_delete',{p_image_id:uploaded.id}]
   ])check(!!(await rpc(who,name,args)).error,'Backend nega '+name+' para '+(who===foreign?'outra loja':'atendente'));
   await page.goto(base+'/auth-preview.html');await page.fill('#email',profile.users[role].email);await page.fill('#password',profile.users[role].password);await page.click('#enter');await page.waitForSelector('#content:not(.hidden)');await page.click('#navFridges');await page.waitForSelector('.fridge-slot');await page.click('#fridgeEdit');await page.click('#fridgeImageLibrary');await page.waitForSelector('.image-library-item');
   check(await page.isVisible('#imageLibraryManage'),'Gerenciar imagens acessível '+role);await page.click('#imageLibraryManage');await page.fill('#imageLibrarySearch',code);await page.waitForFunction(()=>document.querySelector('#imageLibraryMessage').textContent==='1 imagens nesta página.');
   await page.locator('.image-library-item').click();await page.click('#imageAdminDelete');
   check(!(await page.isVisible('#imageDeleteConfirm'))&&(await page.textContent('#imageDeleteWarning')).includes('está sendo utilizada'),'Exclusão em uso bloqueada '+role);await page.click('#imageDeleteCancel');
   check(!!(await rpc(clients[role],'guigs_begin_image_delete',{p_image_id:uploaded.id,p_expected_name:uploaded.display_name,p_expected_active:true})).error,'Backend protege vínculo '+role);
   await page.fill('#imageAdminName','  Nome QA '+code+'  ');await page.click('#imageAdminRename');await page.waitForFunction(()=>document.querySelector('#imageLibraryMessage').textContent==='Nome salvo.');
   let item=(await clients.owner.from('guigs_product_images').select('*').eq('id',uploaded.id).single()).data;
   assert.deepEqual({...item,display_name:uploaded.display_name},uploaded);check(item.display_name==='Nome QA '+code,'Rename altera somente display_name '+role);
   await page.reload();await page.waitForSelector('.fridge-slot');await page.click('#fridgeEdit');await page.click('#fridgeImageLibrary');await page.waitForSelector('.image-library-item');await page.click('#imageLibraryManage');await page.fill('#imageLibrarySearch',code);await page.waitForFunction(()=>document.querySelector('#imageLibraryMessage').textContent==='1 imagens nesta página.');await page.locator('.image-library-item').click();
   check((await page.inputValue('#imageAdminName'))===item.display_name,'Rename após reload '+role);
   await page.click('#imageAdminToggle');await page.click('#imageDeleteConfirm');await page.waitForFunction(()=>document.querySelector('#imageLibraryMessage').textContent.startsWith('Imagem desativada'));
   const bound=await clients.attendant.storage.from('guigs-product-images').download(uploaded.storage_path);check(!bound.error&&Buffer.from(await bound.data.arrayBuffer()).equals(bytes),'Imagem vinculada inativa continua legível '+role);
   await page.click('#imageLibraryManage');await page.waitForFunction(()=>document.querySelector('#imageLibraryMessage').textContent==='Nenhuma imagem encontrada.');check(await page.locator('.image-library-item').count()===0,'Inativa fora da seleção '+role);
   await page.click('#imageLibraryManage');await page.selectOption('#imageAdminFilter','inactive');await page.waitForSelector('.image-library-item');await page.locator('.image-library-item').click();await page.click('#imageAdminToggle');await page.waitForFunction(()=>document.querySelector('#imageLibraryMessage').textContent==='Imagem reativada.');
   check((await ok(clients.attendant,'guigs_list_product_images',{p_search:code})).items.length===1,'Reativa volta ao seletor '+role);
   stage=role+' delete confirmação';
   await ok(clients.owner,'guigs_set_product_image',{p_product_id:p,p_path:null,p_expected_path:uploaded.storage_path});await page.selectOption('#imageAdminFilter','all');await page.waitForSelector('.image-library-item');
   await page.waitForFunction(()=>[...document.querySelectorAll('.image-library-item img')].every(i=>i.complete&&i.naturalWidth>0));
   await page.locator('.image-library-item').click();await page.click('#imageAdminDelete');
   check(await page.isVisible('#imageDeletePhoto')&&await page.isVisible('#imageDeleteConfirm'),'Modal próprio com foto e confirmação '+role);await page.click('#imageDeleteCancel');
   check(!(await clients.owner.storage.from('guigs-product-images').download(uploaded.storage_path)).error,'Cancelar não remove arquivo '+role);
   if(role==='owner')failDeleteOnce=true;else failFinishOnce=true;
   await page.click('#imageAdminDelete');await page.click('#imageDeleteConfirm');
   await page.waitForFunction(()=>document.querySelector('#imageLibraryMessage').textContent.includes('Se houver exclusão pendente'));
   await page.locator('.image-library-item').click();
   check((await page.textContent('#imageAdminSelected')).includes('Exclusão pendente'),'Falha intermediária visível e retomável '+role);
   if(role==='owner'){
    await page.click('#imageAdminRestore');await page.waitForFunction(()=>document.querySelector('#imageLibraryMessage').textContent.startsWith('Exclusão cancelada'));
    check(!(await clients.owner.storage.from('guigs-product-images').download(uploaded.storage_path)).error,'Cancelar pendência preserva objeto '+role);
    await page.locator('.image-library-item').click();
   }else check(await page.isDisabled('#imageAdminRestore'),'Arquivo removido não permite restauração fictícia '+role);
   await page.click('#imageAdminDelete');await page.click('#imageDeleteConfirm');await page.waitForFunction(()=>document.querySelector('#imageLibraryMessage').textContent==='Imagem excluída permanentemente.');
   check((await clients.owner.from('guigs_product_images').select('id').eq('id',uploaded.id)).data.length===0,'Registro removido '+role);
   const session=await clients.owner.auth.getSession();
   const fresh=await fetch(URL_BASE+'/storage/v1/object/authenticated/guigs-product-images/'+uploaded.storage_path+'?qa='+randomUUID(),{headers:{apikey:PUBLIC_KEY,Authorization:'Bearer '+session.data.session.access_token},cache:'no-store'});
   check(!fresh.ok&&[400,404].includes(fresh.status),'Objeto removido pela API (leitura sem cache) '+role);
   check((await ok(clients.owner,'guigs_list_image_admin',{p_search:code})).items.length===0,'Sem exclusão pendente '+role);
   await context.close();
  }
  assert.deepEqual((await clients.owner.from('guigs_movements').select('*').eq('shop_id',shop).order('id')).data,before);check(true,'Ledger artificial preservado');
  check(errors.length===0&&blocked.length===0,'Sem erro JS ou escrita fora da biblioteca');
  fs.writeFileSync(path.join(privateDir,'image-admin-results.json'),JSON.stringify({checks,passed:true,projectRef:profile.projectRef,fixtureOnly:true}));
  console.log(JSON.stringify({checks,passed:true,project:'homolog',fixtureOnly:true}));
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error('Administração em homologação interrompida em '+stage+' ('+e.name+'). '+(e instanceof assert.AssertionError?e.message.slice(0,140):'Detalhes privados omitidos.'));process.exitCode=1;});
