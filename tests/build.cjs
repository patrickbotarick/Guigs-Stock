// Origem artificial em TEMP. Nenhum config.js real é lido ou copiado.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {build,files}=require('../scripts/build.cjs');
let checks=0;const check=(v,m)=>{assert.ok(v,m);checks++;};
const root=fs.mkdtempSync(path.join(os.tmpdir(),'guigs-build-test-'));
const env={GUIGS_SUPABASE_URL:'https://build-test.supabase.co',GUIGS_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_TEST_ONLY'};
try {
 for(const file of files){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));}
 fs.writeFileSync(path.join(root,'config.js'),'CONFIG_LOCAL_ARTIFICIAL_NAO_COPIAR');
 for(const file of ['docs/private.md','scripts/tool.cjs','tests/fake.cjs','supabase/migrations/fake.sql','AGENTS.md','.env']){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),'INTERNO_ARTIFICIAL');}
 const result=build({sourceRoot:root,env});
 const actual=fs.readdirSync(result.directory,{recursive:true}).filter(f=>fs.statSync(path.join(result.directory,f)).isFile()).map(f=>f.replaceAll('\\','/')).sort();
 check(JSON.stringify(actual)===JSON.stringify([...files,'config.js'].sort()),'Artefato possui exatamente a allowlist');
 for(const file of ['docs','scripts','tests','supabase','AGENTS.md','.env'])check(!fs.existsSync(path.join(result.directory,file)),`Excluído ${file}`);
 const config=fs.readFileSync(path.join(result.directory,'config.js'),'utf8'),sandbox={window:{}};vm.runInNewContext(config,sandbox);
 check(sandbox.window.GUIGS_SUPABASE_CONFIG.publishableKey===env.GUIGS_SUPABASE_PUBLISHABLE_KEY,'Config gerada pelo ambiente');
 check(!config.includes('CONFIG_LOCAL'),'Config local não copiada');
 for(const bad of [{},{...env,GUIGS_SUPABASE_PUBLISHABLE_KEY:'sb_'+'secret_TEST_ONLY'},{...env,GUIGS_SUPABASE_URL:'http://build-test.supabase.co'},{...env,GUIGS_SUPABASE_URL:'https://build-test.supabase.co/private'},{...env,GUIGS_SUPABASE_URL:'https://bad.invalid'}]){assert.throws(()=>build({sourceRoot:root,env:bad}));checks++;}
 fs.writeFileSync(path.join(result.directory,'unwanted.txt'),'ARTEFATO ANTIGO');build({sourceRoot:root,env});
 check(!fs.existsSync(path.join(result.directory,'unwanted.txt')),'Build limpo remove sobra de artefato anterior');
 const sw=fs.readFileSync(path.join(result.directory,'service-worker.js'),'utf8');
 check(sw.includes('guigs-stock-shell-v10'),'PWA final v10');
 for(const entry of sw.match(/const APP_SHELL = \[([\s\S]*?)\];/)[1].matchAll(/"\.\/([^"]*)"/g))check(!entry[1]||fs.existsSync(path.join(result.directory,entry[1].split('?')[0])),`Shell existe no artefato: ${entry[1]}`);
 for(const page of ['index.html','auth-preview.html','reset-password.html']){
  const html=fs.readFileSync(path.join(result.directory,page),'utf8');
  for(const entry of html.matchAll(/(?:src|href)="([^"#]+)"/g)){
   if(/^(?:https?:|#)/.test(entry[1]))continue;
   check(fs.existsSync(path.join(result.directory,entry[1].split('?')[0])),`Dependência de ${page} existe`);
  }
 }
 const manifest=JSON.parse(fs.readFileSync(path.join(result.directory,'manifest.webmanifest'),'utf8'));
 for(const icon of manifest.icons)check(fs.existsSync(path.join(result.directory,icon.src)),'Ícone instalável disponível');
 console.log(`Build: ${checks} verificações passaram; configuração artificial e nenhum deploy.`);
} finally {
 // Raiz mkdtemp conhecida e verificada dentro do TEMP, nunca workspace/backup real.
 if(path.dirname(root)!==fs.realpathSync(os.tmpdir())||!path.basename(root).startsWith('guigs-build-test-'))throw Error('Limpeza de teste recusada.');
 fs.rmSync(root,{recursive:true});
}
