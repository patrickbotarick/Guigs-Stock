// Build estático por allowlist. Nunca lê config.js local nem faz conexão de rede.
const fs=require('node:fs'),path=require('node:path');
const files=Object.freeze(['index.html','auth-preview.html','reset-password.html','cloud-dashboard.js','inventory.js','reports.js',
 'auth-preview.js','reset-password.js','pwa.js','service-worker.js','manifest.webmanifest','logo-guigs.png',
 'icons/guigs-stock-192.png','icons/guigs-stock-512.png','icons/guigs-stock-maskable-512.png']);
function build({sourceRoot=path.resolve(__dirname,'..'),env=process.env}={}) {
 const root=fs.realpathSync(sourceRoot),target=path.resolve(root,'dist');
 if(path.dirname(target)!==root || path.basename(target)!=='dist')throw Error('Destino de build inválido.');
 if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('dist não pode ser link/junction.');
 let url;
 try{url=new URL(env.GUIGS_SUPABASE_URL);}catch{throw Error('Defina GUIGS_SUPABASE_URL válida no ambiente de build.');}
 if(url.protocol!=='https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) || url.username || url.password || url.port || url.search || url.hash || url.pathname!=='/')throw Error('URL de build deve ser HTTPS de um projeto Supabase, sem credenciais/caminho.');
 const key=env.GUIGS_SUPABASE_PUBLISHABLE_KEY;
 if(typeof key!=='string'||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key))throw Error('Use somente GUIGS_SUPABASE_PUBLISHABLE_KEY pública; JWT/chaves privilegiadas são recusados.');
 for(const file of files){
  const source=path.join(root,file),resolved=fs.realpathSync(source);
  if(!resolved.startsWith(root+path.sep)||fs.lstatSync(source).isSymbolicLink()||!fs.statSync(source).isFile())throw Error('Arquivo público ausente ou fora da origem permitida.');
 }
 // Caminho absoluto fixo verificado acima. Remove apenas o artefato descartável dist.
 if(fs.existsSync(target))fs.rmSync(target,{recursive:true});
 fs.mkdirSync(target);
 for(const file of files){const destination=path.join(target,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(root,file),destination);}
 fs.writeFileSync(path.join(target,'config.js'),'// Configuração pública gerada no build.\nwindow.GUIGS_SUPABASE_CONFIG = '+JSON.stringify({url:url.origin,publishableKey:key})+';\n');
 return {directory:target,files:[...files,'config.js']};
}
if(require.main===module){try{const result=build();console.log(`Build concluído: ${result.files.length} arquivos públicos em dist/.`);}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={build,files};
