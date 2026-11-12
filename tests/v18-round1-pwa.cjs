// Navegador e service worker reais, dados e SDK simulados. Sem produção.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const {build,files} = require('../scripts/build.cjs');
const {fixture, navigate} = require('./browser.cjs');

(async()=>{
  const requested=process.env.GUIGS_ROUND1_WORK;
  assert.ok(requested&&path.isAbsolute(requested),'Indique pasta externa absoluta existente em GUIGS_ROUND1_WORK.');
  const external=fs.realpathSync(requested);
  for(let p=external;;p=path.dirname(p)){
    assert.ok(!fs.existsSync(path.join(p,'.git')),'O teste escreve somente fora de Git.');
    if(path.dirname(p)===p)break;
  }
  const root=fs.mkdtempSync(path.join(external,'pwa-'));
  for(const file of files){const dest=path.join(root,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(__dirname,'..',file),dest);}
  const artifact=build({sourceRoot:root,env:{GUIGS_SUPABASE_URL:'https://test.supabase.co',GUIGS_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_TEST_ONLY'}});
  const evidence={checks:[],overflows:[],installation:'PENDING',standaloneLaunch:'PENDING',status:'FAIL'};
  const check=(name,pass)=>{assert.ok(pass,name);evidence.checks.push(name);};
  const server=http.createServer((req,res)=>{
    const name=new URL(req.url,'http://127.0.0.1').pathname.slice(1)||'index.html';
    if(name==='fake.js'){res.setHeader('Content-Type','text/javascript');return res.end('export const createClient=()=>window.__mockClient;');}
    if(!artifact.files.includes(name)){res.statusCode=404;return res.end();}
    res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.html')?'text/html':name.endsWith('.png')?'image/png':'application/manifest+json');
    let bytes=fs.readFileSync(path.join(artifact.directory,name));
    if(name.endsWith('.js'))bytes=bytes.toString().replace('https://esm.sh/@supabase/supabase-js@2','./fake.js');
    res.end(bytes);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}`;
  let context,cdp,installed=false;
  const manifestId=base+'/';
  try{
    context=await chromium.launchPersistentContext(path.join(root,'profile'),{
      headless:process.env.GUIGS_PWA_HEADED!=='1',
      executablePath:process.env.BROWSER_EXECUTABLE||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      viewport:{width:1920,height:1080},args:['--disable-background-networking']});
    evidence.engine=(await context.pages()[0].evaluate(()=>navigator.userAgent));
    await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
    await context.addInitScript(fixture,{role:'owner',session:true});
    const page=context.pages()[0];
    const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
    await page.goto(base);
    await page.waitForSelector('#content:not(.hidden)');
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
    check('Cache v21 está ativo',await page.evaluate(async()=> (await caches.keys()).includes('guigs-stock-shell-v21')));
    const six=[[1920,1080],[1366,768],[1280,800],[1024,768],[390,844],[360,800]];
    for(const [width,height] of six){
      await page.setViewportSize({width,height});
      for(const [link,view] of [['navOverview','overviewView'],['navHistory','historyView']]){
        await navigate(page,link);await page.waitForSelector('#'+view+':not(.hidden)');
        const dimensions=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth,
          outside:[...document.querySelectorAll('main *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1 &&
            !e.closest('.tablewrap')).slice(0,12).map(e=>e.id||e.className||e.tagName)}));
        if(dimensions.width>dimensions.viewport+1)evidence.overflows.push({view,width,height,...dimensions});
        else check(`${view} ${width}×${height} sem scroll indevido`,true);
      }
      await page.screenshot({path:path.join(root,`historico-${width}.png`)});
    }
    await page.setViewportSize({width:1366,height:768});
    await navigate(page,'navOverview');
    await page.reload();await page.waitForSelector('#content:not(.hidden)');
    check('Reload online autenticado com o SDK simulado',await page.isVisible('#overviewView'));
    cdp=await context.newCDPSession(page);
    const manifest=await cdp.send('Page.getAppManifest');
    const parsed=JSON.parse(manifest.data);
    check('Manifest real, standalone e sem erro de parse',parsed.display==='standalone'&&parsed.icons.length===3&&!manifest.errors.some(x=>x.critical));
    const {installabilityErrors}=await cdp.send('Page.getInstallabilityErrors');
    evidence.installabilityErrors=installabilityErrors.map(x=>x.errorId);
    check('Chromium considera o artefato instalável',installabilityErrors.length===0);
    try{
      await cdp.send('PWA.install',{manifestId,installUrlOrBundleUrl:base+'/'});
      installed=true;
      const state=await cdp.send('PWA.getOsAppState',{manifestId});
      check('PWA instalada no perfil descartável',typeof state.badgeCount==='number');
      evidence.installation='PASS';
      const {targetId}=await cdp.send('PWA.launch',{manifestId});
      check('PWA instalada abre janela própria',typeof targetId==='string'&&targetId.length>0);
      evidence.standaloneLaunch='PASS';
    }catch(error){evidence[evidence.installation==='PASS'?'launchError':'installationError']=error.message;}
    await context.setOffline(true);
    await page.waitForFunction(()=>!navigator.onLine);
    await page.reload();
    const cached=await page.evaluate(async()=>!!(await caches.match('/index.html')));
    check('Reload offline mantém shell no cache',cached&&await page.locator('body').isVisible());
    await context.setOffline(false);
    check('Sem exceção JavaScript crítica nas views',pageErrors.length===0);
    evidence.status=evidence.overflows.length?'FAIL':evidence.installation==='PASS'?'PASS':'PENDING';
    console.log(`PWA v21: ${evidence.checks.length} verificações passaram; instalação: ${evidence.installation}; layouts com overflow: ${evidence.overflows.length}.`);
    if(evidence.status!=='PASS')process.exitCode=2;
  }catch(error){evidence.error=error.message;throw error;}
  finally{
    if(installed)await cdp.send('PWA.uninstall',{manifestId}).catch(()=>{});
    if(context)await context.close();
    await new Promise(resolve=>server.close(resolve));
    fs.writeFileSync(path.join(root,'pwa-results.json'),JSON.stringify(evidence,null,2));
    console.log(`Evidência externa: ${path.join(root,'pwa-results.json')}`);
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
