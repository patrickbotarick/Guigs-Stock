// Somente o projeto descartável fixado por live.cjs; nenhum arquivo real local é lido.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {loginAll,ids,check,report}=require('./live.cjs');
const {importImages}=require('../import-product-images.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
(async()=>{
 const {clients:c}=await loginAll(),shop='146ff2e4-c8ef-4a23-9245-8a9445cfc743',owner=c.ownerA,att=c.attendantA;
 const {inspectProductImage,storeLibraryImage}=await import('../../image-library.js');
 const call=(who,name,args={})=>who.rpc(name,{p_shop_id:shop,...args});
 const ok=async(who,name,args)=>{const r=await call(who,name,args);assert.ok(!r.error,name);return r.data;};
 const before=(await owner.from('guigs_movements').select('*').eq('shop_id',shop).order('id')).data;
 const access=await ok(owner,'guigs_list_fridge_layout_access'),original=access.find(x=>x.user_id===ids.attendantA).manage_fridge_layout;
 let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  const page=await browser.newPage(),data=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=3;c.height=3;const x=c.getContext('2d');x.fillStyle='#224488';x.fillRect(0,0,3,3);return Object.fromEntries(['png','jpeg','webp'].map(t=>[t,c.toDataURL('image/'+t).split(',')[1]]));});
  const blobs={},entries=[];
  for(const [name,format,mime]of [['Água com gás & gelo.png','png','image/png'],['JPEG com espaço.jpeg','jpeg','image/jpeg'],['WEBP especial.webp','webp','image/webp'],['cópia Água.png','png','image/png']]){
   blobs[name]=Buffer.from(data[format],'base64');entries.push({filename:name,...await inspectProductImage(blobs[name],mime),status:'valid'});
  }
  const imported=await importImages({client:owner,shopId:shop,manifest:{refused:0,entries},readBytes:async n=>blobs[n]});
  check(imported.imported<=3&&imported.duplicates>=1,'PNG JPEG WebP importados, duplicata reutilizada');
  const repeated=await importImages({client:owner,shopId:shop,manifest:{refused:0,entries},readBytes:async n=>blobs[n]});check(repeated.imported===0&&repeated.duplicates===4,'Importação repetida idempotente');
  const path=imported.files[0].path;
  const catalogue=await ok(att,'guigs_list_product_images',{p_search:'Água com gás',p_limit:60,p_offset:0});
  check(catalogue.items.some(x=>x.storage_path===path&&x.aliases.includes('cópia Água.png')),'Atendente lê nomes e aliases preservados');
  check(!!(await call(c.ownerB,'guigs_list_product_images',{p_search:'',p_limit:60,p_offset:0})).error,'Catálogo cross-shop negado');
  const file={name:'negado.png',type:'image/png',arrayBuffer:async()=>Uint8Array.from(blobs[entries[0].filename]).buffer};
  await assert.rejects(()=>storeLibraryImage(att,shop,file));check(true,'Atendente comum não registra nem associa');
  check(!!(await owner.storage.from('guigs-product-images').upload(path,blobs[entries[0].filename],{contentType:'image/png',upsert:true})).error,'Bytes catalogados protegidos contra sobrescrita');
  const products=[];for(let i=0;i<2;i++)products.push(await ok(owner,'guigs_create_product',{p_name:'Biblioteca artificial '+randomUUID().slice(0,8)}));
  const bind=(who,p,p_path,old=null)=>ok(who,'guigs_set_product_image',{p_product_id:p,p_path,p_expected_path:old});
  await bind(owner,products[0],path);await bind(owner,products[1],path);check(true,'Arquivo reutilizado em dois produtos');
  const alternate=imported.files[1].path;await bind(owner,products[0],alternate,path);check(true,'Troca sem novo upload');
  await ok(owner,'guigs_set_fridge_layout_access',{p_user_id:ids.attendantA,p_allowed:true});
  await storeLibraryImage(att,shop,{...file,name:'alias do delegado.png'});check(true,'Capability gerencia catálogo e aliases');
  await bind(att,products[0],null,alternate);await bind(att,products[1],null,path);check(true,'Capability remove associação sem excluir arquivo');
  const downloaded=await att.storage.from('guigs-product-images').download(path);check(!downloaded.error,'Arquivo preservado após desvincular');
  const after=(await owner.from('guigs_movements').select('*').eq('shop_id',shop).order('id')).data;assert.deepEqual(after,before);check(true,'Ledger artificial preservado');
 }finally{await call(owner,'guigs_set_fridge_layout_access',{p_user_id:ids.attendantA,p_allowed:original});if(browser)await browser.close();}
 report('image-library-live-results');
})().catch(()=>{console.error('Ensaio de biblioteca em homologação não aprovado; detalhes privados omitidos.');process.exitCode=1;});
