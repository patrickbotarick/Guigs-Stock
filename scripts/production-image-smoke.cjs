// Smoke explicitamente somente leitura em produção; login manual, sem credenciais em arquivos/logs.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const base='https://guigs-stock.pages.dev',api='https://wddbhtxkbrhsjewuaekv.supabase.co';
let stage='início',checks=0;const check=(v,label)=>{assert.ok(v,label);checks++;console.log('PASS '+label);};
(async()=>{
 if(!process.argv.includes('--attendant'))throw Error('Perfil explícito obrigatório');
 const browser=await chromium.launch({headless:false,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 const ctx=await browser.newContext({viewport:{width:1024,height:768},hasTouch:true,serviceWorkers:'allow'}),blocked=[],errors=[];
 let memberships=[];
 try{
  await ctx.route('**/*',r=>{const q=r.request(),u=new URL(q.url());
   const read=['GET','HEAD','OPTIONS'].includes(q.method())&&[new URL(base).hostname,new URL(api).hostname,'esm.sh'].includes(u.hostname);
   const auth=u.origin===api&&u.pathname.startsWith('/auth/v1/')&&q.method()==='POST';
   const call=u.origin===api&&q.method()==='POST'&&/^\/rest\/v1\/rpc\/guigs_(get_fridge_map|get_history_actors|get_history|get_spatial_history|get_lot_balances|list_product_images)$/.test(u.pathname);
   const sign=u.origin===api&&q.method()==='POST'&&u.pathname==='/storage/v1/object/sign/guigs-product-images';
   if(read||auth||call||sign)return r.continue();blocked.push(u.pathname);return r.abort();
  });
  const page=await ctx.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.name));
  page.on('response',async r=>{const u=new URL(r.url());if(u.origin===api&&u.pathname==='/rest/v1/guigs_memberships'&&r.ok()){try{memberships=await r.json();}catch{}}});
  stage='login manual 1';await page.goto(base+'/auth-preview');console.log('READY_FOR_ATTENDANT_LOGIN');
  const verify=async()=>{
   await page.waitForSelector('#content:not(.hidden)',{timeout:0});await page.click('#navFridges');await page.waitForSelector('.fridge-slot');
   check(memberships.some(m=>m.role==='attendant'&&m.active!==false),'Membership real de atendente');
   check(!(await page.isVisible('#fridgeEdit')),'Editor restrito');check(await page.locator('.fridge-slot').count()===13,'Treze blocos');
   const slot=page.getByRole('button',{name:/^POTY 2L ·/});await slot.waitFor();
   await page.waitForFunction(()=>[...document.querySelectorAll('#fridgeMap img')].some(i=>i.complete&&i.naturalWidth>0));check(true,'POTY no bloco com foto carregada');
   await slot.click();await page.waitForFunction(()=>[...document.querySelectorAll('#fridgeDetailDialog img')].some(i=>i.complete&&i.naturalWidth>0));check(true,'POTY no modal com foto carregada');
   await page.click('#fridgeDetailLibrary');await page.waitForSelector('.image-library-item');check(!(await page.isVisible('#imageLibraryManage')),'Atendente sem administração');
   await page.fill('#imageLibrarySearch','Poty 2L');await page.waitForFunction(()=>document.querySelector('#imageLibraryMessage').textContent==='1 imagens nesta página.');
   await page.waitForFunction(()=>[...document.querySelectorAll('.image-library-item img')].every(i=>i.complete&&i.naturalWidth>0));check(true,'POTY na biblioteca com thumbnail');
   await page.click('#imageLibraryClose');
  };
  await verify();stage='reload';await page.reload();await verify();
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);check((await page.evaluate(()=>caches.keys())).includes('guigs-stock-shell-v15'),'PWA v15 ativa');
  stage='offline';await ctx.setOffline(true);await page.reload();await page.waitForFunction(()=>document.querySelector('#status')?.textContent.toLowerCase().includes('sem conexão'));check(true,'Reload offline publicado');
  await ctx.setOffline(false);await page.reload();await verify();
  stage='logout/login';await page.click('#signout');await page.waitForSelector('#email');console.log('READY_FOR_ATTENDANT_SECOND_LOGIN');await verify();
  check(errors.length===0&&blocked.length===0,'Sem erros JS ou tentativa de escrita operacional');
  const folder=path.join(os.tmpdir(),'guigs-v16-private');fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,'image-admin-production-attendant.json'),JSON.stringify({passed:true,checks,role:'attendant',productionReadOnly:true,code:'587931a'},null,2));
  console.log(JSON.stringify({passed:true,checks,role:'attendant',productionReadOnly:true}));
 }finally{await browser.close();}
})().catch(e=>{console.error('Smoke de imagens interrompido em '+stage+' ('+e.name+'). Detalhes privados omitidos.');process.exitCode=1;});
