const HISTORY_PAGE_SIZE=12;
const HISTORY_LABELS={receipt:'Entrada',sale:'Venda',loss:'Perda',return:'Retorno ao seco',transfer:'Transferência',
  adjust:'Ajuste',inventory:'Inventário',replenish:'Reposição',relocate:'Distribuição',slot_move:'Reorganização'};
const shortDate=value=>value.split('-').reverse().join('/');
const messageOf=error=>error?.message||'Não foi possível concluir a solicitação.';
const uncertain=error=>/network|fetch|timeout|connection|conexão|sem confirmação/i.test(messageOf(error));
const conflict=error=>/lock on relation|lock timeout/i.test(messageOf(error));

export function createFridgeMovesUI({getContext,getMap,openDetail,refreshMap,notify}) {
  const el=id=>document.getElementById(id);
  const node=(tag,text)=>{const element=document.createElement(tag);if(text!=null)element.textContent=text;return element;};
  const history=el('fridgeSlotHistory'), dialog=el('fridgeMoveDialog');
  let historySlot=null, cursor=null, historyLoaded=false, historyBusy=false, historyTicket=0;
  let source=null, quote=null, retry=null, moving=false, generation=0, mapLocked=false, returnToSource=true;
  const fieldIds=['fridgeMoveMode','fridgeMoveLot','fridgeMoveQuantity','fridgeMoveFridge','fridgeMoveShelf','fridgeMoveDestination'];
  const formMessage=text=>{el('fridgeMoveMessage').textContent=text;};

  async function rpc(name,args) {
    const {client,shop}=getContext();
    if(!client||!shop||!navigator.onLine)throw Error('Sem conexão. Aguarde para continuar.');
    const result=await client.rpc(name,{p_shop_id:shop.shop_id,...args});
    if(result.error)throw result.error;
    return result.data;
  }

  function resetHistory(slot) {
    historyTicket++;historySlot=slot;historyLoaded=false;historyBusy=false;cursor=null;
    history.open=false;el('fridgeSlotHistoryEntries').replaceChildren();
    el('fridgeSlotHistoryMessage').textContent='';el('fridgeSlotHistoryMore').classList.add('hidden');
  }

  function appendHistory(event) {
    const entry=node('article');entry.className='fridge-history-entry';entry.dataset.eventId=event.event_id;
    const local=event.parts.filter(part=>part.in_block).reduce((sum,part)=>sum+Number(part.delta),0);
    entry.append(node('strong',(HISTORY_LABELS[event.kind]||'Movimentação')+' · '+(local>0?'+':'')+local+' un. no bloco'),
      node('p',new Date(event.created_at).toLocaleString('pt-BR')+(event.operator?' · '+event.operator:'')));
    const parts=node('ul');
    for(const part of event.parts){
      parts.append(node('li',(part.delta>0?'Entrada em ':'Saída de ')+part.label+' · '+part.product_name+
        ' · Lote '+part.lot_code+' · '+Math.abs(part.delta)+' un. · Validade '+shortDate(part.expiry)));
    }
    entry.append(parts);el('fridgeSlotHistoryEntries').append(entry);
  }

  async function loadHistory() {
    if(!historySlot||historyBusy)return;
    const message=el('fridgeSlotHistoryMessage'),more=el('fridgeSlotHistoryMore');
    if(!navigator.onLine){message.textContent='Sem conexão para consultar o histórico.';return;}
    const ticket=++historyTicket;
    historyBusy=true;more.disabled=true;message.textContent='Carregando histórico…';
    try{
      const data=await rpc('guigs_get_fridge_slot_history',{
        p_slot_id:historySlot,p_limit:HISTORY_PAGE_SIZE,p_before_at:cursor?.created_at??null,p_before_event:cursor?.event_id??null
      });
      if(ticket!==historyTicket)return;
      for(const event of data.events)appendHistory(event);
      historyLoaded=true;
      cursor=data.events.at(-1)||cursor;
      more.textContent='Carregar mais';more.classList.toggle('hidden',!data.has_more);
      message.textContent=cursor?'':'Nenhuma movimentação neste bloco.';
    }catch(error){
      if(ticket!==historyTicket)return;
      message.textContent=messageOf(error);
      more.textContent='Tentar novamente';more.classList.remove('hidden');
    }finally{if(ticket===historyTicket){historyBusy=false;more.disabled=!navigator.onLine;}}
  }

  function choices(select,placeholder,rows,selected=select.value) {
    select.replaceChildren(new Option(placeholder,''),...rows.map(row=>{
      const option=new Option(row.label,row.id);option.disabled=Boolean(row.disabled);return option;
    }));
    if(rows.some(row=>row.id===selected&&!row.disabled))select.value=selected;
  }

  function sourceLabel(slot,map) {
    return [map.fridges.find(f=>f.id===slot.fridge_id)?.name,
      map.shelves.find(h=>h.id===slot.shelf_id)?.name,slot.name].filter(Boolean).join(' / ');
  }

  function spec() {
    const single=el('fridgeMoveMode').value==='lot';
    return {p_source:source.id,p_destination:el('fridgeMoveDestination').value,
      p_lot:single?el('fridgeMoveLot').value:null,p_quantity:single?Number(el('fridgeMoveQuantity').value):null};
  }

  function renderTargets() {
    const map=getMap();
    const single=el('fridgeMoveMode').value==='lot';
    el('fridgeMoveLotFields').classList.toggle('hidden',!single);
    const selection=spec(), selectedLot=source.lots.find(lot=>lot.lot_id===selection.p_lot);
    const lots=single?(selectedLot?[selectedLot]:[]):source.lots.filter(lot=>lot.quantity>0);
    const quantity=single?selection.p_quantity:lots.reduce((sum,lot)=>sum+Number(lot.quantity),0);
    const fridges=map.fridges.filter(f=>f.active);
    choices(el('fridgeMoveFridge'),'Selecione a geladeira',fridges.map(f=>({id:f.id,label:f.name})));
    const shelves=map.shelves.filter(h=>h.active&&h.fridge_id===el('fridgeMoveFridge').value);
    choices(el('fridgeMoveShelf'),'Selecione a prateleira',shelves.map(h=>({id:h.id,label:h.name})));
    const slots=map.slots.filter(slot=>slot.active&&slot.shelf_id===el('fridgeMoveShelf').value);
    choices(el('fridgeMoveDestination'),'Selecione o bloco',slots.map(slot=>{
      const available=slot.capacity_quantity==null?null:slot.capacity_quantity-Number(slot.quantity);
      const reason=slot.id===source.id?'Bloco de origem':!slot.product_id?'Produto pendente':
        lots.some(lot=>lot.product_id!==slot.product_id)?'Outro produto':available==null?'Capacidade pendente':
        available<quantity?'Espaço insuficiente':'';
      return {id:slot.id,label:slot.name+' · '+(available==null?'':available+' un. livres'+(reason?' · ':''))+reason,disabled:reason};
    }));
    sync(mapLocked);
  }

  function renderQuote() {
    const summary=el('fridgeMoveSummary');
    const expected=retry?.args.p_expected||quote?.expected;
    summary.replaceChildren();summary.classList.toggle('hidden',!expected);
    if(!expected)return;
    summary.append(node('strong',expected.product_name+' · '+expected.quantity+' un.'),
      node('p',expected.source+' → '+expected.destination),
      node('p','Espaço antes da movimentação: '+expected.space+' un.'));
    const operator=getContext().operator;
    if(operator)summary.append(node('p','Operador: '+operator));
    const lots=node('ul');
    for(const lot of expected.lots)lots.append(node('li','Lote '+lot.code+' · '+lot.quantity+' un. · Validade '+shortDate(lot.expiry)));
    summary.append(lots);
  }

  function sync(locked=false) {
    mapLocked=locked;
    const more=el('fridgeSlotHistoryMore');more.disabled=historyBusy||!navigator.onLine;
    if(!dialog.open||!source)return;
    const blocked=locked||moving||!navigator.onLine;
    const unresolved=Boolean(retry);
    const single=el('fridgeMoveMode').value==='lot';
    for(const id of fieldIds)el(id).disabled=blocked||unresolved||(!single&&['fridgeMoveLot','fridgeMoveQuantity'].includes(id));
    el('fridgeMoveQuote').disabled=blocked||unresolved||!el('fridgeMoveDestination').value||
      (single&&(!el('fridgeMoveLot').value||!el('fridgeMoveQuantity').value));
    el('fridgeMoveConfirm').disabled=blocked||(!quote&&!retry);
    el('fridgeMoveConfirm').textContent=retry?'Conferir resultado com a mesma chave':'Confirmar movimentação';
    el('fridgeMoveClose').disabled=moving;
  }

  function open(slot) {
    if(!slot||!getMap()||moving||!navigator.onLine)return;
    if(retry&&retry.args.p_source!==slot.id){
      notify('Há uma movimentação com resposta incerta. Volte ao bloco de origem e confira o histórico.');
      return;
    }
    source=slot;quote=null;returnToSource=true;
    el('fridgeMoveSource').textContent='Origem: '+sourceLabel(slot,getMap());
    const today=new Date().toISOString().slice(0,10);
    choices(el('fridgeMoveLot'),'Selecione o lote',slot.lots.filter(lot=>lot.quantity>0).map(lot=>({
      id:lot.lot_id,label:lot.code+' · '+lot.quantity+' un. · '+shortDate(lot.expiry)+(lot.expiry<today?' · Vencido':''),
      disabled:lot.expiry<today
    })),retry?.args.p_lot||'');
    el('fridgeMoveMode').value=retry&&retry.args.p_lot==null?'all':'lot';
    el('fridgeMoveQuantity').value=retry?.args.p_quantity??1;
    for(const id of ['fridgeMoveFridge','fridgeMoveShelf','fridgeMoveDestination'])el(id).value='';
    el('fridgeDetailDialog').close();
    dialog.showModal();renderTargets();renderQuote();
    formMessage(retry?'Resposta anterior incerta. Confira o histórico ou repita com a mesma chave.':'');
  }

  async function requestQuote() {
    if(!source||el('fridgeMoveQuote').disabled||!el('fridgeMoveForm').reportValidity())return;
    const stamp=generation,args=spec();moving=true;quote=null;renderQuote();formMessage('Conferindo saldos e capacidade…');sync(mapLocked);
    try{
      const expected=await rpc('guigs_quote_fridge_slot_move',args);
      if(stamp!==generation)return;
      quote={args,expected};renderQuote();formMessage('Confira o resumo antes de confirmar.');
    }catch(error){if(stamp===generation)formMessage(messageOf(error));}
    finally{if(stamp===generation){moving=false;sync(mapLocked);if(quote)el('fridgeMoveConfirm').focus();}}
  }

  async function applyMove() {
    if(el('fridgeMoveConfirm').disabled)return;
    const stamp=generation, pending=retry||{args:{...quote.args,p_expected:quote.expected,p_request_id:crypto.randomUUID()}};
    moving=true;sync(mapLocked);formMessage('Registrando movimentação…');
    try{
      const result=await rpc('guigs_apply_fridge_slot_move',pending.args);
      if(stamp!==generation)return;
      if(!result?.event_id)throw Error('Resposta sem confirmação do evento.');
      retry=null;quote=null;returnToSource=false;
      dialog.close();
      const refreshed=await refreshMap();
      if(stamp!==generation)return;
      const feedback=result.quantity+' un. movidas entre blocos.';
      if(refreshed)openDetail(pending.args.p_source,true,feedback);
      notify(feedback+(refreshed?'':' Atualize o mapa para conferir os saldos.'));
    }catch(error){
      if(stamp!==generation)return;
      const locked=conflict(error);
      if(!locked&&uncertain(error))retry=pending;
      else if(!locked){retry=null;quote=null;}
      renderQuote();
      formMessage(locked?'Há outra movimentação em andamento. Aguarde e tente novamente.':
        uncertain(error)?'Resultado incerto. Confira o histórico ou repita com a mesma chave.':messageOf(error));
    }finally{if(stamp===generation){moving=false;sync(mapLocked);}}
  }

  history.addEventListener('toggle',()=>{if(history.open&&!historyLoaded)void loadHistory();});
  el('fridgeSlotHistoryMore').addEventListener('click',()=>void loadHistory());
  for(const id of fieldIds)el(id).addEventListener(id==='fridgeMoveQuantity'?'input':'change',()=>{
    quote=null;renderTargets();renderQuote();formMessage('');
  });
  el('fridgeMoveForm').addEventListener('submit',event=>{event.preventDefault();void requestQuote();});
  el('fridgeMoveConfirm').addEventListener('click',()=>void applyMove());
  el('fridgeMoveClose').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('cancel',event=>{if(moving)event.preventDefault();});
  dialog.addEventListener('close',()=>{
    if(returnToSource&&source)openDetail(source.id,Boolean(retry));
  });
  window.addEventListener('online',()=>{sync(mapLocked);if(history.open&&!historyLoaded)void loadHistory();});

  return {open,sync,resetHistory,hasRetry:slotId=>retry?.args.p_source===slotId,
    dismiss(){returnToSource=false;dialog.close();resetHistory(null);},
    reset(){generation++;returnToSource=false;moving=false;source=null;quote=null;retry=null;dialog.close();resetHistory(null);}};
}
