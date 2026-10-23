// Copia somente resultados não sensíveis por allowlist; nunca auth.json ou chave privada.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {PROJECT_REF}=require('./target.cjs');
const names=['auth-results','api-results','permissions-results','concurrency-race','concurrency-rollback-check','concurrency-finish-rollback','performance-results','close-large-results','browser-results','legacy-browser-results','views-results','report-detail-results'];
const input=process.env.GUIGS_HOMOLOG_RESULTS;
if(!input||!path.isAbsolute(input))throw Error('Informe diretório externo dos resultados.');
const suites=names.map(name=>{const data=JSON.parse(fs.readFileSync(path.join(input,name+'.json'),'utf8'));assert.equal(data.projectRef,PROJECT_REF);assert.ok(data.results.length&&data.results.every(r=>r.passed===true));return {name,date:data.date,checks:data.results.length,results:data.results.map(({label,passed,details})=>({label,passed,...(details?{details}:{})}))};});
const output={projectRef:PROJECT_REF,environment:'guigs-stock-homolog-v16',date:new Date().toISOString(),checks:suites.reduce((n,s)=>n+s.checks,0),suites};
const destination=path.join(__dirname,'../../docs/evidence/v1.6-homologacao.json');fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({suites:suites.length,checks:output.checks}));
