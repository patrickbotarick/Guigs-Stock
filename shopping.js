import { IMAGE_BUCKET } from './image-library.js';

const PAGE_SIZE=30;
const STATUS={draft:'Rascunho',pending:'Pendente',ordered:'Pedido realizado',received:'Recebido',cancelled:'Cancelado'};
const EVENT={created:'Lista criada',items_updated:'Itens ou observações atualizados',pending:'Lista preparada',
  ordered:'Pedido realizado',received:'Recebimento administrativo',cancelled:'Lista cancelada'};
const date=value=>new Date(value).toLocaleDateString('pt-BR');
const display=value=>value??'Não configurado';
const adjustment=(quantity,suggestion)=>{
  if(quantity===''||suggestion==null)return '';
  const delta=Number(quantity)-Number(suggestion);
  return delta?' · Ajuste: '+(delta>0?'+':'')+delta+' un.':'';
};
const searchText=value=>value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{Diacritic}/gu,'');
const csvCell=value=>{
  const text=String(value??'');
  return '"'+(/^[\s]*[=+@-]|^[\t\r\n]/.test(text)?"'"+text:text).replaceAll('"','""')+'"';
};

export function purchaseShare(order, items, shopName) {
  return [
    shopName, 'Lista de compras · '+date(order.created_at),
    ...items.map(item=>'- '+item.product_name+' · '+item.quantity+' un.'+
      (item.supplier_name?' · '+item.supplier_name:'')+(item.note?' · '+item.note:'')),
    ...(order.note?['Observação da lista: '+order.note]:[])
  ].join('\n');
}

export function purchaseCsv(order, items, shopName) {
  const rows=[['Pizzaria','Data','Produto','Sugestão original','Quantidade solicitada','Origem','Fornecedor','Observação do item','Observação da lista'],
    ...items.map(item=>[shopName,date(order.created_at),item.product_name,item.original_suggestion,item.quantity,
      item.source==='manual'?'Manual':'Sugestão',item.supplier_name,item.note,order.note])];
  return '\ufeff'+rows.map(row=>row.map(csvCell).join(';')).join('\r\n');
}

