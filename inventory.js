// Módulo carregado com o dashboard; RPCs de inventário só são consultadas nesta view.
import { IMAGE_BUCKET } from './image-library.js';

const LOTS_PER_PAGE = 24;
const normalizeSearch = value => value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{Diacritic}/gu,'');
const counted = item => item.counted_quantity != null;
const partitionRank = item => item.location==='stock' ? 0 : item.slot_id ? 2 : 1;

export function createInventoryUI({getContext, confirmAction, refreshStock}) {
  const el = id => document.getElementById(id);
  const statusLabel = {open:'Aberto',review:'Em revisão',completed:'Concluído',cancelled:'Cancelado'};
  const localLabel = value => value === 'stock' ? 'Estoque seco' : 'Geladeira';
  const itemLabel = item => positionLabels.get(item.slot_id) || item.slot_label ||
    (data?.inventory.spatial&&item.location==='fridge'?'Geladeira — não alocado':localLabel(item.location));
  const date = value => value ? new Date(value).toLocaleString('pt-BR') : '—';
  const actor = (value,label) => label || (value ? `Usuário ${value.slice(0,8)}` : '—');
  let data = null;
  let pending = false;
  let loading = 0;
  let detailLoading = 0;
  let page = 0;
  let total = 0;
  let activeInventory = null;
  let loaded = false;
  let reviewApproved = false;
  let lotPage = 0;
  let lots = [];
  let positionLabels = new Map();
  const lotExpansion = new Map();
  const images = new Map();
  let createSpatial=false;
  const spatialIds=new Set(),closeKeys=new Map();
  const spatialRPC={
    guigs_get_inventory:'guigs_get_spatial_inventory',
    guigs_count_inventory_item:'guigs_count_spatial_inventory_item',
    guigs_recount_inventory_item:'guigs_recount_spatial_inventory_item',
    guigs_refresh_inventory_scope:'guigs_refresh_spatial_inventory_scope',
    guigs_set_inventory_status:'guigs_set_spatial_inventory_status',
    guigs_complete_inventory:'guigs_complete_spatial_inventory'
  };
  const drafts = new Map(); // Somente memória da página; não salva contagem automaticamente.
  function message(text, error = false) {
    el('inventoryMessage').textContent = text;
    el('inventoryMessage').className = `notice ${error ? 'danger' : 'good'}`;
  }
  async function rpc(name, args = {}) {
    const {client, shop} = getContext();
    if (!navigator.onLine) throw Error('Sem internet: inventário somente para consulta dos dados já exibidos.');
    if (!client || !shop) throw Error('Aguarde a autenticação.');
    const endpoint=spatialIds.has(args.p_inventory_id)?spatialRPC[name]||name:name;
    const result = await client.rpc(endpoint, {p_shop_id:shop.shop_id,...args});
    if (result.error) {
      if (result.error.code === 'PGRST202' || /does not exist|schema cache/i.test(result.error.message || '')) {
        throw Error('Inventário indisponível neste ambiente. A migration 007 precisa ser homologada e aplicada pelo responsável; não execute em produção nesta fase.');
      }
      if (result.error.code === '55P03') throw Error('Há operação de estoque em andamento. Aguarde e tente novamente; nenhuma alteração foi aplicada.');
      throw Error(result.error.message || 'Não foi possível consultar o inventário.');
    }
    return result.data;
  }
  function sync() {
    const owner = getContext().shop?.role === 'owner';
    const current = data?.inventory;
    const active = current && ['open','review'].includes(current.status);
    el('newInventory').classList.toggle('hidden', !owner);
    el('newSpatialInventory').classList.toggle('hidden', !owner);
    for (const id of ['inventoryReview','inventoryReopen','inventoryCancel','inventoryComplete','inventoryScope']) {
      el(id).classList.toggle('hidden', !owner || !active);
    }
    el('inventoryReview').classList.toggle('hidden', !owner || current?.status !== 'open');
    el('inventoryReopen').classList.toggle('hidden', !owner || current?.status !== 'review');
    el('inventoryScope').classList.toggle('hidden', !owner || current?.status !== 'open' || !data?.new_lots);
    el('inventoryComplete').classList.toggle('hidden', !owner || current?.status !== 'review');
    const blocked = pending || !navigator.onLine;
    el('inventoryView').querySelectorAll('[data-inventory-write]').forEach(button => { button.disabled = blocked; });
    el('inventoryView').querySelectorAll('[data-inventory-open]').forEach(button => { button.disabled = pending; });
    const resume=el('inventoryResume');
    resume.classList.toggle('hidden',!activeInventory);
    resume.disabled=pending||!navigator.onLine&&current?.id!==activeInventory?.id;
    resume.textContent=activeInventory?.status==='review'?'Retomar revisão':'Retomar contagem';
    el('inventoryOpenSummary').textContent=activeInventory
      ? `Em andamento: #${activeInventory.id.slice(0,8)} · ${statusLabel[activeInventory.status]}`
      : loaded&&!total?'Nenhum inventário registrado.':'';
    el('inventoryHistoryPanel').classList.toggle('hidden',!total);
    el('inventoryView').querySelectorAll('.inventory-count-input').forEach(input => { input.disabled = blocked; });
    el('inventoryReload').disabled = blocked;
    el('inventoryCreateSubmit').disabled = blocked || !owner;
    el('inventoryObservation').disabled = blocked;
    el('inventoryPrevious').disabled = blocked || page === 0;
    el('inventoryNext').disabled = blocked || (page+1)*50 >= total;
    el('inventoryComplete').disabled = blocked || !reviewApproved || !data?.items.length ||
      data.items.some(item => item.counted_quantity === null || item.conflict) || !!data.new_lots;
    el('inventoryOffline').classList.toggle('hidden', navigator.onLine);
  }
  async function loadList() {
    const ticket = ++loading;
    const result = await rpc('guigs_list_inventories',{p_limit:50,p_offset:page*50});
    if (ticket !== loading) return;
    total = result.total;
    const list = el('inventoryList');
    list.replaceChildren();
    const active = result.inventories.find(inv => ['open','review'].includes(inv.status));
    if(page===0||active)activeInventory=active||null;
    el('inventoryLastCompleted').textContent = result.last_completed
      ? `Último concluído: ${date(result.last_completed.completed_at)} · ${actor(result.last_completed.completed_by,result.last_completed.completed_by_label)}` : '';
    for (const inv of result.inventories) {
      const entry = document.createElement('article');
      entry.className = 'inventory-history-card';
      const info = document.createElement('p');
      const difference=inv.status==='open'||inv.divergent_count==null?'':` · Divergentes: ${inv.divergent_count}`;
      info.textContent = `#${inv.id.slice(0,8)} · ${statusLabel[inv.status]} · Início: ${date(inv.started_at)} · ${actor(inv.started_by,inv.started_by_label)} · Itens: ${inv.item_count} · Conferidos: ${inv.counted_count}${difference} · Conclusão: ${date(inv.completed_at)}`;
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'btn'; open.textContent = 'Abrir inventário';
      open.dataset.inventoryOpen='true';
      if(inv.spatial){spatialIds.add(inv.id);info.textContent+=' · Por posição';}
      open.addEventListener('click', () => void readInventory(inv.id));
      entry.append(info,open); list.append(entry);
    }
    el('inventoryPage').textContent = `Página ${page+1} · ${total} inventário(s)`;
    loaded = true;
    sync();
  }
  async function readInventory(id, propagate = false) {
    const ticket = ++detailLoading;
    try {
      const result = await rpc('guigs_get_inventory',{p_inventory_id:id});
      if (ticket !== detailLoading) return;
      if (data?.inventory.id !== result.inventory.id) {
        lotPage=0; lotExpansion.clear(); drafts.clear();
        for(const field of ['inventorySearch','inventoryLocation','inventoryFridge','inventoryPosition']) el(field).value='';
        el('inventoryFilter').value='all';
      }
      if (data?.inventory.id !== result.inventory.id || data?.inventory.version !== result.inventory.version) reviewApproved = false;
      data = result;
      if(activeInventory?.id===result.inventory.id) {
        activeInventory=['open','review'].includes(result.inventory.status)?result.inventory:null;
      }
      renderDetail();
      sync();
      return true;
    } catch (error) {
      if (propagate) throw error;
      message(error.message,true);
    }
    sync();
  }
  function stateOf(item) {
    if (!counted(item)) return 'pending';
    if (data.inventory.status==='open' || item.basis_quantity==null) return 'counted';
    return Number(item.counted_quantity) === Number(item.basis_quantity) ? 'equal' : Number(item.counted_quantity) > Number(item.basis_quantity) ? 'positive' : 'negative';
  }
  const divergent = item => ['positive','negative'].includes(stateOf(item));
  const needsRecount = item => ['open','review'].includes(data.inventory.status) && item.conflict;
  const verified = item => counted(item) && !needsRecount(item);

  function prepareGroups(items) {
    const groups=new Map(), positions=new Map(), labels=new Map();
    for(const item of items) {
      const key=item.product_id+':'+item.lot_id;
      if(!groups.has(key)) groups.set(key,{key,head:item,items:[],search:normalizeSearch(item.product_name+' '+item.lot_code)});
      groups.get(key).items.push(item);
      if(item.slot_id) positions.set(item.slot_id,item.slot_label);
    }
    for(const [id,label] of positions) {
      if(!labels.has(label)) labels.set(label,[]);
      labels.get(label).push(id);
    }
    positionLabels=new Map([...labels].flatMap(([label,ids])=>ids.sort().map((id,index)=>
      [id,ids.length===1?label:`${label} · posição ${index+1}`])));
    const order=(a,b)=>a.localeCompare(b,'pt-BR',{numeric:true});
    lots=[...groups.values()].sort((a,b)=>order(a.head.product_name,b.head.product_name)||
      a.head.product_id.localeCompare(b.head.product_id)||a.head.expiry.localeCompare(b.head.expiry)||
      order(a.head.lot_code,b.head.lot_code)||a.head.lot_id.localeCompare(b.head.lot_id));
    for(const group of lots) group.items.sort((a,b)=>partitionRank(a)-partitionRank(b)||order(itemLabel(a),itemLabel(b)));
  }
  function renderDetail() {
    const current = data.inventory;
    const items = data.items;
    el('inventoryDetail').classList.remove('hidden');
    el('inventoryDetailTitle').textContent = `Inventário #${current.id.slice(0,8)} · ${statusLabel[current.status]}`;
    el('inventoryDetailInfo').textContent = `${current.spatial?'Por posição · ':''}Iniciado ${date(current.started_at)} · ${actor(current.started_by,current.started_by_label)} · ${current.observation || 'Sem observação'}`;
    prepareGroups(items);
    const confirmed=items.filter(verified).length;
    const localCount=new Set(items.map(i=>i.slot_id || i.location)).size;
    const productCount=new Set(items.map(i=>i.product_id)).size;
    el('inventoryBlindHint').classList.toggle('hidden', current.status!=='open');
    const differencesSummary=current.status==='open'?'':` · Divergentes: ${items.filter(divergent).length}`;
    el('inventoryTotals').textContent = `Produtos: ${productCount} · Lotes: ${lots.length} · Locais distintos: ${localCount} · Posições de contagem: ${items.length} · Conferidos: ${confirmed} · Pendentes: ${items.length-confirmed}${differencesSummary}`;
    const active = ['open','review'].includes(current.status);
    const conflicts = items.filter(item=>item.conflict).length;
    el('inventoryMovementWarning').classList.toggle('hidden', !active || !(data.movements_after_start || data.new_lots));
    el('inventoryMovementWarning').classList.toggle('danger', conflicts > 0 || data.new_lots > 0);
    el('inventoryMovementWarning').textContent = `${data.movements_after_start} movimentação(ões) após o início. Itens ainda exigindo recontagem: ${conflicts}. Lotes novos fora do escopo: ${data.new_lots}. ${conflicts ? 'Reconte os locais afetados.' : 'Os itens já reconferidos não estão bloqueados por esses movimentos.'} O fechamento verifica novamente no servidor.`;
    const position=el('inventoryPosition'),previousPosition=position.value;
    const positions=new Map(items.filter(i=>i.location==='fridge').map(i=>[i.slot_id||'unallocated',itemLabel(i)]));
    position.replaceChildren(new Option('Todas as posições',''),...[...positions].sort(([idA,a],[idB,b])=>
      Number(idB==='unallocated')-Number(idA==='unallocated')||a.localeCompare(b,'pt-BR',{numeric:true})).map(([id,label])=>new Option(label,id)));
    position.value=positions.has(previousPosition)?previousPosition:'';
    el('inventoryPositionField').classList.toggle('hidden',!current.spatial);
    const fridge=el('inventoryFridge'), previousFridge=fridge.value;
    const fridges=new Map(items.filter(i=>i.fridge_id).map(i=>[i.fridge_id,i.slot_label?.split(' / ')[0]||'Geladeira']));
    fridge.replaceChildren(new Option('Todas as geladeiras',''),...[...fridges].sort((a,b)=>a[1].localeCompare(b[1],'pt-BR')).map(([id,name])=>new Option(name,id)));
    fridge.value=fridges.has(previousFridge)?previousFridge:'';
    el('inventoryFridgeField').classList.toggle('hidden',!fridges.size);
    const divergenceOption=el('inventoryFilter').querySelector('[value="divergent"]');
    divergenceOption.hidden=current.status==='open';
    divergenceOption.disabled=current.status==='open';
    if (divergenceOption.disabled && el('inventoryFilter').value==='divergent') el('inventoryFilter').value='all';
    el('inventoryReviewCheck').checked = reviewApproved;
    el('inventoryReviewGate').classList.toggle('hidden', current.status !== 'review' || getContext().shop?.role !== 'owner');
    const differences = el('inventoryDifferences');
    differences.replaceChildren();
    if (current.status !== 'open') {
      for (const item of items.filter(divergent)) {
        const row=document.createElement('p');
        row.textContent=`${item.product_name} · ${item.lot_code} · ${itemLabel(item)}: base ${item.basis_quantity} → contado ${item.counted_quantity} (${Number(item.counted_quantity)-Number(item.basis_quantity)>0?'+':''}${Number(item.counted_quantity)-Number(item.basis_quantity)})${item.conflict && active?' · MOVIMENTADO: RECONTAR':''}`;
        differences.append(row);
      }
      if (!differences.children.length) differences.textContent = 'Nenhuma divergência registrada.';
    }
    el('inventoryDifferencesPanel').classList.toggle('hidden',current.status==='open');
    const audit=el('inventoryAudit'); audit.replaceChildren();
    const itemsById=new Map(items.map(item=>[item.id,item]));
    for (const entry of data.audit) {
      const row=document.createElement('p');
      const names={created:'Criação',counted:'Contagem',recount:'Recontagem preparada',scope_refreshed:'Escopo atualizado',review:'Revisão',reopened:'Reabertura',completed:'Fechamento',cancelled:'Cancelamento'};
      const item=itemsById.get(entry.item_id);
      row.textContent=`${date(entry.created_at)} · ${actor(entry.actor_id,entry.actor_label)} · ${names[entry.action] || entry.action}${item?` · ${item.product_name} / ${item.lot_code} / ${itemLabel(item)}`:''}${entry.counted_quantity!==null?` · Contado: ${entry.counted_quantity}`:''}${entry.previous_quantity!==null?` · Contagem anterior: ${entry.previous_quantity}`:''}${entry.note?` · ${entry.note}`:''}`;
      audit.append(row);
    }
    renderItems(); sync();
  }
  function visibleLots() {
    const query=normalizeSearch(el('inventorySearch').value.trim()).split(/\s+/).filter(Boolean);
    const filter=el('inventoryFilter').value;
    const location=el('inventoryLocation').value;
    const fridge=el('inventoryFridge').value;
    const position=el('inventoryPosition').value;
    return lots.filter(group=>query.every(word=>group.search.includes(word))).map(group=>({
      group,
      visible:group.items.filter(item=>
        (!location || (location==='unallocated' ? item.location==='fridge'&&!item.slot_id : item.location===location)) &&
        (!fridge || item.fridge_id===fridge) &&
        (!position || (item.location==='fridge'&&(item.slot_id||'unallocated')===position)) &&
        (filter==='all' || (filter==='divergent'&&divergent(item)) || (filter==='pending'&&!verified(item)) ||
          (filter==='counted'&&verified(item)) || (filter==='recount'&&needsRecount(item))))
    })).filter(entry=>entry.visible.length);
  }

  function textElement(tag,text,className) {
    const node=document.createElement(tag);
    node.textContent=text;
    if(className)node.className=className;
    return node;
  }

  function renderPartition(item) {
    const current=data.inventory, state=stateOf(item);
    const row=document.createElement('section');
    const conflict=needsRecount(item);
    row.className='inventory-item inventory-'+state;
    row.dataset.itemId=item.id;
    const labels={pending:'Não contado',counted:'Contagem registrada',equal:'Sem divergência',
      positive:'Diferença positiva',negative:'Diferença negativa'};
    row.append(textElement('h4',itemLabel(item)),textElement('strong',conflict?'Requer recontagem':labels[state]));
    if (current.status==='open') {
      if (counted(item)) row.append(textElement('p','Quantidade física registrada: '+item.counted_quantity,'muted'));
    } else if(item.basis_quantity!=null) {
      const difference=counted(item)?Number(item.counted_quantity)-Number(item.basis_quantity):'—';
      row.append(textElement('p','Esperado inicial: '+item.expected_initial+' · Base de conferência: '+item.basis_quantity+
        ' · Contado: '+(item.counted_quantity??'Não contado')+' · Diferença: '+difference));
    }
    if (conflict) row.append(textElement('p','Movimentado após a base de conferência. Prepare uma recontagem física antes de finalizar.','notice danger'));
    if (current.status==='open') {
      if (!counted(item)) {
        const form=document.createElement('form');form.className='inventory-count-form';
        const label=textElement('label','Quantidade física');
        label.htmlFor='count-'+item.id;
        const input=document.createElement('input');input.id=label.htmlFor;input.type='number';input.inputMode='numeric';input.min='0';
        input.max='2147483647';input.step='1';input.required=true;input.className='inventory-count-input';
        input.setAttribute('aria-label','Quantidade física: '+item.product_name+' · lote '+item.lot_code+' · '+itemLabel(item));
        const draft=drafts.get(item.id);
        if (draft?.version===item.version) input.value=draft.value;
        else drafts.delete(item.id);
        input.addEventListener('input',()=>drafts.set(item.id,{value:input.value,version:item.version}));
        const save=textElement('button','Salvar contagem','btn green');save.type='submit';save.dataset.inventoryWrite='true';
        form.addEventListener('submit',event=>{
          event.preventDefault();if (!form.reportValidity()) return;
          const quantity=Number(input.value);
          void action(save,async()=>{
            await rpc('guigs_count_inventory_item',{p_inventory_id:current.id,p_item_id:item.id,p_quantity:quantity,p_version:item.version});
            drafts.delete(item.id);
            return 'Contagem salva. Estoque não alterado.';
          },current.id,()=>focusNext(item.id));
        });
        form.append(label,input,save);row.append(form);
      }
      if (counted(item)||conflict) {
        const recount=textElement('button','Recontar','btn');recount.type='button';recount.dataset.inventoryWrite='true';
        recount.dataset.inventoryRecount=item.id;
        recount.addEventListener('click',()=>void action(recount,async()=>{
          if (!await confirmAction('Preparar recontagem','Reconte fisicamente '+item.product_name+' / '+item.lot_code+' / '+itemLabel(item)+
            '. A evidência anterior será preservada e a base será atualizada.')) return;
          await rpc('guigs_recount_inventory_item',{p_inventory_id:current.id,p_item_id:item.id,p_version:item.version});
          drafts.delete(item.id);
          return 'Recontagem preparada. Conte novamente; estoque não alterado.';
        },current.id,()=>requestAnimationFrame(()=>el('count-'+item.id)?.focus())));
        row.append(recount);
      }
    }
    if (item.counted_at) row.append(textElement('p','Contagem: '+actor(item.counted_by,item.counted_by_label)+' · '+date(item.counted_at),'muted'));
    return row;
  }

  async function loadImages(targets) {
    const {client,shop}=getContext();
    if (!targets.length || !navigator.onLine || !client?.storage || !client.supabaseUrl || !shop) return;
    const origin=new URL(client.supabaseUrl).origin;
    const missing=[...new Set(targets.map(({path})=>path))].filter(path=>!(images.get(path)?.expires>Date.now()));
    if (missing.length) {
      try {
        const result=await client.storage.from(IMAGE_BUCKET).createSignedUrls(missing,300);
        if(getContext().shop?.shop_id!==shop.shop_id) return;
        for(const entry of result.data||[]) {
          if(!entry.signedUrl||!missing.includes(entry.path))continue;
          const url=new URL(entry.signedUrl);
          if(url.origin===origin&&url.pathname.startsWith('/storage/v1/object/sign/'+IMAGE_BUCKET+'/')) {
            images.set(entry.path,{url:url.href,expires:Date.now()+270000});
          }
        }
      } catch { /* A contagem permanece disponível com o ícone de produto. */ }
    }
    for(const {photo,path} of targets) {
      const entry=images.get(path);
      if(!photo.isConnected||!(entry?.expires>Date.now()))continue;
      const image=document.createElement('img');image.alt='';image.loading='lazy';image.decoding='async';image.src=entry.url;
      image.addEventListener('error',()=>{images.delete(path);photo.textContent='▧';},{once:true});
      photo.replaceChildren(image);
    }
  }

  function renderItems() {
    if (!data) return;
    const list=el('inventoryItems');
    const entries=visibleLots();
    lotPage=Math.min(lotPage,Math.max(0,Math.ceil(entries.length/LOTS_PER_PAGE)-1));
    list.replaceChildren();
    const fragment=document.createDocumentFragment(), targets=[];
    const products=new Map((getContext().products||[]).map(product=>[product.id,product]));
    let productId, product;
    const shown=entries.slice(lotPage*LOTS_PER_PAGE,(lotPage+1)*LOTS_PER_PAGE);
    for(const {group,visible} of shown) {
      const {head,items,key}=group;
      if (head.product_id!==productId) {
        productId=head.product_id;
        product=document.createElement('section');product.className='inventory-product';
        const header=document.createElement('header');header.className='inventory-product-head';
        const photo=textElement('span','▧','inventory-photo');photo.setAttribute('aria-hidden','true');
        const path=products.get(productId)?.image_path;
        if(path)targets.push({photo,path});
        header.append(photo,textElement('h3',head.product_name));
        product.append(header);fragment.append(product);
      }
      const confirmed=items.filter(verified).length;
      const conflict=items.some(needsRecount);
      const total=items.filter(counted).reduce((sum,item)=>sum+Number(item.counted_quantity),0);
      const differences=data.inventory.status==='open'?null:items.filter(divergent).length;
      const status=conflict?'Requer recontagem':differences?'Divergente':confirmed===items.length?'Conferido':confirmed?'Em andamento':'Não iniciada';
      const detail=document.createElement('details');detail.className='inventory-lot';detail.dataset.lotId=head.lot_id;
      detail.open=lotExpansion.get(key)??(shown.length<=8 || visible.length<items.length);
      detail.addEventListener('toggle',()=>lotExpansion.set(key,detail.open));
      const summary=document.createElement('summary');
      summary.append(textElement('strong','Lote '+head.lot_code),document.createTextNode(' · Validade: '+
        head.expiry.split('-').reverse().join('/')+' · '+status+' · '+confirmed+' de '+items.length+' localizações conferidas'));
      const progress=document.createElement('progress');progress.max=items.length;progress.value=confirmed;
      progress.setAttribute('aria-label','Progresso do lote '+head.lot_code);
      const stats=document.createElement('div');stats.className='inventory-lot-progress';
      const diff=differences===null?'':' · Divergências: '+differences;
      stats.append(progress,textElement('span',Math.floor(100*confirmed/items.length)+'% · Total contado: '+
        (items.some(counted)?total+' un.':'—')+diff));
      const locations=document.createElement('div');locations.className='inventory-partitions';
      for(const item of visible)locations.append(renderPartition(item));
      detail.append(summary,stats);
      if(head.supplier_name)detail.append(textElement('p','Fornecedor: '+head.supplier_name,'muted'));
      detail.append(locations);product.append(detail);
    }
    list.append(fragment);
    if (!entries.length) list.textContent='Nenhum item para estes filtros.';
    const matching=entries.reduce((sum,entry)=>sum+entry.visible.length,0);
    const hidden=data.items.length-matching;
    const paged=matching-shown.reduce((sum,entry)=>sum+entry.visible.length,0);
    const activeFilters = [el('inventoryLocation').value, el('inventoryFridge').value, el('inventoryPosition').value, el('inventoryFilter').value !== 'all'].filter(Boolean).length;
    el('inventoryFilterBadge').textContent = activeFilters ? activeFilters + ' ativo(s)' : '';
    el('inventoryFilterSummary').textContent=matching+' de '+data.items.length+' posições correspondem aos filtros. '+
      (hidden?hidden+' ocultas pelos filtros. ':'')+(paged?paged+' em outras páginas.':'');
    const pages=Math.max(1,Math.ceil(entries.length/LOTS_PER_PAGE));
    el('inventoryLotPager').classList.toggle('hidden',pages===1);
    el('inventoryLotPage').textContent='Página de lotes '+(lotPage+1)+' de '+pages;
    el('inventoryLotPrevious').disabled=lotPage===0;
    el('inventoryLotNext').disabled=lotPage+1===pages;
    void loadImages(targets);
    sync();
  }

  function focusNext(previousId) {
    if(data.inventory.status!=='open')return;
    const entries=visibleLots();
    const offset=entries.findIndex(entry=>entry.group.items.some(item=>item.id===previousId));
    const order=entries.slice(Math.max(offset,0)).concat(offset>0?entries.slice(0,offset):[]);
    const nextGroup=order.find(entry=>entry.visible.some(item=>!verified(item)&&item.id!==previousId));
    if(!nextGroup){el('inventoryTotals').focus();return;}
    const next=nextGroup.visible.find(item=>!verified(item)&&item.id!==previousId);
    const nextPage=Math.floor(entries.indexOf(nextGroup)/LOTS_PER_PAGE);
    lotExpansion.set(nextGroup.group.key,true);
    if(nextPage!==lotPage){lotPage=nextPage;renderItems();}
    const input=el('count-'+next.id)||el('inventoryItems').querySelector('[data-inventory-recount="'+CSS.escape(next.id)+'"]');
    if(!input)return;
    input.closest('details').open=true;
    requestAnimationFrame(()=>{
      input.scrollIntoView({block:'center'});
      input.focus();
    });
  }

  async function action(button, work, inventoryId, after) {
    if (pending || !navigator.onLine) return;
    pending=true;const label=button.textContent;button.textContent='Salvando…';button.disabled=true;sync();
    const createCancel=el('inventoryCreateDialog').querySelector('[data-close]');
    createCancel.disabled=el('inventoryCreateDialog').open;
    let saved=false;
    try {
      const result=await work();
      if (!result) return;
      saved=true;message(result);
      if (inventoryId) await readInventory(inventoryId,true);
      await loadList();
      if (after) await after();
    } catch(error) {
      const uncertain = !saved && /fetch|network|timeout/i.test(error.message || '');
      message(saved ? 'Registro confirmado; atualização pendente. Não repita a ação. Atualize o inventário.' : uncertain ? 'Não foi possível confirmar o resultado. Atualize o inventário antes de repetir a ação.' : error.message,true);
      if (el('inventoryCreateDialog').open) el('inventoryCreateMessage').textContent = saved ? 'Registro confirmado. Atualize a lista antes de tentar novamente.' : error.message;
      // Uma recusa por versão/movimento precisa revelar o estado atual, sem repetir a escrita.
      if (!saved && inventoryId && navigator.onLine) {
        try { await readInventory(inventoryId,true); } catch { /* mantém a mensagem original e dados anteriores */ }
      }
    } finally {pending=false;button.textContent=label;button.disabled=false;createCancel.disabled=false;sync();}
  }
  function applyFilters(){lotPage=0;renderItems();}
  el('inventorySearch').addEventListener('input',applyFilters);
  for(const field of ['inventoryFilter','inventoryLocation','inventoryFridge','inventoryPosition']) {
    el(field).addEventListener('change',applyFilters);
  }
  el('inventoryLotPrevious').addEventListener('click',()=>{lotPage--;renderItems();});
  el('inventoryLotNext').addEventListener('click',()=>{lotPage++;renderItems();});
  el('inventoryReviewCheck').addEventListener('change',()=>{reviewApproved=el('inventoryReviewCheck').checked;sync();});
  el('inventoryNextItem').addEventListener('click',()=>{if(data)focusNext('');});
  const openCreate=spatial=>{
    createSpatial=spatial;
    el('inventoryCreateTitle').textContent=spatial?'Novo inventário por posição':'Novo inventário físico';
    el('inventoryCreateMessage').textContent='';el('inventoryCreateDialog').showModal();
  };
  el('newInventory').addEventListener('click',()=>openCreate(false));
  el('newSpatialInventory').addEventListener('click',()=>openCreate(true));
  el('inventoryCreateDialog').addEventListener('cancel',event=>{if(pending)event.preventDefault();});
  el('inventoryCreateForm').addEventListener('submit',event=>{
    event.preventDefault();if (!event.currentTarget.reportValidity() || getContext().shop?.role!=='owner') return;
    const observation=el('inventoryObservation').value.trim();
    let createdId;
    void action(el('inventoryCreateSubmit'),async()=>{
      createdId=await rpc(createSpatial?'guigs_create_spatial_inventory':'guigs_create_inventory',{p_observation:observation});
      if(createSpatial)spatialIds.add(createdId);
      el('inventoryCreateDialog').close();page=0;
      return 'Inventário criado com snapshot. Nenhum saldo foi alterado.';
    },null,()=>readInventory(createdId,true));
  });
  const setStatus=async status=>{
    if (!data || getContext().shop?.role!=='owner') return;
    const current=data.inventory;
    const button=el({review:'inventoryReview',open:'inventoryReopen',cancelled:'inventoryCancel'}[status]);
    void action(button,async()=>{
      if (status==='cancelled' && !await confirmAction('Cancelar inventário','O registro e as contagens serão preservados. Nenhum saldo será alterado.')) return;
      await rpc('guigs_set_inventory_status',{p_inventory_id:current.id,p_status:status,p_version:current.version});
      return status==='cancelled'?'Inventário cancelado sem alterar estoque.':status==='review'?'Revisão aberta. Confira cada divergência e as movimentações.':'Inventário reaberto para contagem.';
    },current.id);
  };
  el('inventoryReview').addEventListener('click',()=>void setStatus('review'));
  el('inventoryReopen').addEventListener('click',()=>void setStatus('open'));
  el('inventoryCancel').addEventListener('click',()=>void setStatus('cancelled'));
  el('inventoryScope').addEventListener('click',()=>{
    if (!data || getContext().shop?.role!=='owner') return;
    const current=data.inventory;
    void action(el('inventoryScope'),async()=>{
      if (!await confirmAction('Incluir novos lotes','Serão capturados os dois locais dos novos lotes. Eles precisarão de contagem física. Os itens anteriores serão preservados.')) return;
      await rpc('guigs_refresh_inventory_scope',{p_inventory_id:current.id,p_version:current.version});
      return 'Novos lotes incluídos para contagem; estoque não alterado.';
    },current.id);
  });
  el('inventoryComplete').addEventListener('click',()=>{
    if (!data || !reviewApproved || getContext().shop?.role!=='owner') return;
    const current=data.inventory;
    const differences=data.items.filter(item=>['positive','negative'].includes(stateOf(item)));
    void action(el('inventoryComplete'),async()=>{
      if (!await confirmAction('Fechar inventário e aplicar ajustes',`Inventário #${current.id.slice(0,8)} · ${data.items.length} itens · ${differences.length} ajuste(s). A lista completa de divergências está na revisão. Os ajustes serão registrados no histórico; este fechamento é definitivo.`)) return;
      const args={p_inventory_id:current.id,p_version:current.version,p_confirm:true};
      if(current.spatial){
        const key=current.id+':'+current.version;
        if(!closeKeys.has(key))closeKeys.set(key,crypto.randomUUID());
        args.p_request_id=closeKeys.get(key);
      }
      const result=await rpc('guigs_complete_inventory',args);
      return `Inventário concluído: ${result.adjustments} ajuste(s) registrados no histórico.`;
    },current.id,refreshStock);
  });
  async function reload() {
    if (pending) return;
    try {await loadList();if(data)await readInventory(data.inventory.id,true);} catch(error){message(error.message,true);}sync();
  }
  el('inventoryResume').addEventListener('click',async()=>{
    if(!activeInventory||pending)return;
    const opened=navigator.onLine?await readInventory(activeInventory.id):data?.inventory.id===activeInventory.id;
    if(opened){
      el('inventoryDetailTitle').focus();
    }
  });
  el('inventoryReload').addEventListener('click',()=>void reload());
  el('inventoryPrevious').addEventListener('click',()=>{page--;void reload();});
  el('inventoryNext').addEventListener('click',()=>{page++;void reload();});
  window.addEventListener('offline',sync);
  window.addEventListener('online',()=>{sync();if(location.hash==='#inventario')void reload();});
  return {activate(){sync();if(getContext().shop && navigator.onLine && (!loaded || location.hash==='#inventario'))void reload();}};
}
