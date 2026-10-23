// Testes estáticos e fixtures artificiais; sem backend ou credenciais reais.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {inspect} = require('../scripts/audit-repository.cjs');
let checks = 0;
const check = (value, message) => {assert.ok(value,message); checks++;};
const types = text => inspect(text).map(hit=>hit.type);
check(types('gh'+'p_'+'A'.repeat(36)).includes('github-token'),'Token GitHub detectado');
check(types('sb_'+'secret_'+'B'.repeat(24)).includes('supabase-secret'),'Chave privilegiada detectada');
check(types('postgre'+'sql://user:'+'fictitious-value'+'@db.invalid/postgres').includes('credential-url'),'URL com credencial detectada');
check(types('pass'+'word = "'+'fictional-value'+'"').includes('credential-assignment'),'Senha atribuída detectada');
check(types('-----BEGIN '+'PRIVATE KEY-----').includes('private-key'),'Chave privada detectada');
const jwt = role => Buffer.from('{"alg":"HS256"}').toString('base64url')+'.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.'+'C'.repeat(32);
check(types(jwt('service_role')).includes('jwt'),'JWT privilegiado detectado');
check(types(jwt('anon')).includes('public-anon-jwt-review'),'JWT anon classificado para revisão');
check(types('operador'+'@'+'invalid.example').includes('email-review'),'Email candidato detectado sem divulgar valor');
check(types('owner@test.invalid; sb_publishable_SUA_CHAVE').length===0,'Fixtures e placeholders não são segredos');
check(types("msg('Falha na senha: '+(e.message||'erro desconhecido'))").length===0,'Mensagem de interface não é atribuição de credencial');
const root = path.resolve(__dirname,'..');
const ignored = file => {
  try {execFileSync('git',['check-ignore','--no-index','-q',file],{cwd:root});return true;}
  catch (error) {if(error.status===1)return false;throw error;}
};
for (const file of ['config.js','.env','.env.production','backups/data.sql','dumps/data.sql','exports/data.csv','random.sql','private.dump','private.backup','pgpass.conf','private.pem','credentials/api.json','credentials.json','export.csv','export.tsv','credentials.txt']) check(ignored(file),`${file} deve ser ignorado`);
for (const file of ['.env.example','supabase/migrations/001_schema_rls.sql','supabase/migrations/007_future.sql','scripts/audit-production-readonly.sql']) check(!ignored(file),`${file} deve continuar versionável`);
check(!execFileSync('git',['ls-files','config.js'],{cwd:root,encoding:'utf8'}).trim(),'Config real não rastreado');
const sql = fs.readFileSync(path.join(root,'scripts/audit-production-readonly.sql'),'utf8').replace(/--[^\n]*/g,'');
const statements = sql.split(';').map(s=>s.trim()).filter(Boolean);
check(/^begin transaction read only$/i.test(statements[0]) && /^rollback$/i.test(statements.at(-1)),'Auditoria abre leitura e termina rollback');
check(statements.every(s=>/^(?:begin transaction read only|set local statement_timeout|select\b|rollback$)/i.test(s)),'Nenhum comando de escrita na auditoria');
check(!/\b(?:auth\.users|public\.guigs_\w+)\b/i.test(sql),'Catálogos sem conteúdo de usuários/estoque');
for (const file of ['PRODUCAO_E_SEGURANCA.md','BACKUP.md','MIGRATIONS_SEGURAS.md','RECUPERACAO.md','CHECKLIST_PRODUCAO.md','EMERGENCIA.md']) check(fs.existsSync(path.join(root,'docs',file)),`Procedimento ${file} existe`);
console.log(`Segurança: ${checks} verificações estáticas passaram; nenhuma conexão de banco.`);
