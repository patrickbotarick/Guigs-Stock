// Executa somente suítes locais/mocks; falha imediatamente e registra tempos reais.
const {spawnSync}=require('node:child_process');const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const suites=['database','inventory-database','reports-database','release-database','release-performance','build','browser','searchable','operations','inventory-browser','reports-browser','release-browser','security'];
const results=[],start=performance.now();
for(const suite of [...suites,'production-protection']){
 const began=performance.now(),powershell=suite==='production-protection';
 const result=spawnSync(powershell?'pwsh':process.execPath,powershell?['-NoProfile','-Command',"[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); & './tests/production-protection.ps1'"]:[`tests/${suite}.cjs`],{cwd:root,encoding:'utf8',env:process.env,windowsHide:true,maxBuffer:8*1024*1024});
 process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
 const counts=[...(result.stdout||'').matchAll(/(\d+) verifica[^\r\n]*passaram/g)].map(m=>Number(m[1]));
 const row={suite,passed:result.status===0&&!result.error&&counts.length===1,checks:counts.reduce((a,b)=>a+b,0),durationMs:Math.round(performance.now()-began)};results.push(row);
 console.log(JSON.stringify(row));
 if(!row.passed){console.error('Suíte interrompida por falha: '+suite);process.exitCode=1;break;}
}
const summary={results,totalChecks:results.reduce((n,r)=>n+r.checks,0),durationMs:Math.round(performance.now()-start),passed:results.length===14&&results.every(r=>r.passed),skipped:suites.concat('production-protection').filter(s=>!results.some(r=>r.suite===s)),node:process.version};
if(process.env.TEST_ARTIFACTS_DIR){fs.mkdirSync(process.env.TEST_ARTIFACTS_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.TEST_ARTIFACTS_DIR,'release-test-results.json'),JSON.stringify(summary,null,2));}
console.log(JSON.stringify(summary,null,2));if(!summary.passed)process.exitCode=1;
