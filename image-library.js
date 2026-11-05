export const IMAGE_BUCKET='guigs-product-images';
export const IMAGE_LIMIT=2097152;
const extensions={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
export function detectImageMime(bytes){
 const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
 if(b.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v))return 'image/png';
 if(b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';
 if(b.length>=12&&String.fromCharCode(...b.slice(0,4))==='RIFF'&&String.fromCharCode(...b.slice(8,12))==='WEBP')return 'image/webp';
 return null;
}
export async function inspectProductImage(bytes,mime){
 const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes),detected=detectImageMime(b);
 if(b.length<1||b.length>IMAGE_LIMIT)throw Error('Escolha imagem de até 2 MiB.');
 if(!detected||detected!==mime)throw Error('Arquivo inválido. Escolha PNG, JPEG ou WebP.');
 const digest=await crypto.subtle.digest('SHA-256',b);
 return {mime_type:mime,bytes:b.length,sha256:[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join(''),extension:extensions[mime]};
}
export async function storeLibraryImage(client,shopId,file){
 const bytes=new Uint8Array(await file.arrayBuffer()),info=await inspectProductImage(bytes,file.type);
 const name=file.name;if(!name||name.length>240)throw Error('Nome de arquivo deve ter até 240 caracteres.');const display=name.replace(/\.[^.]+$/,'').trim().slice(0,160)||'Imagem';
 const existing=await client.from('guigs_product_images').select('*').eq('shop_id',shopId).eq('sha256',info.sha256).maybeSingle();
 if(existing.error)throw existing.error;
 let path=existing.data?.storage_path||shopId+'/library/'+info.sha256+'.'+info.extension;
 let duplicate=!!existing.data,needsUpload=!existing.data;
 if(existing.data){
  const stored=await client.storage.from(IMAGE_BUCKET).download(path);
  if(stored.error){needsUpload=true;duplicate=false;}
  else {const actual=await inspectProductImage(await stored.data.arrayBuffer(),info.mime_type);if(actual.sha256!==info.sha256)throw Error('Conteúdo catalogado divergente.');}
 }
 if(needsUpload){
  const result=await client.storage.from(IMAGE_BUCKET).upload(path,bytes,{contentType:info.mime_type,upsert:false,metadata:{original_filename:name,sha256:info.sha256}});
  if(result.error){
   // Outra sessão pode ter enviado o mesmo hash. Confere bytes em vez de sobrescrever.
   const download=await client.storage.from(IMAGE_BUCKET).download(path);if(download.error)throw result.error;
   const actual=await inspectProductImage(await download.data.arrayBuffer(),info.mime_type);if(actual.sha256!==info.sha256)throw Error('Objeto existente com conteúdo divergente.');
  }
 }
 const registered=await client.rpc('guigs_register_product_image',{p_shop_id:shopId,p_path:path,p_original_filename:name,p_display_name:display,p_mime_type:info.mime_type,p_bytes:info.bytes,p_sha256:info.sha256});
 if(registered.error)throw registered.error;
 return {image:registered.data,duplicate};
}
export function createImageLibrary({getContext,canManage,onApplied}){
 const el=id=>document.getElementById(id),dialog=el('imageLibraryDialog');
 const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 let target=null,selected=null,offset=0,rows=[],request=0,saving=false,searchTimer,lifecycle=0;
 const status=text=>{el('imageLibraryMessage').textContent=text;};
 function sync(){
  const write=canManage()&&!!target,locked=saving||!navigator.onLine;
  el('imageLibraryApply').classList.toggle('hidden',!write);el('imageLibraryUnlink').classList.toggle('hidden',!write);
  el('imageLibraryUploadLabel').classList.toggle('hidden',!canManage());
  el('imageLibraryApply').disabled=locked||!selected;el('imageLibraryUnlink').disabled=locked||!target?.image_path;
  el('imageLibraryUpload').disabled=locked;el('imageLibrarySearch').disabled=saving||!navigator.onLine;
  el('imageLibraryPrevious').disabled=locked||offset===0;el('imageLibraryNext').disabled=locked||rows.length<60;
  el('imageLibraryClose').disabled=saving;
 }
 async function load(){
  if(!navigator.onLine){status('Sem conexão. Biblioteca da última leitura; ações bloqueadas.');sync();return;}
  const stamp=++request,{client,shop}=getContext();if(!client||!shop)return;
  status('Carregando biblioteca…');selected=null;sync();
  const result=await client.rpc('guigs_list_product_images',{p_shop_id:shop.shop_id,p_search:el('imageLibrarySearch').value.trim(),p_limit:60,p_offset:offset});
  if(stamp!==request||!dialog.open)return;
  if(result.error){status(result.error.message||'Biblioteca indisponível.');return;}
  rows=result.data?.items||[];const grid=el('imageLibraryGrid');grid.replaceChildren();
  const images=[];
  for(const row of rows){
   const button=node('button');button.type='button';button.className='image-library-item';button.dataset.libraryId=row.id;button.setAttribute('aria-pressed','false');
   const image=node('img');image.alt='';image.loading='lazy';image.decoding='async';image.addEventListener('error',()=>{image.hidden=true;},{once:true});
   button.append(image,node('strong',row.display_name),node('small',row.original_filename));
   if(row.products?.length)button.append(node('small',row.products.join(', ')));
   button.addEventListener('click',()=>{selected=row;for(const item of grid.children)item.setAttribute('aria-pressed',String(item===button));status(canManage()&&target?'Confira o produto e clique em Usar imagem.':'Visualização da imagem.');sync();});grid.append(button);images.push({row,image});
  }
  status(rows.length?rows.length+' imagens nesta página.':'Nenhuma imagem encontrada.');sync();
  if(images.length){
   const signed=await client.storage.from(IMAGE_BUCKET).createSignedUrls(images.map(x=>x.row.storage_path),300);
   if(stamp!==request||!dialog.open)return;
   const origin=new URL(client.supabaseUrl).origin;
   for(const entry of signed.data||[]){
    const found=images.find(x=>x.row.storage_path===entry.path);if(!found||!entry.signedUrl)continue;
    const url=new URL(entry.signedUrl);if(url.origin===origin&&url.pathname.startsWith('/storage/v1/object/sign/'+IMAGE_BUCKET+'/'))found.image.src=url.href;
   }
  }
 }
 async function apply(path){
  if(saving||!canManage()||!target||!navigator.onLine)return;
  const {client,shop}=getContext(),current=target,stamp=lifecycle;clearTimeout(searchTimer);request++;saving=true;sync();
  try{
   const result=await client.rpc('guigs_set_product_image',{p_shop_id:shop.shop_id,p_product_id:current.product_id,p_path:path,p_expected_path:current.image_path??null});
   if(result.error)throw result.error;
   if(stamp!==lifecycle)return;current.image_path=path;await onApplied(current.product_id,path);await load();if(stamp===lifecycle)status(path?'Imagem associada ao produto.':'Associação removida. O arquivo continua na biblioteca.');
  }catch(e){status(e.message||'Não foi possível associar.');}
  finally{if(stamp===lifecycle){saving=false;sync();}}
 }
 el('imageLibraryApply').addEventListener('click',()=>{if(selected)void apply(selected.storage_path);});
 el('imageLibraryUnlink').addEventListener('click',()=>void apply(null));
 el('imageLibraryUpload').addEventListener('change',async()=>{
  const file=el('imageLibraryUpload').files[0];if(!file||saving||!canManage()||!navigator.onLine)return;
  const {client,shop}=getContext(),stamp=lifecycle;saving=true;sync();status('Enviando imagem para a biblioteca…');
  try{await storeLibraryImage(client,shop.shop_id,file);if(stamp!==lifecycle)return;await load();}catch(e){status(e.message||'Falha no upload.');}
  finally{if(stamp===lifecycle){el('imageLibraryUpload').value='';saving=false;sync();}}
 });
 el('imageLibrarySearch').addEventListener('input',()=>{clearTimeout(searchTimer);request++;selected=null;status('Buscando…');sync();searchTimer=setTimeout(()=>{offset=0;void load();},200);});
 el('imageLibraryPrevious').addEventListener('click',()=>{offset=Math.max(0,offset-60);void load();});
 el('imageLibraryNext').addEventListener('click',()=>{offset+=60;void load();});
 el('imageLibraryClose').addEventListener('click',()=>dialog.close());
 dialog.addEventListener('cancel',e=>{if(saving)e.preventDefault();});dialog.addEventListener('close',()=>{request++;lifecycle++;clearTimeout(searchTimer);});
 window.addEventListener('offline',sync);window.addEventListener('online',sync);
 return {open(product=null){lifecycle++;target=product;offset=0;el('imageLibrarySearch').value='';el('imageLibraryTarget').textContent=target?'Produto: '+target.product_name:'Biblioteca da loja · somente visualização';dialog.showModal();void load();},reset(){request++;lifecycle++;target=null;selected=null;rows=[];saving=false;dialog.close();el('imageLibraryGrid').replaceChildren();}};
}
