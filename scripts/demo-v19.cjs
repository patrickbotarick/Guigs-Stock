// Interface de revisão para o backend descartável do runner de integração.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {build, files} = require('./build.cjs');

const allowedTables = new Set(['guigs_memberships', 'guigs_products', 'guigs_lots', 'guigs_suppliers']);
const sdk = String.raw`
export function createClient() {
  const selected = new URL(location.href).searchParams.get('role');
  const role = selected === 'attendant' ? 'attendant' : 'owner';
  const sessionKey = 'guigs-demo-signout';
  if (selected) sessionStorage.removeItem(sessionKey);
  const call = async body => {
    try {
      const response = await fetch('/demo-api', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({...body, role})
      });
      return await response.json();
    } catch {
      return {data:null,error:{message:'Ambiente de demonstração indisponível.'}};
    }
  };
  const getUser = () => sessionStorage.getItem(sessionKey)
    ? Promise.resolve({data:{user:null},error:null})
    : call({user:true});
  return {
    auth: {
      getUser,
      async getSession() {
        const {data} = await getUser();
        return {data:{session:data?.user ? {user:data.user} : null}};
      },
      onAuthStateChange() {},
      async signOut() {sessionStorage.setItem(sessionKey,'1');return {error:null};}
    },
    from(table) {
      const params = new URLSearchParams();
      return {
        select(columns) {params.set('select',columns);return this;},
        eq(key,value) {params.set(key,'eq.'+value);return this;},
        range(start,end) {params.set('offset',start);params.set('limit',end-start+1);return this;},
        then(resolve,reject) {return call({table,params:params.toString()}).then(resolve,reject);}
      };
    },
    rpc: (name,args) => call({name,args})
  };
}
`;

async function startDemo({repo, root, actors, rest, request}) {
  const source = path.join(root,'demo-source');
  fs.mkdirSync(source);
  for (const file of files) {
    const target = path.join(source,file);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.copyFileSync(path.join(repo,file),target);
  }
  const artifact = build({sourceRoot:source, env:{
    GUIGS_SUPABASE_URL:'https://test.supabase.co',
    GUIGS_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_TEST_ONLY'
  }});
  const types = {'.js':'text/javascript; charset=utf-8','.html':'text/html; charset=utf-8','.png':'image/png','.webmanifest':'application/manifest+json'};
  const reply = (res, body, status = 200) => {
    res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify(body));
  };
  async function proxy(req,res) {
    const body = await new Promise((resolve,reject) => {
      let text = '';
      req.setEncoding('utf8');
      req.on('data',chunk=>{
        text+=chunk;
        if (text.length>65536) {req.destroy();reject(Error('Pedido local muito grande.'));}
      });
      req.on('end',()=>{try {resolve(JSON.parse(text));} catch(error) {reject(error);}});
      req.on('error',reject);
    });
    const role = body.role === 'owner' ? 'owner' : body.role === 'attendant' ? 'attendant' : null;
    if (!role) return reply(res,{data:null,error:{message:'Perfil de demonstração inválido.'}},400);
    const actor = actors[role];
    if (body.user) return reply(res,{data:{user:{id:actor.user,email:role+'@test.invalid'}},error:null});
    let result;
    if (allowedTables.has(body.table)) {
      const params = new URLSearchParams(body.params);
      result = await request(rest,'/'+body.table+'?'+params.toString(),undefined,actor.token);
    } else if (/^guigs_[a-z_]+$/.test(body.name || '')) {
      result = await request(rest,'/rpc/'+body.name,body.args || {},actor.token);
    } else return reply(res,{data:null,error:{message:'Operação de demonstração indisponível.'}},404);
    reply(res,result.ok ? {data:result.data,error:null} : {data:null,error:result.data},result.status);
  }
  const server = http.createServer((req,res) => {
    const localOrigin = 'http://127.0.0.1:'+server.address().port;
    const url = new URL(req.url,localOrigin);
    if (req.headers.host !== new URL(localOrigin).host || (req.headers.origin && req.headers.origin !== localOrigin)) {
      res.writeHead(403);res.end();return;
    }
    res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (url.pathname === '/demo-api' && req.method === 'POST') {
      if (!req.headers['content-type']?.startsWith('application/json')) {res.writeHead(415);res.end();return;}
      void proxy(req,res).catch(error=>{console.error('Demonstração local:',error.cause?.code || error.code || error.name);if(!res.headersSent)reply(res,{data:null,error:{message:'Falha na demonstração local.'}},500);});
      return;
    }
    const file = url.pathname.slice(1) || 'index.html';
    if (req.method !== 'GET' || (file !== 'demo-sdk.js' && !artifact.files.includes(file))) {
      res.writeHead(404);res.end();return;
    }
    res.setHeader('Content-Type',types[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control','no-cache');
    const bytes = file === 'demo-sdk.js' ? sdk : fs.readFileSync(path.join(artifact.directory,file));
    res.end(file.endsWith('.js') ? bytes.toString().replace('https://esm.sh/@supabase/supabase-js@2','./demo-sdk.js') : bytes);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base = 'http://127.0.0.1:'+server.address().port;
  console.log('Demonstração local com dados fictícios:');
  console.log('Proprietário: '+base+'/?role=owner');
  console.log('Atendente: '+base+'/?role=attendant');
  console.log('Pressione Ctrl+C para encerrar.');
  await new Promise(resolve=>{
    const stop=()=>{
      process.off('SIGINT',stop);process.off('SIGTERM',stop);
      server.close(resolve);
    };
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  });
}
module.exports = {startDemo};
