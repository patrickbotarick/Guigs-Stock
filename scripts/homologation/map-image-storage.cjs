// Executa SOMENTE no projeto descartável fixado em target.cjs. Não lê config.js.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {loginAll,client,check,ids,report}=require('./live.cjs');
const {BUCKET}=require('./fridge-storage.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
(async()=>{
 const {clients:c}=await loginAll(),owner=c.ownerA,att=c.attendantA,shop='146ff2e4-c8ef-4a23-9245-8a9445cfc743';
 const fixture=await owner.from('guigs_shops').select('name').eq('id',shop).single();
 assert.equal(fixture.data?.name,'Fixture v1.7 RC integrada');
 const rpc=(who,name,args)=>who.rpc(name,{p_shop_id:shop,...args});
 const ok=async(who,name,args)=>{const r=await rpc(who,name,args);assert.ok(!r.error,name);return r.data;};
 const b=who=>who.storage.from(BUCKET),objects=[];
 const access=await ok(owner,'guigs_list_fridge_layout_access');
 assert.equal(access.find(m=>m.user_id===ids.attendantA)?.manage_fridge_layout,false);
 const p=await ok(owner,'guigs_create_product',{p_name:'Storage artificial '+randomUUID().slice(0,8)});
 const key=ext=>{const path=shop+'/'+p+'/'+randomUUID()+'.'+ext;objects.push(path);return path;};
 const before=await ok(owner,'guigs_get_fridge_map');
 let current=null,browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  const page=await browser.newPage();
  const images=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=2;c.height=2;const x=c.getContext('2d');x.fillStyle='#226644';x.fillRect(0,0,2,2);return Object.fromEntries(['png','jpeg','webp'].map(t=>[t,c.toDataURL('image/'+t).split(',')[1]]));});
  const png=Buffer.from(images.png,'base64');
  const upload=(who,path,bytes=png,mime='image/png',upsert=false)=>b(who).upload(path,bytes,{contentType:mime,upsert});
  const set=async(who,path,expected=current)=>{const r=await rpc(who,'guigs_set_product_image',{p_product_id:p,p_path:path,p_expected_path:expected});if(!r.error)current=path;return r;};
  for(const [format,ext]of [['png','png'],['jpeg','jpg'],['webp','webp']]){
   const path=key(ext),bytes=Buffer.from(images[format],'base64');
   check(!(await upload(owner,path,bytes,'image/'+format)).error,'Upload owner '+format);
   for(const [role,who]of [['owner',owner],['attendant',att]]){
    const r=await b(who).download(path);check(!r.error&&Buffer.from(await r.data.arrayBuffer()).equals(bytes),'Leitura privada '+role+' '+format);
   }
  }
  const path=objects[0];
  check(!!(await upload(owner,key('png'),Buffer.from('invalido'),'text/plain')).error,'MIME inválido recusado pela API');
  check(!!(await upload(owner,key('png'),Buffer.alloc(2097153))).error,'Limite 2 MiB no servidor');
  check(!!(await upload(att,key('png'))).error,'Atendente comum não insere');
  check(!!(await upload(att,path,png,'image/png',true)).error,'Atendente comum não faz upsert');
  check(!!(await upload(c.ownerB,key('png'))).error,'Owner externo não insere');
  check(!!(await b(c.ownerB).download(path)).error,'Leitura cross-shop negada');
  check(!!(await b(client()).createSignedUrl(path,30)).error,'Leitura anônima negada');
  check(!!(await b(owner).createSignedUrl(key('png'),30)).error,'Arquivo inexistente tratado');
  check(!(await upload(owner,path,png,'image/png',true)).error,'Upsert owner INSERT SELECT UPDATE');
  check(!(await set(owner,path)).error,'Owner vincula imagem existente');
  check(!!(await set(att,null)).error,'Atendente comum não desvincula');
  check(!!(await set(owner,null,null)).error,'CAS rejeita revisão antiga');
  check((await b(owner).remove([path])).data?.length===0,'DELETE protege imagem ainda vinculada');
  await ok(owner,'guigs_set_fridge_layout_access',{p_user_id:ids.attendantA,p_allowed:true});
  const delegated=key('png');
  check(!(await upload(att,delegated)).error,'Capability permite INSERT');
  check(!(await upload(att,delegated,png,'image/png',true)).error,'Capability permite upsert UPDATE');
  check(!(await set(att,delegated)).error,'Capability permite substituir vínculo');
  check((await b(att).remove([path])).data?.length===1,'Capability remove imagem antiga desvinculada');
  const signed=await b(att).createSignedUrl(delegated,60);
  check(!signed.error,'Atendente recebe URL assinada');
  const response=await fetch(signed.data.signedUrl);
  check(response.ok&&Buffer.from(await response.arrayBuffer()).equals(png),'URL assinada devolve bytes corretos');
  check((await b(c.ownerB).remove([delegated])).data?.length===0,'DELETE cross-shop não remove');
  check(!!(await upload(c.ownerB,delegated,png,'image/png',true)).error,'UPDATE cross-shop negado');
  check(!(await set(att,null)).error,'Capability desvincula imagem');
  check((await b(att).remove([delegated])).data?.length===1,'Capability DELETE');
  check((await b(owner).remove([objects[1]])).data?.length===1,'Owner DELETE de objeto desvinculado');
  await ok(owner,'guigs_set_fridge_layout_access',{p_user_id:ids.attendantA,p_allowed:false});
  check(!!(await upload(att,key('png'))).error,'Revogação tem efeito imediato');
  const after=await ok(owner,'guigs_get_fridge_map');
  assert.deepEqual(after,before);check(true,'Mapa e saldos iguais antes/depois das operações de imagem');
 }finally{
  if(current)await rpc(owner,'guigs_set_product_image',{p_product_id:p,p_path:null,p_expected_path:current});
  await rpc(owner,'guigs_set_fridge_layout_access',{p_user_id:ids.attendantA,p_allowed:false});
  for(const path of objects)await b(owner).remove([path]);
  if(browser)await browser.close();
 }
 report('map-image-storage-results');
})().catch(()=>{console.error('Falha no ensaio de Storage. Credenciais e respostas privadas omitidas.');process.exitCode=1;});
