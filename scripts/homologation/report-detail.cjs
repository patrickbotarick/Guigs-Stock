const {ids,loginAll,rpc,check,report}=require('./live.cjs');
(async()=>{
 const {clients:c,state}=await loginAll(),owner=c.ownerA;
 const data=await rpc(owner,'guigs_get_reports',{p_shop_id:ids.shopA,p_from:'2026-10-01T03:00:00Z',p_to:'2026-11-01T03:00:00Z'});check(!data.error,'Relatório detalhado real');
 const [movements,lots,products,inventories]=await Promise.all(['guigs_movements','guigs_lots','guigs_products','guigs_inventories'].map(t=>owner.from(t).select('*')));check([movements,lots,products,inventories].every(x=>!x.error),'Bases artificiais independentes para conferência');
 const r=data.data;
 for(const b of r.stock.balances)for(const loc of ['stock','fridge'])check(Number(b[loc])===movements.data.filter(m=>m.lot_id===b.lot_id&&m.location===loc).reduce((n,m)=>n+m.delta,0),'Saldo corrente conferido '+loc);
 check(r.stock.lots.every(l=>lots.data.some(x=>x.id===l.id&&x.expiry===l.expiry)),'Datas de validade reais preservadas no relatório');
 check(r.stock.products.every(p=>products.data.some(x=>x.id===p.id&&x.min_total===p.min_total&&x.min_fridge===p.min_fridge&&x.target_fridge===p.target_fridge)),'Parâmetros reais de reposição preservados');
 const moves=movements.data.filter(m=>m.created_at>='2026-10-01T03:00:00Z'&&m.created_at<'2026-11-01T03:00:00Z');
 for(const [role,user]of Object.entries(state.users).filter(([role])=>!role.includes('B'))){const activity=r.activity.find(a=>a.actor===user.email),own=moves.filter(m=>m.actor_id===user.id);if(!own.length)continue;check(!!activity,'Atividade do autor '+role);for(const [field,types]of Object.entries({receipts:['receipt'],transfers:['transfer','return'],sales:['sale'],losses:['loss'],adjustments:['adjust']}))check(activity[field]===new Set(own.filter(m=>types.includes(m.movement_type)).map(m=>m.event_id)).size,'Atividade real '+role+' '+field);}
 const suppliers=new Map();for(const m of moves.filter(m=>m.movement_type==='receipt'&&m.delta>0)){const name=m.note.startsWith('Fornecedor: ')?m.note.slice(12).split('\n')[0].trim()||'Não informado':'Não informado';suppliers.set(name,(suppliers.get(name)||0)+m.delta);}
 check(r.suppliers.every(s=>s.units===suppliers.get(s.supplier))&&r.supplier_count===suppliers.size,'Fornecedores conferidos pelo snapshot histórico');
 const loss=moves.filter(m=>m.movement_type==='loss'&&m.delta<0);check(r.losses.length===loss.length&&r.losses.every(l=>loss.some(m=>m.note===l.note&&-m.delta===l.units)),'Perdas e motivos conferidos com movimentos');
 check(r.inventory_count===inventories.data.filter(i=>['completed','cancelled'].includes(i.status)).length,'Histórico gerencial confere com inventários reais');
 check(r.latest_inventory?.status==='completed','Último inventário concluído correto');
 report('report-detail-results');
})().catch(()=>{console.error('Falha na conferência detalhada; dados privados omitidos.');report('report-detail-results');process.exitCode=1;});
