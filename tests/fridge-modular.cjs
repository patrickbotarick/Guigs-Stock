
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {createTestDatabase,asUser,id}=require('./inventory-support.cjs');
let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const reject=async(fn,pattern)=>{await assert.rejects(fn,pattern);checks++;};
(async()=>{
 const {fridgeSlotConfiguration,fridgeVisualStatus,fridgeDraftGeometry}=await import('../fridges.js');
 for(const [quantity,tone]of [[0,'critical'],[1,'critical'],[2,'attention'],[5,'healthy']]){
  const state=fridgeVisualStatus({product_id:id(20),capacity_quantity:10,quantity,min_quantity:2,target_quantity:5});eq(state.tone,tone);eq(typeof state.icon,'string');
 }
 eq(fridgeVisualStatus({product_id:null,capacity_quantity:10}).tone,'pending');
 eq(fridgeVisualStatus({product_id:id(20),capacity_quantity:null}).tone,'pending');
 eq(fridgeDraftGeometry(-1,.5),{x_ratio:0,width_ratio:.5});
 eq(fridgeDraftGeometry(.9,.5),{x_ratio:.5,width_ratio:.5});
 eq(fridgeDraftGeometry(0,3),{x_ratio:0,width_ratio:1});
 eq(fridgeDraftGeometry(0,0),{x_ratio:0,width_ratio:.05});
 eq(fridgeSlotConfiguration({capacity_quantity:null,product_id:id(20),quantity:0}),'PENDENTE');
 eq(fridgeSlotConfiguration({capacity_quantity:12,product_id:null,quantity:0}),'PENDENTE');
 eq(fridgeSlotConfiguration({capacity_quantity:12,product_id:id(20),quantity:0}),'PRONTO');
 eq(fridgeSlotConfiguration({capacity_quantity:12,product_id:id(20),quantity:3}),'ATIVO');
 eq(fridgeSlotConfiguration({capacity_quantity:12,product_id:id(20),quantity:0,is_activated:true}),'ATIVO');
 const db=await createTestDatabase();
 try{
  const folder=path.join(__dirname,'../supabase/migrations');
  for(const name of fs.readdirSync(folder).filter(n=>/^\d{14}_/.test(n)).sort())await db.exec(fs.readFileSync(path.join(folder,name),'utf8'));
  const shop=id(10),product=id(20),lot=id(30);
  const get=(role,sql,args=[])=>asUser(db,role,async tx=>(await tx.query(sql,args)).rows[0].data);
  const save=(role,kind,values,item)=>get(role,'select public.guigs_save_fridge_layout($1,$2,$3,$4,$5) data',[shop,kind,JSON.stringify(values),item?.id??null,item?.revision??null]);
  const grant=(role,enabled,target=id(2),targetShop=shop)=>get(role,'select public.guigs_set_fridge_layout_access($1,$2,$3) data',[targetShop,target,enabled]);
  const map=role=>get(role,'select public.guigs_get_fridge_map($1) data',[shop]);
  const ledger=async()=> (await db.query('select id,delta,slot_id,slot_label from public.guigs_movements order by id')).rows;
  const before=await ledger();
  eq((await map('owner')).can_manage_layout,true);
  eq((await map('attendant')).can_manage_layout,false);
  await reject(()=>save('attendant','fridge',{name:'Negado'}),/Sem permissão/);
  await reject(()=>grant('attendant',true),/proprietários/);
  await reject(()=>grant('owner',true,id(2),id(11)),/proprietários/);
  eq((await grant('owner',true)).manage_fridge_layout,true);
  eq((await map('attendant')).can_manage_layout,true);
  eq((await db.query('select role from public.guigs_memberships where user_id=$1',[id(2)])).rows[0].role,'attendant');
  const f=await save('attendant','fridge',{name:'Modular A'}),f2=await save('owner','fridge',{name:'Modular B'});
  const h=await save('attendant','shelf',{name:'Nível A',fridge_id:f.id}),h2=await save('attendant','shelf',{name:'Nível B',fridge_id:f2.id});
  const values={name:'Bloco',fridge_id:f.id,shelf_id:h.id,product_id:null,capacity_quantity:null};
  let slot=await save('attendant','slot',values);
  eq(slot.capacity_quantity,null);eq(slot.product_id,null);
  const capacityOnly=await save('attendant','slot',{...values,name:'Só capacidade',capacity_quantity:12});
  await reject(()=>get('owner','select public.guigs_allocate_fridge_stock($1,$2,$3) data',[shop,randomUUID(),JSON.stringify([{lot_id:lot,slot_id:capacityOnly.id,quantity:1}])]),/Defina o produto/);
  slot=await save('attendant','slot',{...values,product_id:product,capacity_quantity:10},slot);
  eq(slot.product_id,product);eq(slot.capacity_quantity,10);
  slot=await save('attendant','slot',values,slot);
  eq(slot.product_id,null);eq(slot.capacity_quantity,null);
  slot=await save('attendant','slot',{...values,product_id:id(21),capacity_quantity:12},slot);
  eq(slot.product_id,id(21));
  slot=await save('attendant','slot',{...values,product_id:product,capacity_quantity:12,x_ratio:.25,width_ratio:.5},slot);
  eq(slot.x_ratio,.25);eq(slot.width_ratio,.5);
  slot=await save('attendant','slot',{...slot,fridge_id:f2.id,shelf_id:h2.id},slot);
  eq(slot.fridge_id,f2.id);eq(slot.shelf_id,h2.id);
  const removed=await save('attendant','slot',{...capacityOnly,active:false},capacityOnly);
  eq(removed.active,false);
  const empty=await save('attendant','shelf',{name:'Removível',fridge_id:f.id});
  eq((await save('attendant','shelf',{...empty,active:false},empty)).active,false);
  eq(await ledger(),before);
  await get('owner','select public.guigs_allocate_fridge_stock($1,$2,$3) data',[shop,randomUUID(),JSON.stringify([{lot_id:lot,slot_id:slot.id,quantity:3}])]);
  const afterStock=await ledger();
  for(const change of [{product_id:null},{product_id:id(21)},{capacity_quantity:null},{capacity_quantity:2},{active:false},{fridge_id:f.id,shelf_id:h.id}]){
   await reject(()=>save('attendant','slot',{...slot,...change},slot),/saldo incompatível/);
  }
  await reject(()=>save('attendant','shelf',{...h2,active:false},h2),/Prateleira com saldo/);
  await reject(()=>save('attendant','fridge',{...f2,active:false},f2),/Geladeira com saldo/);
  slot=await save('attendant','slot',{...slot,x_ratio:0,width_ratio:1,capacity_quantity:14},slot);
  eq(slot.width_ratio,1);eq(slot.capacity_quantity,14);
  eq(await ledger(),afterStock);
  await reject(()=>get('attendant',"select public.guigs_get_reports($1,now()-interval '1 day',now()) data",[shop]),/proprietário/);
  await reject(()=>get('attendant','select public.guigs_list_fridge_layout_access($1) data',[shop]),/proprietários/);
  await reject(()=>grant('attendant',false),/proprietários/);
  await reject(()=>asUser(db,'attendant',tx=>tx.query('update public.guigs_memberships set manage_fridge_layout=true where user_id=$1',[id(2)])),/permission denied/);
  await grant('owner',false);
  eq((await map('attendant')).can_manage_layout,false);
  await reject(()=>save('attendant','fridge',{name:'Revogado'}),/Sem permissão/);
  const last=await map('attendant');
  eq(last.slots.reduce((n,s)=>n+s.quantity,0)+last.unallocated.reduce((n,l)=>n+l.quantity,0),8);
  eq((await db.query("select sum(delta)::int n from public.guigs_movements where location='stock' and lot_id=$1",[lot])).rows[0].n,10);
  console.log('Mapa modular: '+checks+' verificações passaram; dados artificiais.');
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
