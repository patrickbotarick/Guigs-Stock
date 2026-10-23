// Dados exclusivamente artificiais. Helper compartilhado pelos testes SQL/UI.
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
const args={p_shop_id:id(10),p_from:'2026-10-01T03:00:00Z',p_to:'2026-11-01T03:00:00Z',p_limit:50,p_loss_offset:0,p_inventory_offset:0};
async function report(db,role='owner',options={}) {
 const p={...args,...options};
 return asUser(db,role,async tx=>(await tx.query('select public.guigs_get_reports($1,$2,$3,$4,$5,$6) as data',Object.keys(args).map(k=>p[k]))).rows[0].data);
}
async function seed() {
 const db=await createTestDatabase();
 await db.exec('delete from public.guigs_movements');
 await db.query("insert into public.guigs_suppliers(id,shop_id,name) values($1,$2,'Nome atual diferente')",[id(40),id(10)]);
 await db.query('update public.guigs_lots set supplier_id=$1 where id in ($2,$3)',[id(40),id(30),id(31)]);
 await db.query('update public.guigs_products set min_total=200,target_total=250,min_fridge=30,target_fridge=40 where id=$1',[id(20)]);
 await db.query('update public.guigs_products set min_total=20,target_total=30,min_fridge=5,target_fridge=20 where id=$1',[id(21)]);
 const move=async(type,delta,location='stock',note='',event=null,lot=id(30),date='2026-10-10T12:00:00Z',actor=id(1))=>{
  await db.query('insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,created_at) values($1,$2,coalesce($3::uuid,gen_random_uuid()),$4,$5,$6,$7,$8,$9)',[id(10),lot,event,type,location,delta,actor,note,date]);
 };
 await move('receipt',100,'stock','Fornecedor: BEBIDAS ÁGUA\nPedido artificial');
 await move('receipt',20,'fridge','Fornecedor: BEBIDAS ÁGUA');
 await move('receipt',5,'stock','Legado sem fornecedor',null,id(31));
 await move('transfer',-5,'stock','',id(50));await move('transfer',5,'fridge','',id(50));
 await move('return',-2,'fridge','',id(51));await move('return',2,'stock','',id(51));
 await move('sale',-7,'stock','',null,id(30),'2026-10-10T13:00:00Z',id(2));
 await move('loss',-3,'stock','=SUM(1;2) "avaria"\nMotivo artificial');
 await move('adjust',4);await move('adjust',-1);
 await move('receipt',1,'stock','Fora do período',null,id(30),'2026-10-01T02:59:59Z');
 await move('receipt',2,'stock','Fora do período',null,id(30),'2026-11-01T03:00:00Z');
 for (const [i,days] of [-1,0,15,16,30,31,1].entries()) {
  await db.query('insert into public.guigs_lots(id,shop_id,product_id,code,expiry) values($1,$2,$3,$4,current_date+$5::integer)',[id(60+i),id(10),id(21),`FAIXA-${days}`,days]);
  if(i<6)await move('receipt',1,'stock','Faixa artificial',null,id(60+i),'2026-09-01T12:00:00Z');
 }
 for(const [i,status] of ['completed','cancelled'].entries()) {
  await db.query(`insert into public.guigs_inventories(id,shop_id,status,started_by,started_at,completed_at,cancelled_at,start_movement_count)
   values($1,$2,$3,$4,'2026-10-09T12:00:00Z',case when $3='completed' then '2026-10-10T12:00:00Z'::timestamptz end,case when $3='cancelled' then '2026-10-11T12:00:00Z'::timestamptz end,0)`,[id(80+i),id(10),status,id(1)]);
 }
 await db.query(`insert into public.guigs_inventory_items(shop_id,inventory_id,lot_id,product_id,product_name,lot_code,expiry,location,expected_initial,initial_movement_count,basis_quantity,basis_movement_count,counted_quantity,applied_delta)
 values($1,$2,$3,$4,'COCA COLA 2L','L3-2103',current_date+60,'stock',10,0,10,0,9,-1)`,[id(10),id(80),id(30),id(20)]);
 return db;
}
module.exports={seed,report,args,id,asUser};
