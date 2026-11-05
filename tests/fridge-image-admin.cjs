// RLS/SQL reais em PGlite artificial; escrita em storage.objects simula somente a API de teste.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;},reject=async(f,re)=>{await assert.rejects(f,re);checks++;};
(async()=>{
 const db=await createTestDatabase();
 try{
  await db.exec("create schema storage;create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;grant usage on schema storage to authenticated;grant select,insert,update,delete on storage.objects to authenticated;");
  const folder=path.join(__dirname,'../supabase/migrations');for(const f of fs.readdirSync(folder).filter(f=>/^\d{14}_.*\.sql$/.test(f)).sort())await db.exec(fs.readFileSync(path.join(folder,f),'utf8'));
  const shop=id(10),hash='a'.repeat(64),key=shop+'/library/'+hash+'.png';
  const invoke=(role,name,args)=>asUser(db,role,async tx=>(await tx.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') data',args)).rows[0].data);
  const before=(await db.query('select * from public.guigs_movements order by id')).rows;
  await asUser(db,'owner',tx=>tx.query('insert into storage.objects values($1,$2,$3)',['guigs-product-images',key,JSON.stringify({mimetype:'image/png',size:9})]));
  const register=role=>invoke(role,'guigs_register_product_image',[shop,key,'original.png','Original','image/png',9,hash]);
  let item=await register('owner');const initial={...item};
  const edit=(role,action,name=null)=>invoke(role,'guigs_edit_product_image',[shop,item.id,action,name,item.display_name,item.active]);
  const list=(role,status='all')=>invoke(role,'guigs_list_image_admin',[shop,'',status,60,0]);
  const begin=role=>invoke(role,'guigs_begin_image_delete',[shop,item.id,item.display_name,item.active]);
  const finish=role=>invoke(role,'guigs_finish_image_delete',[shop,item.id]);
  const cancel=role=>invoke(role,'guigs_cancel_image_delete',[shop,item.id]);
  const bind=(role,p,pth,old=null)=>invoke(role,'guigs_set_product_image',[shop,p,pth,old]);
  for(const action of ['rename','deactivate','reactivate'])await reject(()=>edit('attendant',action,'Negado'),/Sem permissão/);
  for(const f of [()=>list('attendant'),()=>begin('attendant'),()=>finish('attendant'),()=>cancel('attendant')])await reject(f,/Sem permissão/);
  await reject(()=>edit('owner','rename','   '),/1 a 160/);await reject(()=>edit('owner','rename','x'.repeat(161)),/1 a 160/);
  await reject(()=>edit('owner','rename','linha\n2'),/1 a 160/);
  item=await edit('owner','rename','  Nome corrigido  ');eq(item.display_name,'Nome corrigido');
  eq({...item,display_name:initial.display_name},initial);eq((await list('owner')).items[0].display_name,'Nome corrigido');
  await reject(()=>invoke('owner','guigs_edit_product_image',[shop,item.id,'rename','Conflito','Original',true]),/imagem mudou/);
  await bind('owner',id(20),key);await bind('owner',id(21),key);
  eq((await list('owner')).items[0].products.length,2);await reject(()=>begin('owner'),/está sendo utilizada/);
  item=await edit('owner','deactivate');eq(item.active,false);
  eq((await invoke('attendant','guigs_list_product_images',[shop,'',60,0])).items.length,0);
  eq((await db.query('select image_path from public.guigs_products where id=$1',[id(20)])).rows[0].image_path,key);
  eq((await asUser(db,'attendant',tx=>tx.query('select name from storage.objects'))).rows.length,1);
  await bind('owner',id(21),null,key);await reject(()=>bind('owner',id(21),key),/imagem ativa/);
  item=await edit('owner','reactivate');eq(item.active,true);eq((await invoke('attendant','guigs_list_product_images',[shop,'',60,0])).items.length,1);
  await db.query('update public.guigs_memberships set manage_fridge_layout=true where user_id=$1',[id(2)]);
  item=await edit('attendant','rename','Nome delegado');eq(item.display_name,'Nome delegado');item=await edit('attendant','deactivate');item=await edit('attendant','reactivate');eq(item.active,true);
  await bind('owner',id(20),null,key);await begin('attendant');
  eq((await list('owner','pending')).items[0].deletion_pending,true);eq((await db.query('select count(*)::int n from public.guigs_product_images')).rows[0].n,0);
  await reject(()=>finish('owner'),/arquivo ainda existe/);await reject(()=>register('owner'),/Exclusão de imagem pendente/);
  await reject(()=>bind('owner',id(20),key),/imagem ativa/);
  eq((await asUser(db,'owner',tx=>tx.query('update storage.objects set name=name returning name'))).rows.length,0);
  await cancel('attendant');eq((await list('owner')).items[0].deletion_pending,false);
  eq((await db.query('select * from public.guigs_product_images')).rows[0].display_name,'Nome delegado');
  await begin('owner');await begin('owner');eq((await list('owner','pending')).items.length,1);
  await db.query('update public.guigs_memberships set manage_fridge_layout=false where user_id=$1',[id(2)]);
  await reject(()=>cancel('attendant'),/Sem permissão/);
  eq((await asUser(db,'attendant',tx=>tx.query('delete from storage.objects returning name'))).rows.length,0);
  eq((await asUser(db,'owner',tx=>tx.query('delete from storage.objects returning name'))).rows.length,1);
  eq((await list('owner','pending')).items[0].object_exists,false);await reject(()=>cancel('owner'),/já foi removido/);
  await finish('owner');eq((await finish('owner')).deleted,true);eq((await list('owner')).items.length,0);
  eq((await db.query('select count(*)::int n from guigs_private.product_image_deletions')).rows[0].n,0);
  await db.query('insert into public.guigs_shops(id,name) values($1,$2)',[id(11),'Outra loja artificial']);
  await db.query("insert into public.guigs_memberships(shop_id,user_id,role) values($1,$2,'owner')",[id(11),id(2)]);
  for(const name of ['guigs_edit_product_image','guigs_begin_image_delete','guigs_finish_image_delete','guigs_cancel_image_delete','guigs_list_image_admin']){
   const args=name==='guigs_edit_product_image'?[shop,item.id,'rename','X',item.display_name,item.active]:name==='guigs_begin_image_delete'?[shop,item.id,item.display_name,item.active]:name==='guigs_list_image_admin'?[shop,'','all',60,0]:[shop,item.id];
   await reject(()=>invoke('attendant',name,args),/Sem permissão/);
  }
  eq((await db.query('select * from public.guigs_movements order by id')).rows,before);
  const {deleteLibraryImage}=await import('../image-library.js');
  const calls=[];const fake={rpc:async n=>{calls.push(n);return {data:n==='guigs_begin_image_delete'?{storage_path:key}:{deleted:true}};},storage:{from:()=>({remove:async()=>{calls.push('remove');return {error:Error('Conexão interrompida')};}})}};
  await reject(()=>deleteLibraryImage(fake,shop,item),/interrompida/);eq(calls,['guigs_begin_image_delete','remove']);
  console.log(`Administração de imagens: ${checks} verificações passaram; PGlite e clientes artificiais.`);
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
