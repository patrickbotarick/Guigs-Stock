// Apenas suporte de testes: PostgreSQL/WASM em memória, nenhuma conexão externa.
const fs=require('node:fs');const path=require('node:path');
const modulePath=process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite';
const {PGlite}=require(modulePath);const {pgcrypto}=require(path.join(modulePath,'dist/contrib/pgcrypto.cjs'));
const id=n=>`20000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const signatures={
 guigs_create_inventory:['p_shop_id','p_observation'],guigs_list_inventories:['p_shop_id','p_limit','p_offset'],
 guigs_get_inventory:['p_shop_id','p_inventory_id'],guigs_count_inventory_item:['p_shop_id','p_inventory_id','p_item_id','p_quantity','p_version'],
 guigs_recount_inventory_item:['p_shop_id','p_inventory_id','p_item_id','p_version'],guigs_refresh_inventory_scope:['p_shop_id','p_inventory_id','p_version'],
 guigs_set_inventory_status:['p_shop_id','p_inventory_id','p_status','p_version'],guigs_complete_inventory:['p_shop_id','p_inventory_id','p_version','p_confirm']
};
async function createTestDatabase({through=8}={}){
 const db=new PGlite({extensions:{pgcrypto}});
 await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
 for(const file of fs.readdirSync(path.join(__dirname,'../supabase/migrations')).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=through).sort())await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations',file),'utf8'));
 await db.query('insert into auth.users values($1,$2),($3,$4)',[id(1),'owner@test.invalid',id(2),'attendant@test.invalid']);
 await db.query('insert into public.guigs_shops(id,name) values($1,$2)',[id(10),'Loja artificial UI']);
 await db.query("insert into public.guigs_memberships(shop_id,user_id,role) values($1,$2,'owner'),($1,$3,'attendant')",[id(10),id(1),id(2)]);
 await db.query('insert into public.guigs_products(id,shop_id,name) values($1,$2,$3),($4,$2,$5)',[id(20),id(10),'COCA COLA 2L',id(21),'SUCO UVA 1L']);
 await db.query("insert into public.guigs_lots(id,shop_id,product_id,code,expiry) values($1,$2,$3,'L3-2103',current_date+60),($4,$2,$5,'UVA-02',current_date+70)",[id(30),id(10),id(20),id(31),id(21)]);
 await db.query("insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id) values($1,$2,gen_random_uuid(),'receipt','stock',10,$3),($1,$2,gen_random_uuid(),'receipt','fridge',8,$3),($1,$4,gen_random_uuid(),'receipt','stock',4,$3)",[id(10),id(30),id(1),id(31)]);
 return db;
}
async function asUser(db,role,callback){
 return db.transaction(async tx=>{
  await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[id(role==='owner'?1:2)]);
  await tx.exec('set local role authenticated');
  return callback(tx);
 });
}
async function callRPC(db,role,name,args){
 if(!signatures[name])throw Error('RPC de teste não autorizada');
 return asUser(db,role,async tx=>{
  const values=signatures[name].map(key=>args[key]);
  const result=await tx.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) as data`,values);
  return result.rows[0].data;
 });
}
module.exports={createTestDatabase,callRPC,asUser,id};
