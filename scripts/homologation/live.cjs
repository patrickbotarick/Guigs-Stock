// Execução explícita contra o único projeto descartável autorizado. Nunca lê config.js.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {PROJECT_REF}=require('./target.cjs');
const URL_BASE=`https://${PROJECT_REF}.supabase.co`;
const PUBLIC_KEY='sb_publishable_nh9L6yRHWvbWrTF-YyuZcA__fU9AQ_O';
const ids={shopA:'b9e3b3dd-2013-4c62-88c7-fad0dbe5686f',shopB:'3a9a5fe1-a962-4809-aaa6-05c237dafda4',ownerA:'4b488904-343c-4352-bdfa-d428c76b0d7d',attendantA:'54fd6c6f-0a5e-4b21-b8f6-110fbffbbff8',ownerB:'33d203b4-ca7c-42c0-886f-30c3f3992ed5',attendantB:'b95c2737-034e-405b-a179-a96819d37168',ownerA2:'c51bfd59-f863-4676-a644-f922188bde70',lotA:'f9b5ec8b-e28d-4fbe-9c25-711130b663a4',productA:'1d3f1397-8f2d-4b62-8cb0-87e6f7cf107a',supplierA:'4e30b6bb-5680-41cb-92e7-398817c00298'};
const privateDir=path.join(os.tmpdir(),'guigs-v16-private');
const stateFile=path.join(privateDir,'auth.json');
const results=[];
function check(value,label,details){assert.ok(value,label);results.push({label,passed:true,...(details?{details}:{})});console.log('PASS '+label);}
function privatePath(file){if(!file||!path.isAbsolute(file))throw Error('PRIVATE_PATH_REQUIRED');let dir=path.dirname(fs.realpathSync(file));while(true){if(fs.existsSync(path.join(dir,'.git')))throw Error('PRIVATE_FILE_IN_GIT');const parent=path.dirname(dir);if(parent===dir)break;dir=parent;}return file;}
function sdk(){return require(path.join(process.env.HOMOLOG_DEPS||path.join(os.tmpdir(),'guigs-stock-homolog-deps/node_modules'),'@supabase/supabase-js'));}
function client(key=PUBLIC_KEY){return sdk().createClient(URL_BASE,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});}
function save(state){fs.mkdirSync(privateDir,{recursive:true});fs.writeFileSync(stateFile,JSON.stringify(state),{mode:0o600});}
async function loginAll(){const state=JSON.parse(fs.readFileSync(privatePath(stateFile),'utf8'));assert.equal(state.projectRef,PROJECT_REF);const clients={};for(const [role,user]of Object.entries(state.users)){const c=client();const {error}=await c.auth.signInWithPassword({email:user.email,password:user.password});if(error)throw Error('LOGIN_FAILED_'+role);clients[role]=c;}return {clients,state};}
async function provision(){
 const raw=fs.readFileSync(privatePath(process.env.GUIGS_HOMOLOG_SECRET_FILE),'utf8').replace(/^\ufeff/,'').trim();
 let secret=raw;if(raw.startsWith('{')){const profile=JSON.parse(raw);assert.equal(profile.projectRef,PROJECT_REF);secret=profile.secretKey;}
 assert.ok(/^sb_secret_[A-Za-z0-9_-]+$/.test(secret),'SECRET_FORMAT');
 const admin=client(secret),state={projectRef:PROJECT_REF,users:{}};
 for(const role of ['ownerA','attendantA','ownerB','attendantB','ownerA2']){
  const email=role.toLowerCase()+'.guigs-v16@example.com',password=crypto.randomBytes(32).toString('base64url');
  const {data,error}=await admin.auth.admin.updateUserById(ids[role],{password,email_confirm:true});
  check(!error&&data.user?.id===ids[role],'Auth artificial provisionado '+role);
  state.users[role]={id:ids[role],email,password};save(state);
 }
 const {clients}=await loginAll();
 for(const [role,c]of Object.entries(clients)){
  const session=await c.auth.getSession();check(!!session.data.session,'Sessão real '+role);
  const verified=await c.auth.getUser();check(verified.data.user?.id===ids[role],'JWT validado '+role);
  const refreshed=await c.auth.refreshSession();check(!refreshed.error&&!!refreshed.data.session,'Refresh real '+role);
  const membership=await c.from('guigs_memberships').select('shop_id,role');
  check(!membership.error&&membership.data.some(m=>m.shop_id===ids[role.includes('B')?'shopB':'shopA']),'Membership real '+role);
  const token=refreshed.data.session.access_token;
  check(!(await c.auth.signOut()).error,'Logout real '+role);
  const invalid=await c.auth.getUser(token);
  // Access JWT pode sobreviver até expirar; refresh deve ser revogado pelo logout.
  const revoked=await client().auth.refreshSession({refresh_token:refreshed.data.session.refresh_token});
  check(!!revoked.error,'Refresh revogado após logout '+role);
 }
 const recovery=await admin.auth.admin.generateLink({type:'recovery',email:state.users.ownerA.email});
 check(!recovery.error&&!!recovery.data.properties?.action_link,'Recuperação: link real gerado sem enviar e-mail');
}
async function rpc(c,name,args){const started=performance.now(),r=await c.rpc(name,args);return {...r,ms:Math.round(performance.now()-started)};}
function report(name){const out=process.env.HOMOLOG_RESULTS_DIR||privateDir;fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,name+'.json'),JSON.stringify({projectRef:PROJECT_REF,date:new Date().toISOString(),results},null,2));}
module.exports={ids,client,loginAll,rpc,check,report,URL_BASE,PUBLIC_KEY,privateDir,stateFile,privatePath,results};
if(require.main===module)provision().then(()=>report('auth-results')).catch(()=>{console.error('Falha na etapa Auth; credenciais e respostas privadas omitidas.');report('auth-results');process.exitCode=1;});
