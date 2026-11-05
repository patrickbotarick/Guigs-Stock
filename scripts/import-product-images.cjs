// Administrativo: dry-run sem rede/credencial; execute exige login manual owner e alvo fixo.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const SOURCE="C:\\Users\\patrick.silva\\OneDrive\\SALVAR\\GUIG'S\\Bebidas Guigs";
const PROJECT='wddbhtxkbrhsjewuaekv',SHOP='094582e6-29f6-4dda-b631-cdc7b229f5dc';
const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};
function allowedBrowserRequest(url,method){
 const u=new URL(url),project='https://'+PROJECT+'.supabase.co';
 if(u.protocol!=='https:')return false;
 if(['GET','HEAD','OPTIONS'].includes(method)&&['guigs-stock.pages.dev','esm.sh',PROJECT+'.supabase.co'].includes(u.hostname))return true;
 if(u.origin!==project||method!=='POST')return false;
 if(u.pathname==='/auth/v1/token')return true;
 if(/^\/rest\/v1\/rpc\/(guigs_get_history_actors|guigs_get_history|guigs_get_spatial_history|guigs_get_lot_balances|guigs_get_fridge_map|guigs_list_fridge_layout_access|guigs_list_product_images)$/.test(u.pathname))return true;
 const sign='/storage/v1/object/sign/guigs-product-images';return u.pathname===sign||u.pathname.startsWith(sign+'/');
}
async function scanImages(io=fs,source=SOURCE){
 const {inspectProductImage}=await import('../image-library.js');
 const entries=[],seen=new Set();let found=0,ignored=0;
 // Sem recursão e sem seguir links. Nenhum parâmetro CLI pode trocar a origem.
 for(const row of io.readdirSync(source,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(!row.isFile()){ignored++;continue;}found++;
  const file=path.join(source,row.name),type=mime[path.extname(row.name).toLowerCase()];
  if(!type){ignored++;entries.push({filename:row.name,status:'ignored',reason:'Formato não suportado'});continue;}
  const stat=io.lstatSync(file);if(stat.isSymbolicLink()){entries.push({filename:row.name,status:'refused',reason:'Link recusado'});continue;}
  if(stat.size>2097152){entries.push({filename:row.name,bytes:stat.size,status:'oversize',reason:'Acima de 2 MiB; original preservado'});continue;}
  try{
   const info=await inspectProductImage(io.readFileSync(file),type);const duplicate=seen.has(info.sha256);seen.add(info.sha256);
   entries.push({filename:row.name,...info,status:duplicate?'duplicate':'valid'});
  }catch{entries.push({filename:row.name,bytes:stat.size,status:'refused',reason:'Assinatura ou tamanho de imagem inválido'});}
 }
 return {source,found,valid:entries.filter(e=>['valid','duplicate'].includes(e.status)).length,duplicates:entries.filter(e=>e.status==='duplicate').length,oversize:entries.filter(e=>e.status==='oversize').length,refused:entries.filter(e=>e.status==='refused'||e.status==='oversize').length,ignored,optimized:0,entries};
}
async function importImages({client,shopId,manifest,readBytes}){
 const {storeLibraryImage,inspectProductImage}=await import('../image-library.js');
 const result={imported:0,duplicates:0,refused:manifest.refused,optimized:0,files:[]};
 for(const entry of manifest.entries.filter(e=>['valid','duplicate'].includes(e.status))){
  const bytes=await readBytes(entry.filename),info=await inspectProductImage(bytes,entry.mime_type);
  assert.equal(info.sha256,entry.sha256,'Arquivo mudou após dry-run');assert.equal(info.bytes,entry.bytes);
  const file={name:entry.filename,type:entry.mime_type,arrayBuffer:async()=>Uint8Array.from(bytes).buffer};
  const stored=await storeLibraryImage(client,shopId,file);
  result[stored.duplicate?'duplicates':'imported']++;result.files.push({filename:entry.filename,sha256:info.sha256,path:stored.image.storage_path,result:stored.duplicate?'reused':'imported'});
 }
 return result;
}
async function enrichLegacyCatalog(client,shopId){
 const old=await client.from('guigs_product_images').select('*').eq('shop_id',shopId).is('sha256',null);
 if(old.error)throw Error('Catálogo indisponível');
 const {inspectProductImage,detectImageMime}=await import('../image-library.js');const result={indexed:0,warnings:[]};
 for(const item of old.data){
  try{
   const download=await client.storage.from('guigs-product-images').download(item.storage_path);if(download.error)throw Error('legacy_download');
   const bytes=await download.data.arrayBuffer(),detected=detectImageMime(bytes);
   // Compatibilidade: metadados históricos podem divergir dos bytes. Não reclassifica nem bloqueia os novos arquivos.
   if(detected!==item.mime_type){result.warnings.push({reason:'legacy_mime_mismatch',declared:item.mime_type,detected});continue;}
   const info=await inspectProductImage(bytes,item.mime_type);
   const r=await client.rpc('guigs_register_product_image',{p_shop_id:shopId,p_path:item.storage_path,p_original_filename:item.original_filename,p_display_name:item.display_name,p_mime_type:info.mime_type,p_bytes:info.bytes,p_sha256:info.sha256});
   if(r.error)throw Error('legacy_register');result.indexed++;
  }catch{result.warnings.push({reason:'legacy_hash_not_confirmed'});}
 }
 return result;
}
async function execute(manifest){
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
 const {createClient}=require(path.join(process.env.SUPABASE_SDK_DIR||path.join(os.tmpdir(),'guigs-stock-homolog-deps/node_modules'),'@supabase/supabase-js'));
 const publicText=await(await fetch('https://guigs-stock.pages.dev/config.js')).text();
 const config=JSON.parse(publicText.match(/window\.GUIGS_SUPABASE_CONFIG\s*=\s*(\{[^}]+\});/)[1]);assert.equal(config.url,'https://'+PROJECT+'.supabase.co');assert.match(config.publishableKey,/^sb_publishable_/);
 const browser=await chromium.launch({headless:false,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
 let authorization;
 try{
  const ctx=await browser.newContext(),page=await ctx.newPage();
  await ctx.route('**/*',r=>allowedBrowserRequest(r.request().url(),r.request().method())?r.continue():r.abort());
  // Decodifica localmente antes de enviar. Os bytes não saem do perfil local nesta etapa.
  for(const entry of manifest.entries.filter(e=>['valid','duplicate'].includes(e.status))){
   const bytes=fs.readFileSync(path.join(SOURCE,entry.filename));
   const valid=await page.evaluate(async({base64,mime})=>{try{const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),image=await createImageBitmap(new Blob([bytes],{type:mime}));const ok=image.width>0&&image.height>0;image.close();return ok;}catch{return false;}},{base64:bytes.toString('base64'),mime:entry.mime_type});
   if(!valid){entry.status='refused';entry.reason='Não foi possível decodificar a imagem';manifest.refused++;manifest.valid--;}
  }
  console.log(JSON.stringify({localDecodeValid:manifest.valid,refused:manifest.refused}));
  const login=page.waitForResponse(r=>new URL(r.url()).origin===config.url&&new URL(r.url()).pathname==='/auth/v1/token'&&r.request().method()==='POST'&&r.ok(),{timeout:0});
  await page.goto('https://guigs-stock.pages.dev/auth-preview');console.log('READY_FOR_OWNER_LOGIN_IMPORT');
  const response=await login,session=await response.json();assert.ok(session.access_token);authorization=session.access_token;
  const client=createClient(config.url,config.publishableKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{headers:{Authorization:'Bearer '+authorization}}});
  const membership=await client.from('guigs_memberships').select('shop_id,role,active,manage_fridge_layout').eq('shop_id',SHOP).single();
  assert.ok(!membership.error&&membership.data.active&&(membership.data.role==='owner'||membership.data.manage_fridge_layout),'Membership não autorizada');
  console.log('PASS sessão autorizada para importação sob RLS');
  const legacy=await enrichLegacyCatalog(client,SHOP);console.log(JSON.stringify({legacy}));
  const result=await importImages({client,shopId:SHOP,manifest,readBytes:async filename=>fs.readFileSync(path.join(SOURCE,filename))});
  const output={projectRef:PROJECT,shopId:SHOP,time:new Date().toISOString(),found:manifest.found,legacy,...result};
  const dir=path.join(os.tmpdir(),'guigs-v16-private');fs.mkdirSync(dir,{recursive:true});const report=path.join(dir,'product-image-import-'+Date.now()+'.json');fs.writeFileSync(report,JSON.stringify(output,null,2),{mode:0o600});
  console.log(JSON.stringify({importCompleted:true,found:manifest.found,imported:result.imported,duplicates:result.duplicates,refused:result.refused,report,associationsChanged:0}));
  await page.waitForSelector('#content:not(.hidden)',{timeout:30000});await page.click('#navFridges');await page.waitForSelector('#fridgeMap .fridge-slot');
  await page.click('#fridgeEdit');await page.click('#fridgeImageLibrary');await page.waitForSelector('.image-library-item');
  const thumbnails=page.locator('.image-library-item img'),count=await thumbnails.count();assert.ok(count>=result.imported);
  for(let i=0;i<count;i++){await thumbnails.nth(i).scrollIntoViewIfNeeded();await thumbnails.nth(i).waitFor({state:'visible'});await page.waitForFunction(index=>{const i=document.querySelectorAll('.image-library-item img')[index];return i?.complete&&i.naturalWidth>0;},i);}
  assert.ok(await page.isVisible('#imageLibraryApply'));console.log(JSON.stringify({found:manifest.found,imported:result.imported,duplicates:result.duplicates,refused:result.refused,optimized:0,report,associationsChanged:0,catalogVisible:count,thumbnailsVerified:count}));
 }finally{authorization=undefined;await browser.close();}
}
module.exports={SOURCE,scanImages,importImages,enrichLegacyCatalog,allowedBrowserRequest};
if(require.main===module)scanImages().then(async manifest=>{console.log(JSON.stringify(manifest,null,2));if(process.argv.includes('--execute'))await execute(manifest);}).catch(()=>{console.error('Importação interrompida. Credenciais e respostas privadas omitidas.');process.exitCode=1;});
