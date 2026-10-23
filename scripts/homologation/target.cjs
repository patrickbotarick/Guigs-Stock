// Destino exclusivo confirmado no painel pelo usuário. Não lê config.js nem .env.
const fs=require('node:fs'),path=require('node:path');
const PROJECT_REF='zthorgwmnigwceobbkoj';
const PROJECT_NAME='guigs-stock-homolog-v16';
function validateProfile(value){
 if(!value||value.projectRef!==PROJECT_REF)throw Error('Perfil recusado: projeto diferente da homologação confirmada.');
 if(!/^sb_publishable_[A-Za-z0-9_-]+$/.test(value.publishableKey||''))throw Error('Chave pública de homologação ausente ou inválida.');
 const secret=value.secretKey||'';
 if(!/^sb_secret_[A-Za-z0-9_-]+$/.test(secret)){
  let claims;try{claims=JSON.parse(Buffer.from(secret.split('.')[1],'base64url'));}catch{}
  if(claims?.role!=='service_role'||claims?.ref!==PROJECT_REF)throw Error('Chave administrativa não pertence ao projeto de homologação.');
 }
 let url;try{url=new URL(value.databaseUrl);}catch{throw Error('Conexão privada de homologação inválida.');}
 const user=decodeURIComponent(url.username),password=decodeURIComponent(url.password);
 const direct=url.hostname===`db.${PROJECT_REF}.supabase.co`&&user==='postgres';
 const pooler=/^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(url.hostname)&&user===`postgres.${PROJECT_REF}`;
 if(!['postgres:','postgresql:'].includes(url.protocol)||!direct&&!pooler||(url.port&&url.port!=='5432')||url.pathname!=='/postgres'||!password||/YOUR.PASSWORD|SUA.SENHA|\[|\]/i.test(password))throw Error('Use conexão direta ou SESSION pooler 5432 do projeto homologado; nenhum outro alvo é aceito.');
 for(const [key,v]of url.searchParams)if(key!=='sslmode'||!['require','verify-full'].includes(v))throw Error('Parâmetros adicionais de conexão recusados.');
 return {
  projectRef:PROJECT_REF,name:PROJECT_NAME,url:`https://${PROJECT_REF}.supabase.co`,publishableKey:value.publishableKey,secretKey:secret,
  connection:{host:url.hostname,port:5432,user,password,database:'postgres',ssl:{rejectUnauthorized:true},connectionTimeoutMillis:15000,application_name:'guigs-homolog-v16'},
  toJSON(){return {projectRef:PROJECT_REF,credentials:'redacted'};}
 };
}
function loadProfile(file){
 if(!file||!path.isAbsolute(file))throw Error('Informe GUIGS_HOMOLOG_PROFILE com caminho absoluto privado externo ao Git.');
 const resolved=fs.realpathSync(file);let cursor=path.dirname(resolved);
 while(true){if(fs.existsSync(path.join(cursor,'.git')))throw Error('Perfil privado dentro de Git recusado.');const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
 let value;try{value=JSON.parse(fs.readFileSync(resolved,'utf8').replace(/^\ufeff/,''));}catch{throw Error('Não foi possível ler o perfil privado JSON.');}
 return validateProfile(value);
}
function safeError(error){return {message:'Falha na homologação isolada; nenhum detalhe de credencial foi incluído.',code:typeof error?.code==='string'?error.code:undefined};}
module.exports={PROJECT_REF,PROJECT_NAME,loadProfile,validateProfile,safeError};
