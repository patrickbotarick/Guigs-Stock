const fs=require('node:fs');
const {client,check,privatePath}=require('./live.cjs');
const {PROJECT_REF}=require('./target.cjs');
const BUCKET='guigs-product-images';
const MIME=['image/jpeg','image/png','image/webp'];
function adminClient(){
  const raw=fs.readFileSync(privatePath(process.env.GUIGS_HOMOLOG_SECRET_FILE),'utf8').replace(/^\ufeff/,'').trim();
  const profile=raw.startsWith('{')?JSON.parse(raw):{projectRef:PROJECT_REF,secretKey:raw};
  if(profile.projectRef!==PROJECT_REF||!/^sb_secret_[A-Za-z0-9_-]+$/.test(profile.secretKey))throw Error('Perfil administrativo inválido');
  return client(profile.secretKey);
}
async function ensureBucket(){
  const admin=adminClient();
  let bucket=await admin.storage.getBucket(BUCKET);
  if(bucket.error){
    const result=await admin.storage.createBucket(BUCKET,{public:false,allowedMimeTypes:MIME,fileSizeLimit:2097152});
    if(result.error)throw Error('Criação de bucket não confirmada');
    bucket=await admin.storage.getBucket(BUCKET);
  }
  check(!bucket.error&&bucket.data.public===false&&Number(bucket.data.file_size_limit)===2097152&&
    JSON.stringify([...bucket.data.allowed_mime_types].sort())===JSON.stringify(MIME),'Bucket privado de homologação: 2 MiB, PNG/JPEG/WebP');
}
if(require.main===module)ensureBucket().catch(()=>{console.error('Falha de Storage no homolog; credenciais e detalhes omitidos.');process.exitCode=1;});
module.exports={BUCKET,ensureBucket,adminClient};
