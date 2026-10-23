const assert=require('node:assert/strict');
const {seed,report,args,id,asUser}=require('./reports-support.cjs');
let checks=0;const check=(value,message)=>{assert.ok(value,message);checks++;};
(async()=>{
 const db=await seed();
 try {
  const data=await report(db);
  for(const [key,value] of Object.entries({receipt_units:125,receipt_operations:3,sale_units:7,sale_operations:1,loss_units:3,loss_operations:1,transfer_units:7,transfer_operations:2,adjust_operations:2,adjust_net_units:3}))check(data.summary[key]===value,key);
  check(data.sales[0].product==='COCA COLA 2L'&&data.sales[0].units===7,'Ranking por saída de venda');
  check(data.loss_ranking[0].units===3,'Ranking de perdas');
  check(data.losses[0].lot==='L3-2103'&&data.losses[0].actor==='owner@test.invalid','Detalhe de perda e responsável');
  check(data.losses[0].note.includes('avaria'),'Motivo preservado');
  check(data.suppliers.find(s=>s.supplier==='BEBIDAS ÁGUA').units===120,'Snapshot de fornecedor preservado apesar de renomeação');
  check(data.suppliers.find(s=>s.supplier==='Não informado').units===5,'Legado sem atribuição retroativa');
  check(!JSON.stringify(data.suppliers).includes('Nome atual diferente'),'Nome atual do fornecedor não reescreve passado');
  check(data.activity.length===2,'Atividade por autor');
  check(data.activity.find(a=>a.actor==='owner@test.invalid').transfers===2,'Pares de transferência contam uma vez por responsável');
  check(data.activity.find(a=>a.actor==='attendant@test.invalid').sales===1,'Atividade de atendente');
  check(data.inventories.length===2&&data.inventory_count===2,'Histórico inclui concluído/cancelado');
  check(data.inventories.find(i=>i.status==='completed').divergent===1,'Divergência do inventário');
  check(data.latest_inventory!==null,'Último inventário independente do período');
  check(data.stock.lots.length===9,'Fotografia atual de lotes, inclusive zerados identificáveis');
  check(data.stock.balances.find(b=>b.lot_id===id(60)).stock===1,'Saldo atual inclui movimentos fora do filtro');
  check(!data.stock.balances.some(b=>b.lot_id===id(66)),'Lote vazio sem saldo não vira risco');
  check(!JSON.stringify(data).includes('event_id')&&!JSON.stringify(data.losses).includes('actor_id'),'Sem identificadores desnecessários no histórico gerencial');
  for(const options of [{p_from:null},{p_to:args.p_from},{p_from:'infinity'},{p_to:'2028-01-01T00:00:00Z'},{p_limit:0},{p_limit:101},{p_limit:null},{p_loss_offset:-1},{p_inventory_offset:-1},{p_loss_offset:null}]) {
   await assert.rejects(report(db,'owner',options),/inválid/i);checks++;
  }
  await assert.rejects(report(db,'attendant'),/proprietário/);checks++;
  await assert.rejects(report(db,'owner',{p_shop_id:id(99)}),/proprietário/);checks++;
  await db.query('insert into public.guigs_shops(id,name) values($1,$2)',[id(99),'Outra loja artificial']);
  await db.query("insert into public.guigs_memberships(shop_id,user_id,role) values($1,$2,'owner')",[id(99),id(2)]);
  const other=await report(db,'attendant',{p_shop_id:id(99)});
  check(other.summary.receipt_units===0&&other.stock.products.length===0,'Owner de outra loja não recebe dados da primeira');
  await db.query('update public.guigs_memberships set active=false where shop_id=$1 and user_id=$2',[id(10),id(1)]);
  await assert.rejects(report(db),/proprietário/);checks++;
  await db.query('update public.guigs_memberships set active=true where shop_id=$1 and user_id=$2',[id(10),id(1)]);
  const empty=await report(db,'owner',{p_from:'2025-01-01T00:00:00Z',p_to:'2025-01-02T00:00:00Z'});
  check(empty.loss_count===0&&empty.sales.length===0&&empty.suppliers.length===0,'Período vazio');
  check(empty.stock.products.length>0&&empty.latest_inventory!==null,'Estoque atual e último inventário independem do período');
  const boundary=await report(db,'owner',{p_from:'2026-10-01T02:59:59Z',p_to:'2026-10-01T03:00:00Z'});
  check(boundary.summary.receipt_units===1,'Início inclusivo/fim exclusivo');
  const paged=await report(db,'owner',{p_limit:1});
  check(paged.suppliers.length===1&&paged.supplier_count===2,'Limite de lista com total completo');
  check(paged.inventories.length===1&&paged.inventory_count===2,'Paginação de inventários');
  const next=await report(db,'owner',{p_limit:1,p_inventory_offset:1,p_loss_offset:1});
  check(next.inventories[0].status!==paged.inventories[0].status&&next.losses.length===0,'Offsets independentes');
  check(paged.summary.receipt_units===125,'Resumo não é truncado pelo limite');
  const before=(await db.query('select count(*)::integer as n from public.guigs_movements')).rows[0].n;
  await report(db);check((await db.query('select count(*)::integer as n from public.guigs_movements')).rows[0].n===before,'Relatório sem efeitos de escrita');
  await assert.rejects(asUser(db,'owner',async tx=>{await tx.exec('set local role anon');return tx.query('select public.guigs_get_reports($1,$2,$3)',[id(10),args.p_from,args.p_to]);}),/permission denied/);checks++;
  await db.query(`insert into public.guigs_movements(shop_id,lot_id,event_id,movement_type,location,delta,actor_id,note,created_at)
    select $1,$2,gen_random_uuid(),'loss','stock',-1,$3,'Página artificial','2026-10-15T12:00:00Z'::timestamptz+ n*interval '1 second' from generate_series(1,51)n`,[id(10),id(30),id(1)]);
  const first=await report(db),last=await report(db,'owner',{p_loss_offset:50});
  check(first.losses.length===50&&last.losses.length===2&&first.loss_count===52,'Perdas paginadas com total correto');
  check(first.summary.loss_units===54&&last.summary.loss_units===54,'Resumo inclui todas as páginas');
  check(!first.losses.some(a=>last.losses.some(b=>a.date===b.date)),'Sem repetição entre páginas com ordenação estável');
  check((await report(db,'owner',{p_loss_offset:1000})).losses.length===0,'Offset além do total retorna vazio');
  check((await report(db,'owner',{p_limit:100})).losses.length===52,'Limite máximo aceito');
  console.log(`Relatórios banco: ${checks} verificações passaram.`);
 }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
