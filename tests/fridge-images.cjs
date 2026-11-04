const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
const shop=id(10),p=id(20),photo=shop+'/'+p+'/'+id(404)+'.png',b='guigs-product-images';
let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const reject=async(fn,re)=>{await assert.rejects(fn,re);checks++;};
(async()=>{
 const db=await createTestDatabase();
 try{
  // Somente um substituto da tabela de metadados para provar RLS; a API real é testada no homolog.
  await db.exec("create schema storage;create table storage.objects(bucket_id text,name text,primary key(bucket_id,name));alter table storage.objects enable row level security;grant usage on schema storage to authenticated;grant select,insert,update,delete on storage.objects to authenticated;");
  const folder=path.join(__dirname,'../supabase/migrations');
  for(const f of fs.readdirSync(folder).filter(f=>/spatial_fridge_.*\.sql$/.test(f)).sort())await db.exec(fs.readFileSync(path.join(folder,f),'utf8'));
  const insert=(role,key)=>asUser(db,role,tx=>tx.query('insert into storage.objects values($1,$2)',[b,key]));
  const update=(role,key,previous=null)=>asUser(db,role,async tx=>(await tx.query('select public.guigs_set_product_image($1,$2,$3,$4) as data',[shop,p,key,previous])).rows[0].data);
  await reject(()=>insert('attendant',photo),/row-level security/);
  await reject(()=>insert('owner','../../foto.png'),/row-level security/);
  await reject(()=>insert('owner',photo.replace('.png','.svg')),/row-level security/);
  await reject(()=>insert('owner',photo.replace(shop,id(11))),/row-level security/);
  await reject(()=>update('owner',photo),/Imagem não encontrada/);
  await insert('owner',photo);
  eq((await asUser(db,'attendant',tx=>tx.query('select name from storage.objects'))).rows.map(r=>r.name),[photo]);
  await reject(()=>update('attendant',photo),/proprietários/);
  eq((await update('owner',photo)).image_path,photo);
  await reject(()=>update('owner',null),/foto mudou/);
  eq((await asUser(db,'owner',tx=>tx.query('delete from storage.objects where name=$1 returning name',[photo]))).rows,[]);
  eq((await update('owner',null,photo)).image_path,null);
  eq((await db.query('select count(*)::int as n from storage.objects')).rows[0].n,1);
  console.log(`Imagens privadas: ${checks} verificações passaram; políticas em PGlite artificial.`);
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
