// Suítes espaciais exclusivamente locais; nenhuma credencial ou conexão remota.
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const suites=['foundation','allocation','replenishment','operations','inventory','observability','images','image-library','image-admin','modular','performance','editor-browser'];
let total=0;
for(const suite of suites){
  const result=spawnSync(process.execPath,[`tests/fridge-${suite}.cjs`],{
    cwd:path.resolve(__dirname,'..'),encoding:'utf8',env:process.env,windowsHide:true,maxBuffer:8*1024*1024});
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
  const counts=[...(result.stdout||'').matchAll(/(\d+) verifica[^\r\n]*passaram/g)];
  if(result.status!==0||counts.length!==1){console.error('Suíte espacial interrompida: '+suite);process.exit(1);}
  total+=Number(counts[0][1]);
}
console.log(JSON.stringify({spatialSuites:suites.length,totalChecks:total,passed:true}));