export function createShoppingUI({getContext,confirmAction,openReceipt}) {
  const el=id=>document.getElementById(id);
  const node=(tag,text,className)=>{
    const result=document.createElement(tag);
    if(text!=null)result.textContent=text;
    if(className)result.className=className;
    return result;
  };
  const button=(text,click,write=false)=>{
    const result=node('button',text,'btn');
    result.type='button';
    if(write)result.dataset.shoppingWrite='true';
    result.addEventListener('click',click);
    return result;
  };
  let board=null, detail=null, draft=null, limits=null, page=0, busy=false, confirming=false, generation=0, boardTicket=0, detailTicket=0;
  const retries=new Map(), photos=new Map();
  const owner=()=>getContext().shop?.role==='owner';
  const editable=order=>order.status==='draft'&&(owner()||order.created_by===getContext().shop?.user_id);
  const message=(text,error=false)=>{
    const target=el('shoppingMessage');
    target.textContent=text;
    target.className='notice '+(text?(error?'danger':'good'):'hidden');
  };

  async function rpc(name,args={}) {
    const {client,shop}=getContext();
    if(!navigator.onLine)throw Error('Sem internet. Nenhuma alteração foi enviada.');
    if(!client||!shop)throw Error('Aguarde a autenticação.');
    const response=await client.rpc(name,{p_shop_id:shop.shop_id,...args});
    if(response.error){
      if(response.error.code==='PGRST202')throw Error('Lista de Compras indisponível neste ambiente.');
      throw Error(response.error.message||'Não foi possível acessar a lista.');
    }
    return response.data;
  }

  function sync() {
    const disabled=busy||confirming||!navigator.onLine;
    document.querySelectorAll('[data-shopping-write]').forEach(control=>{control.disabled=disabled;});
    el('shoppingDraftForm').querySelectorAll('input,select,textarea').forEach(control=>{control.disabled=disabled||control.dataset.fixed==='true';});
    el('shoppingReload').disabled=disabled;
    el('shoppingPrevious').disabled=disabled||page===0;
    el('shoppingNext').disabled=disabled||!board||(page+1)*PAGE_SIZE>=board.order_counts.total;
    el('shoppingOffline').classList.toggle('hidden',navigator.onLine);
  }

  async function updatePhotos(targets) {
    const {client,shop}=getContext();
    if(!client?.storage||!client.supabaseUrl||!targets.length||!navigator.onLine)return;
    try{
      const origin=new URL(client.supabaseUrl).origin;
      const missing=[...new Set(targets.map(t=>t.path))].filter(path=>!(photos.get(path)?.expires>Date.now()));
      if(missing.length){
        const result=await client.storage.from(IMAGE_BUCKET).createSignedUrls(missing,300);
        if(getContext().shop?.shop_id!==shop?.shop_id)return;
        for(const row of result.data||[]){
          if(!row.signedUrl||!missing.includes(row.path))continue;
          const url=new URL(row.signedUrl);
          if(url.origin===origin&&url.pathname.startsWith('/storage/v1/object/sign/'+IMAGE_BUCKET+'/')){
            photos.set(row.path,{url:url.href,expires:Date.now()+270000});
          }
        }
      }
      for(const {photo,path} of targets){
        const cached=photos.get(path);
        if(!photo.isConnected||!(cached?.expires>Date.now()))continue;
        const image=node('img');image.src=cached.url;image.alt='';image.loading='lazy';
        image.addEventListener('error',()=>{photos.delete(path);photo.textContent='▧';},{once:true});
        photo.replaceChildren(image);
      }
    }catch{/* A foto é auxiliar. */}
  }

  function renderNeeds() {
    if(!board)return;
    const query=searchText(el('shoppingSearch').value.trim()), filter=el('shoppingFilter').value;
    el('shoppingFilterBadge').textContent=filter==='all'?'':el('shoppingFilter').selectedOptions[0].textContent;
    const shown=board.needs.filter(item=>searchText(item.product_name).includes(query)&&
      (filter==='all'||(filter==='need'&&item.suggested>0)||(filter==='unconfigured'&&item.base_suggested==null)||
      (filter==='expiry'&&(item.near_expiry>0||item.expired>0))));
    const list=el('shoppingNeeds'), targets=[];
    list.replaceChildren();
    for(const item of shown){
      const card=node('article',null,'shopping-card');card.dataset.productId=item.product_id;
      const header=node('header'), photo=node('span','▧','shopping-photo');photo.setAttribute('aria-hidden','true');
      header.append(photo,node('h3',item.product_name));
      if(item.image_path)targets.push({photo,path:item.image_path});
      const statuses=[item.base_suggested==null?'Configuração pendente':item.base_suggested>0?'Reposição necessária':'Estoque adequado'];
      if(item.on_order>0)statuses.push('Pedido em andamento');
      if(item.near_expiry>0||item.expired>0)statuses.push('Atenção à validade');
      card.append(header,node('div'));
      card.lastElementChild.append(...statuses.map(text=>node('span',text,'shopping-state')));
      card.append(node('p',`Disponível: ${item.available} un. · Seco: ${item.dry} · Geladeira: ${Number(item.unallocated)+Number(item.slots)} (${item.unallocated} não alocadas + ${item.slots} em blocos)`),
        node('p',`Mínimo: ${display(item.min_total)} · Meta: ${display(item.target_total)}`),
        node('p',`Necessidade: ${display(item.base_suggested)} · Em pedido: ${item.on_order} · Sugestão adicional: ${display(item.suggested)}`),
        node('p',`Vencidas: ${item.expired} · Vencem em até 30 dias: ${item.near_expiry}`,'muted'),
        node('p','Fornecedor a escolher no rascunho.','muted'));
      const actions=node('div',null,'shopping-actions');
      actions.append(button(item.suggested>0?'Adicionar sugestão':'Adicionar manualmente',()=>addItem(item,item.suggested>0?'suggestion':'manual'),true));
      if(owner())actions.append(button('Editar mínimo e meta',()=>openLimits(item),true));
      card.append(actions);list.append(card);
    }
    if(!shown.length)list.textContent='Nenhum produto para estes filtros.';
    void updatePhotos(targets);sync();
  }

  function renderBoard() {
    const counts=board.order_counts;
    el('shoppingMetrics').replaceChildren(...[
      ['Produtos para comprar',board.needs.filter(item=>item.suggested>0).length],
      ['Produtos sem configuração',board.needs.filter(item=>item.base_suggested==null).length],
      ['Listas em andamento',counts.in_progress],['Aguardando recebimento',counts.awaiting]
    ].map(([label,value])=>{const row=node('p');row.append(node('strong',value),document.createTextNode(label));return row;}));
    const orders=el('shoppingOrders');
    orders.replaceChildren();
    for(const order of board.orders){
      const card=node('article',null,'shopping-card');card.dataset.orderId=order.id;
      card.append(node('h3',STATUS[order.status]),node('p',date(order.created_at)+(order.note?' · '+order.note:'')),
        button('Abrir lista',()=>void changeDetail(()=>openOrder(order.id))));
      orders.append(card);
    }
    if(!board.orders.length)orders.textContent='Nenhuma lista nesta página.';
    el('shoppingPage').textContent='Página '+(page+1)+' · '+counts.total+' lista(s)';
    renderNeeds();
  }

  async function loadBoard() {
    const ticket=++boardTicket;
    const result=await rpc('guigs_get_shopping_board',{p_limit:PAGE_SIZE,p_offset:page*PAGE_SIZE});
    if(ticket!==boardTicket)return;
    board=result;renderBoard();
  }

  function refresh() {
    sync();
    if(navigator.onLine&&getContext().shop)void loadBoard().catch(error=>message(error.message,true));
  }

  function showDetail() {
    el('shoppingDetail').classList.remove('hidden');
    el('shoppingDetailTitle').focus();
  }

  function newDraft() {
    detailTicket++;detail=null;draft={items:[],note:''};
    renderDetail();showDetail();
  }

  function draftHasChanges() {
    if(!draft)return false;
    if(!detail)return Boolean(draft.note||draft.items.length);
    return draft.note!==detail.order.note||draft.items.length!==detail.items.length||
      draft.items.some(row=>!detail.items.some(saved=>saved.product_id===row.product_id&&saved.quantity===Number(row.quantity)&&
        saved.source===row.source&&saved.note===row.note&&saved.supplier_id===row.supplier_id));
  }

  async function changeDetail(work) {
    if(busy||confirming)return;
    if(draftHasChanges()){
      confirming=true;sync();
      let discard;
      try{discard=await confirmAction('Descartar edições do rascunho','As alterações que ainda não foram salvas serão descartadas.');}
      finally{confirming=false;sync();}
      if(!discard)return;
    }
    await work();
  }

  function addItem(item,source) {
    if(busy||!navigator.onLine)return;
    if(!draft)newDraft();
    if(draft.items.some(row=>row.product_id===item.product_id)){
      message('O produto já está no rascunho.',true);return;
    }
    draft.items.push({product_id:item.product_id,product_name:item.product_name,
      quantity:source==='manual'?'':item.suggested,original_suggestion:item.suggested,
      expected_suggestion:item.suggested,supplier_id:null,source,note:''});
    renderDraft();showDetail();
  }

  function renderDraft() {
    const products=el('shoppingManualProduct'), selected=products.value;
    products.replaceChildren(new Option('Selecione um produto',''),...(board?.needs||[])
      .filter(item=>!draft.items.some(line=>line.product_id===item.product_id))
      .map(item=>new Option(item.product_name,item.product_id)));
    if([...products.options].some(option=>option.value===selected))products.value=selected;
    const list=el('shoppingDraftItems');list.replaceChildren();
    for(const [index,item] of draft.items.entries()){
      const row=node('section',null,'shopping-card shopping-line');row.dataset.lineProduct=item.product_id;
      const summary=node('p');
      const summarize=()=>{summary.textContent='Sugestão original: '+display(item.original_suggestion)+adjustment(item.quantity,item.original_suggestion);};
      summarize();
      row.append(node('h4',item.product_name),summary);
      const quantity=node('input');quantity.type='number';quantity.min='1';quantity.max='2147483647';quantity.step='1';quantity.required=true;
      quantity.inputMode='numeric';quantity.value=item.quantity;
      quantity.addEventListener('input',()=>{item.quantity=quantity.value;summarize();});
      const supplier=node('select');
      const options=(board?.suppliers||[]).map(s=>new Option(s.name,s.id));
      if(item.supplier_id&&!options.some(option=>option.value===item.supplier_id))options.push(new Option(item.supplier_name||'Fornecedor anterior',item.supplier_id));
      supplier.append(new Option('Sem fornecedor',''),...options);supplier.value=item.supplier_id||'';
      supplier.addEventListener('change',()=>{item.supplier_id=supplier.value||null;});
      const note=node('input');note.type='text';note.maxLength=1000;note.value=item.note;
      note.addEventListener('input',()=>{item.note=note.value;});
      const manual=node('input');manual.type='checkbox';manual.checked=item.source==='manual';
      manual.dataset.fixed=String(item.original_suggestion==null||item.original_suggestion<=0);
      manual.addEventListener('change',()=>{item.source=manual.checked?'manual':'suggestion';});
      const fields=node('div',null,'shopping-filters');
      for(const [text,input] of [['Quantidade solicitada',quantity],['Fornecedor',supplier],['Observação do item',note]]){
        input.setAttribute('aria-label',text);
        const label=node('label',text,'field');label.append(input);fields.append(label);
      }
      const mode=node('label');mode.append(manual,document.createTextNode(' Item manual'));
      row.append(fields,mode,button('Remover item',()=>{draft.items.splice(index,1);renderDraft();},true));
      list.append(row);
    }
    if(!draft.items.length)list.textContent='Adicione uma sugestão ou selecione um produto manualmente.';
    sync();
  }

  function renderSaved() {
    const list=el('shoppingSavedItems');list.replaceChildren();
    const suppliers=new Map();
    for(const item of detail.items){
      const key=item.supplier_id||'none';
      if(!suppliers.has(key)){
        const group=node('section',null,'shopping-card');
        group.append(node('h3',item.supplier_name||'Sem fornecedor'));suppliers.set(key,group);list.append(group);
      }
      suppliers.get(key).append(node('p',item.product_name+' · '+item.quantity+' un. · Sugestão original: '+
        display(item.original_suggestion)+adjustment(item.quantity,item.original_suggestion)+
        (item.source==='manual'?' · Manual':'')+(item.note?' · '+item.note:'')));
    }
  }

  function eventSummary(state) {
    if(!state)return '—';
    return STATUS[state.order.status]+(state.order.note?' · '+state.order.note:'')+' · '+
      state.items.map(item=>item.product_name+' × '+item.quantity+' ('+(item.supplier_name||'sem fornecedor')+
        (item.note?', '+item.note:'')+')').join('; ');
  }

  function renderDetail() {
    const order=detail?.order;
    el('shoppingDetailTitle').textContent=order?'Lista · '+STATUS[order.status]:'Novo rascunho';
    el('shoppingDetailInfo').textContent=order ? date(order.created_at)+(order.created_by_label?' · '+order.created_by_label:'')+
      (!draft&&order.note?' · '+order.note:'') : 'Rascunho ainda não salvo.';
    el('shoppingDraftForm').classList.toggle('hidden',!draft);
    el('shoppingSavedItems').classList.toggle('hidden',!!draft);
    const actions=el('shoppingOrderActions'), history=el('shoppingEvents');actions.replaceChildren();history.replaceChildren();
    el('shoppingHistory').classList.toggle('hidden',!detail?.events.length);
    if(draft){el('shoppingNote').value=draft.note;renderDraft();}
    if(order){
      if(!draft)renderSaved();
      if(detail.items.length)actions.append(button('Revisar texto e exportar',openShare));
      if(editable(order))actions.append(button('Preparar pedido',()=>void transition('pending','Preparar pedido','Salve as edições do rascunho antes de preparar a compra.'),true));
      if(owner()&&order.status==='pending')actions.append(button('Marcar pedido realizado',()=>void transition('ordered','Pedido realizado','Confirma que a solicitação já foi enviada ao fornecedor?'),true));
      if(owner()&&order.status==='ordered')actions.append(button('Marcar recebido',()=>void transition('received','Recebimento administrativo','Este status acompanha a compra. A entrada física é registrada no recebimento de estoque.'),true));
      if((owner()&&['draft','pending','ordered'].includes(order.status))||editable(order))actions.append(button('Cancelar lista',()=>void transition('cancelled','Cancelar lista','A lista e seu histórico ficarão disponíveis para consulta.'),true));
      if(order.status==='received')actions.append(button('Abrir recebimento físico',openReceipt,true));
      for(const event of detail.events){
        const record=node('details');
        record.append(node('summary',EVENT[event.action]+' · '+new Date(event.created_at).toLocaleString('pt-BR')+
          (event.actor_label?' · '+event.actor_label:'')),node('p','Antes: '+eventSummary(event.previous)),
          node('p','Depois: '+eventSummary(event.current)));
        history.append(record);
      }
    }
    sync();
  }

  async function openOrder(id,focus=true) {
    const ticket=++detailTicket;
    try{
      const result=await rpc('guigs_get_purchase_order',{p_order_id:id});
      if(ticket!==detailTicket)return;
      detail=result;
      draft=editable(result.order)?{note:result.order.note,items:result.items.map(item=>({...item,expected_suggestion:item.original_suggestion}))}:null;
      renderDetail();
      if(focus)showDetail();
    }catch(error){if(focus)message(error.message,true);else throw error;}
  }

  async function write(action,payload) {
    const signature=JSON.stringify([action,payload]);
    const requestId=retries.get(signature)||crypto.randomUUID();
    try{
      const result=await rpc('guigs_apply_shopping_command',{p_request_id:requestId,p_action:action,p_payload:payload});
      retries.delete(signature);return result;
    }catch(error){
      if(/network|fetch|timeout|connection/i.test(error.message)){
        retries.set(signature,requestId);
        throw Error('Resultado incerto. Atualize a lista ou repita a mesma ação para conferir.');
      }
      retries.delete(signature);throw error;
    }
  }

  async function save(action,payload,text) {
    if(busy||!navigator.onLine)return;
    const session=generation;
    busy=true;sync();message('');
    try{
      const result=await write(action,payload);
      if(session!==generation)return;
      if(action==='limits'){
        el('shoppingLimitsDialog').close();
        limits=null;
      }else{
        detail={order:result,items:detail?.items||[],events:detail?.events||[]};
        if(!editable(result))draft=null;
      }
      message(text);
      try{
        await loadBoard();
        if(action!=='limits')await openOrder(result.id,false);
      }catch{
        if(session!==generation)return;
        if(action!=='limits')renderDetail();
        message(text+' Atualize para conferir os dados registrados.');
      }
    }catch(error){
      if(session!==generation)return;
      if(action==='limits')el('shoppingLimitsMessage').textContent=error.message;
      else message(error.message,true);
    }finally{if(session===generation){busy=false;sync();}}
  }

  async function transition(status,title,text) {
    if(busy||confirming||!detail?.order||!navigator.onLine)return;
    const {id,version}=detail.order;
    if(status==='pending'&&draftHasChanges()){message('Salve as edições antes de preparar o pedido.',true);return;}
    confirming=true;sync();
    let confirmed;
    try{confirmed=await confirmAction(title,text);}finally{confirming=false;sync();}
    if(!confirmed)return;
    if(detail?.order.id===id)await save('status',{order_id:id,version,status},title+'.');
  }

  function openLimits(item) {
    limits=item;
    el('shoppingLimitsTitle').textContent='Parâmetros de compra · '+item.product_name;
    el('shoppingMinimum').value=item.min_total??'';
    el('shoppingTarget').value=item.target_total??'';
    el('shoppingLimitsMessage').textContent='';
    el('shoppingLimitsDialog').showModal();
  }

  function selectedShareItems() {
    const supplier=el('shoppingShareSupplier').value;
    return detail.items.filter(item=>supplier===''||(item.supplier_id||'none')===supplier);
  }

  function renderShare() {
    const text=purchaseShare(detail.order,selectedShareItems(),board.shop_name);
    el('shoppingShareText').value=text;
    el('shoppingWhatsApp').href='https://wa.me/?text='+encodeURIComponent(text);
    el('shoppingShareMessage').textContent='';
  }

  function openShare() {
    if(!detail?.items.length||!board)return;
    const suppliers=new Map(detail.items.map(item=>[item.supplier_id||'none',item.supplier_name||'Sem fornecedor']));
    el('shoppingShareSupplier').replaceChildren(new Option('Todos os itens',''),...[...suppliers].map(([id,name])=>new Option(name,id)));
    renderShare();el('shoppingShareDialog').showModal();
  }

  el('shoppingReload').addEventListener('click',()=>{
    refresh();
    if(detail?.order.id)void changeDetail(()=>openOrder(detail.order.id,false)).catch(error=>message(error.message,true));
  });
  el('shoppingSearch').addEventListener('input',renderNeeds);
  el('shoppingFilter').addEventListener('change',renderNeeds);
  el('shoppingPrevious').addEventListener('click',()=>{page--;refresh();});
  el('shoppingNext').addEventListener('click',()=>{page++;refresh();});
  el('shoppingNew').addEventListener('click',()=>void changeDetail(newDraft));
  el('shoppingClose').addEventListener('click',()=>void changeDetail(()=>{
    detailTicket++;draft=null;detail=null;el('shoppingDetail').classList.add('hidden');
  }));
  el('shoppingNote').addEventListener('input',()=>{if(draft)draft.note=el('shoppingNote').value;});
  el('shoppingAddManual').addEventListener('click',()=>{
    const item=board?.needs.find(row=>row.product_id===el('shoppingManualProduct').value);
    if(item)addItem(item,'manual');
  });
  el('shoppingDraftForm').addEventListener('submit',event=>{
    event.preventDefault();
    if(!draft||!event.currentTarget.reportValidity())return;
    const items=draft.items.map(item=>({product_id:item.product_id,quantity:Number(item.quantity),supplier_id:item.supplier_id,
      source:item.source,expected_suggestion:item.expected_suggestion,note:item.note}));
    void save('save',{order_id:detail?.order.id??null,version:detail?.order.version??null,note:draft.note,items},'Rascunho salvo.');
  });
  el('shoppingLimitsForm').addEventListener('submit',event=>{
    event.preventDefault();
    if(!limits||!event.currentTarget.reportValidity()||!owner())return;
    const read=id=>el(id).value===''?null:Number(el(id).value);
    const minimum=read('shoppingMinimum'),target=read('shoppingTarget');
    if(minimum!=null&&target!=null&&target<minimum){el('shoppingLimitsMessage').textContent='A meta precisa ser maior ou igual ao mínimo.';return;}
    void save('limits',{product_id:limits.product_id,min_total:minimum,target_total:target,
      expected:{min_total:limits.min_total,target_total:limits.target_total}},'Parâmetros salvos.');
  });
  el('shoppingShareSupplier').addEventListener('change',renderShare);
  el('shoppingCopy').addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText(el('shoppingShareText').value);el('shoppingShareMessage').textContent='Texto copiado.';}
    catch{el('shoppingShareText').select();el('shoppingShareMessage').textContent='Texto selecionado. Use o comando de copiar do dispositivo.';}
  });
  el('shoppingCsv').addEventListener('click',()=>{
    const file=new Blob([purchaseCsv(detail.order,selectedShareItems(),board.shop_name)],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(file), link=node('a');link.href=url;link.download='lista-de-compras.csv';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  window.addEventListener('offline',sync);
  window.addEventListener('online',()=>{if(location.hash==='#compras')refresh();});

  return {activate:refresh,reset(){
    generation++;boardTicket++;detailTicket++;board=null;detail=null;draft=null;limits=null;page=0;busy=false;confirming=false;
    retries.clear();photos.clear();el('shoppingDetail').classList.add('hidden');
    for(const id of ['shoppingNeeds','shoppingOrders','shoppingMetrics','shoppingSavedItems','shoppingEvents','shoppingDraftItems'])el(id).replaceChildren();
    el('shoppingShareText').value='';el('shoppingShareDialog').close();el('shoppingLimitsDialog').close();message('');
  }};
}
