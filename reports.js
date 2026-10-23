// Relatórios somente em memória. Agregações históricas pertencem à RPC owner-only.
export function createReportsUI({getContext, dayDifference, replenishmentFor}) {
  const el = id => document.getElementById(id);
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const formatDate = value => value ? new Date(value).toLocaleString('pt-BR') : 'Não informado';
  const dateInput = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const statusLabel = status => ({open:'Aberto',review:'Em revisão',completed:'Concluído',cancelled:'Cancelado'}[status] || status);
  const quantity = (value, singular, plural) => `${value} ${Number(value)===1?singular:plural}`;
  let busy = false, data = null, applied = null, lossOffset = 0, inventoryOffset = 0, generation = 0;
  const limit = 50;
  const owner = () => getContext().shop?.role === 'owner';
  function message(text) { el('reportsMessage').textContent = text; }
  function controls() {
    el('reportsOffline').classList.toggle('hidden',navigator.onLine);
    for (const id of ['reportsReload','reportsPeriod','reportsFrom','reportsTo']) el(id).disabled = busy || !navigator.onLine || !owner();
    el('reportsExport').disabled = busy || !navigator.onLine || !owner() || !data || !applied || !data.losses.length;
    el('reportsLossPrevious').disabled = busy || !navigator.onLine || !owner() || !applied || lossOffset === 0;
    el('reportsLossNext').disabled = busy || !navigator.onLine || !owner() || !applied || lossOffset+limit >= (data?.loss_count || 0);
    el('reportsInventoryPrevious').disabled = busy || !navigator.onLine || !owner() || !applied || inventoryOffset === 0;
    el('reportsInventoryNext').disabled = busy || !navigator.onLine || !owner() || !applied || inventoryOffset+limit >= (data?.inventory_count || 0);
  }
  function quickPeriod() {
    const kind = el('reportsPeriod').value;
    const end = new Date(), start = new Date(end);
    if (kind === 'custom') return;
    if (kind === '7' || kind === '30') start.setDate(start.getDate()-Number(kind)+1);
    if (kind === 'month') start.setDate(1);
    if (kind === 'previous') { start.setMonth(start.getMonth()-1,1); end.setDate(0); }
    el('reportsFrom').value = dateInput(start);
    el('reportsTo').value = dateInput(end);
  }
  function range() {
    const from = el('reportsFrom').value, to = el('reportsTo').value;
    const parse = value => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('Preencha as duas datas.');
      const [y,m,d] = value.split('-').map(Number);
      const result = new Date(y,m-1,d);
      if (dateInput(result) !== value) throw Error('Data inválida.');
      return result;
    };
    const begin = parse(from), end = parse(to);
    if (end < begin) throw Error('A data final deve ser igual ou posterior à inicial.');
    end.setDate(end.getDate()+1);
    if (end-begin > 366*86400000) throw Error('Escolha um período de até 366 dias.');
    return {from,to,p_from:begin.toISOString(),p_to:end.toISOString()};
  }
  function list(id, rows, empty, renderRow, total = rows.length) {
    const container = el(id);
    container.replaceChildren();
    if (!rows.length) container.append(node('p',empty,'muted'));
    else for (const row of rows) container.append(renderRow(row));
    if (total>rows.length && !['reportsLosses','reportsInventories'].includes(id)) container.append(node('p',`Exibindo ${rows.length} de ${total}. Resumos do período incluem todos os registros.`,'muted'));
  }
  function card(title, lines) {
    const element = node('article',null,'report-card');
    element.append(node('h3',title));
    for (const line of lines) element.append(node('p',line));
    return element;
  }
  function inventoryCard(row) {
    return card(statusLabel(row.status),[`Data de início: ${formatDate(row.started_at)}`,`Data do estado: ${formatDate(row.date)}`,`Iniciado por: ${row.actor}`,`Itens: ${row.items} · Contados: ${row.counted} · Divergentes: ${row.divergent}`]);
  }
  function render(stockDate) {
    const s = data.summary;
    const summary = el('reportsSummary'); summary.replaceChildren();
    const metrics = [['Recebimentos',s.receipt_units,s.receipt_operations],['Saídas por venda',s.sale_units,s.sale_operations],['Perdas',s.loss_units,s.loss_operations],['Estoque ↔ geladeira',s.transfer_units,s.transfer_operations]];
    if (!metrics.some(row=>Number(row[2])) && !Number(s.adjust_operations)) summary.append(node('p','Nenhuma operação registrada neste período.'));
    else {
      for (const [label,units,operations] of metrics) summary.append(card(label,[`${quantity(units,'unidade','unidades')} · ${quantity(operations,'operação','operações')}`]));
      summary.append(card('Ajustes',[quantity(s.adjust_operations,'operação','operações'),`${quantity(s.adjust_net_units,'unidade','unidades')} de variação líquida (pode haver compensação)`]));
    }
    const ranking = row => card(row.product,[quantity(row.units,'unidade','unidades')]);
    list('reportsSales',data.sales,'Nenhuma saída por venda registrada neste período.',ranking,data.sales_count);
    list('reportsLossRanking',data.loss_ranking,'Nenhuma perda registrada neste período.',ranking,data.loss_ranking_count);
    list('reportsLosses',data.losses,'Nenhuma perda registrada neste período.',row=>card(`${row.product} · Lote ${row.lot}`,[`${row.units} unidades · ${formatDate(row.date)}`,`Responsável: ${row.actor}`,`Motivo / observação: ${row.note || 'Não informado'}`]));
    el('reportsLossPage').textContent = `Página ${Math.floor(lossOffset/limit)+1} · ${quantity(data.loss_count,'registro','registros')} de perda`;
    list('reportsSuppliers',data.suppliers,'Nenhum recebimento registrado neste período.',row=>card(row.supplier,[`${quantity(row.operations,'recebimento','recebimentos')} · ${quantity(row.units,'unidade','unidades')}`,`Último recebimento no período: ${formatDate(row.latest)}`]),data.supplier_count);
    list('reportsActivity',data.activity,'Nenhuma atividade registrada neste período.',row=>card(row.actor,[`Recebimentos: ${row.receipts} · Movimentações: ${row.transfers}`,`Saídas por venda: ${row.sales} · Perdas: ${row.losses} · Ajustes: ${row.adjustments}`]),data.activity_count);
    list('reportsLatestInventory',data.latest_inventory?[data.latest_inventory]:[],'Nenhum inventário iniciado.',inventoryCard);
    list('reportsInventories',data.inventories,'Nenhum inventário concluído ou cancelado neste período.',inventoryCard);
    el('reportsInventoryPage').textContent = `Página ${Math.floor(inventoryOffset/limit)+1} · ${data.inventory_count} inventários encerrados`;

    // Fotografia da mesma chamada; helpers da visão geral são a regra única da 1.6B.
    const {products,lots,balances} = data.stock;
    const lotBalances = new Map(balances.map(b=>[b.lot_id,{stock:Number(b.stock),fridge:Number(b.fridge)}]));
    const buckets = ['Vencidos','Vencem em até 15 dias','Vencem entre 16–30 dias','Acima de 30 dias'].map(label=>({label,lots:0,units:0}));
    for (const lot of lots) {
      const balance = lotBalances.get(lot.id) || {stock:0,fridge:0}, units = balance.stock+balance.fridge;
      if (units<=0) continue;
      const days = dayDifference(lot.expiry), bucket = buckets[days<0?0:days<=15?1:days<=30?2:3];
      bucket.lots++; bucket.units+=units;
    }
    list('reportsExpiry',buckets.filter(b=>b.lots),'Nenhum lote com saldo atual.',row=>card(row.label,[`${quantity(row.lots,'lote','lotes')} · ${quantity(row.units,'unidade atual','unidades atuais')}`]));
    el('reportsExpiryNote').textContent = buckets[1].lots+buckets[2].lots===0 ? 'Nenhum lote próximo do vencimento (0–30 dias).' : 'Lotes zerados não entram nas faixas.';
    const rows = [];
    for (const product of products.filter(p=>p.active)) {
      const balance = lots.filter(l=>l.product_id===product.id).reduce((sum,l)=>{
        const b=lotBalances.get(l.id) || {stock:0,fridge:0};sum.stock+=b.stock;sum.fridge+=b.fridge;return sum;
      },{stock:0,fridge:0});
      const advice = replenishmentFor(product,balance,lots,lotBalances);
      const totalLow = balance.stock+balance.fridge<product.min_total, fridgeLow = balance.fridge<product.min_fridge;
      if (totalLow || fridgeLow || advice.deficit>0) rows.push({product,balance,advice,totalLow,fridgeLow});
    }
    list('reportsRestock',rows,'Nenhum produto ativo abaixo do mínimo ou com reposição pendente.',r=>card(r.product.name,[
      `Total: ${r.balance.stock+r.balance.fridge} · Mínimo total: ${r.product.min_total}${r.totalLow?' · Abaixo do mínimo total':''}`,
      `Geladeira: ${r.balance.fridge} · Mínimo: ${r.product.min_fridge} · Meta: ${r.product.target_fridge}${r.fridgeLow?' · Abaixo do mínimo da geladeira':''}`,
      `Reposição sugerida: ${r.advice.suggested} unidades · Seco não vencido disponível: ${r.advice.available}`,
      r.advice.suggested<r.advice.deficit?`Estoque seco insuficiente: faltam ${r.advice.deficit-r.advice.suggested} unidades para atingir a meta.`:'Estoque seco suficiente para a meta.'
    ]));
    el('reportsStockDate').textContent = `Estoque atual consultado em ${stockDate}. Validade usa o dia local do aparelho; não é fotografia do período.`;
  }
  async function load() {
    if (busy) return;
    if (!owner()) { reset(); message('Relatórios disponíveis apenas ao proprietário.'); return; }
    if (!navigator.onLine) { controls(); return; }
    const {client,shop} = getContext(); if (!client) return;
    let selected;
    try { selected=range(); } catch(error) { applied=null; message(error.message);controls();return; }
    busy=true;applied=null;controls(); message('Consultando relatórios…');
    const ticket=++generation;
    try {
      const response = await client.rpc('guigs_get_reports',{p_shop_id:shop.shop_id,p_from:selected.p_from,p_to:selected.p_to,p_limit:limit,p_loss_offset:lossOffset,p_inventory_offset:inventoryOffset});
      if (ticket!==generation || !owner()) return;
      if (response.error) throw response.error;
      if (!navigator.onLine) throw Error('Conexão indisponível. Atualize quando estiver online.');
      data=response.data;applied=selected;render(new Date().toLocaleString('pt-BR'));
      message(`Período aplicado: ${selected.from} a ${selected.to} (dias locais completos).`);
    } catch(error) {
      message(['PGRST202','42883','42P01'].includes(error.code)?'Relatórios indisponíveis neste ambiente. A preparação da v1.6 precisa estar homologada e instalada pelo responsável.':`Não foi possível atualizar os relatórios. Os dados exibidos podem estar desatualizados. ${error.message || ''}`);
    } finally { busy=false;controls(); }
  }
  function reset() {
    generation++;data=null;applied=null;lossOffset=0;inventoryOffset=0;
    for (const target of el('reportsView').querySelectorAll('[data-report-content]')) target.replaceChildren();
    controls();
  }
  function dirty() { applied=null;lossOffset=0;inventoryOffset=0;message('Filtros alterados. Atualize para aplicar o período.');controls(); }
  el('reportsPeriod').addEventListener('change',()=>{quickPeriod();dirty();});
  for (const id of ['reportsFrom','reportsTo']) el(id).addEventListener('input',()=>{el('reportsPeriod').value='custom';dirty();});
  el('reportsReload').addEventListener('click',()=>void load());
  for (const [id,kind,delta] of [['reportsLossPrevious','loss',-limit],['reportsLossNext','loss',limit],['reportsInventoryPrevious','inventory',-limit],['reportsInventoryNext','inventory',limit]]) {
    el(id).addEventListener('click',()=>{if (busy || !owner() || !navigator.onLine || !applied) return;if(kind==='loss')lossOffset=Math.max(0,lossOffset+delta);else inventoryOffset=Math.max(0,inventoryOffset+delta);void load();});
  }
  el('reportsExport').addEventListener('click',()=>{
    if (!owner() || busy || !navigator.onLine || !data || !applied || !data.losses.length) return;
    // Todas as células são escapadas, inclusive fórmulas precedidas de espaços/controles.
    const cell = value => {
      let text=String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text="'"+text;
      return '"'+text.replaceAll('"','""')+'"';
    };
    const rows=[['Perdas — página exibida',applied.from,applied.to,`Página ${Math.floor(lossOffset/limit)+1}`],['Produto','Lote','Unidades perdidas','Data','Responsável','Motivo / observação'],...data.losses.map(r=>[r.product,r.lot,r.units,formatDate(r.date),r.actor,r.note])];
    const blob = new Blob(['\ufeff'+rows.map(row=>row.map(cell).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob), link=node('a');link.href=url;link.download=`perdas-${applied.from}-${applied.to}-pagina-${Math.floor(lossOffset/limit)+1}.csv`;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  window.addEventListener('offline',controls);window.addEventListener('online',controls);
  quickPeriod();controls();
  return {activate:load,reset,sync:controls};
}
