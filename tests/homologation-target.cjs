const assert=require('node:assert/strict');
const {PROJECT_REF,validateProfile,safeError}=require('../scripts/homologation/target.cjs');
let checks=0;const check=(v,m)=>{assert.ok(v,m);checks++;};
const testUrl=new URL('postgresql://aws-0-us-east-1.pooler.supabase.com:5432/postgres');testUrl.username='postgres.'+PROJECT_REF;testUrl.password='test-only-private';
const localUrl=new URL('postgresql://localhost/postgres');localUrl.username='postgres';localUrl.password='test-only';
const base={projectRef:PROJECT_REF,publishableKey:'sb_publishable_TEST_ONLY',secretKey:['sb','secret','TEST_ONLY'].join('_'),databaseUrl:testUrl.href};
const target=validateProfile(base);check(target.url===`https://${PROJECT_REF}.supabase.co`,'API sempre construída para o destino fixo');
check(target.connection.ssl.rejectUnauthorized===true,'TLS permanece validado');
check(!JSON.stringify(target).includes('test-only-private'),'Serialização pública sem credencial');
for(const patch of [{projectRef:'outro'},{databaseUrl:base.databaseUrl.replace(PROJECT_REF,'outro')},{databaseUrl:base.databaseUrl.replace(':5432',':6543')},{databaseUrl:base.databaseUrl+'?sslmode=disable'},{databaseUrl:base.databaseUrl+'?host=outside.invalid'},{databaseUrl:localUrl.href},{secretKey:'invalid'},{publishableKey:'invalid'},{databaseUrl:base.databaseUrl.replace('/postgres','/other')}]){assert.throws(()=>validateProfile({...base,...patch}));checks++;}
check(!JSON.stringify(safeError({code:'TEST',message:base.databaseUrl})).includes('test-only'),'Erro não revela URL privada');
console.log(`Alvo de homologação: ${checks} verificações passaram; nenhum acesso remoto.`);
