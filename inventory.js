// Módulo carregado com o dashboard; RPCs de inventário só são consultadas nesta view.
export function createInventoryUI({getContext, enhanceSelect, confirmAction, refreshStock}) {
  const el = id => document.getElementById(id);
  const statusLabel = {open:'Aberto',review:'Em revisão',completed:'Concluído',cancelled:'Cancelado'};
  const localLabel = value => value === 'stock' ? 'Estoque seco' : 'Geladeira';
  const date = value => value ? new Date(value).toLocaleString('pt-BR') : '—';
  const actor = (value,label) => label || (value ? `Usuário ${value.slice(0,8)}` : '—');
  let data = null;
  let pending = false;
  let loading = 0;
  let detailLoading = 0;
  let page = 0;
  let total = 0;
  let loaded = false;
  let reviewApproved = false;
  const drafts = new Map(); // Somente memória da página; não salva contagem automaticamente.
  enhanceSelect('inventoryItemSelect');
  function message(text, error = false) {
    el('inventoryMessage').textContent = text;
    el('inventoryMessage').className = `notice ${error ? 'danger' : 'good'}`;
  }
  async function rpc(name, args = {}) {
    const {client, shop} = getContext();
    if (!navigator.onLine) throw Error('Sem internet: inventário somente para consulta dos dados já exibidos.');
    if (!client || !shop) throw Error('Aguarde a autenticação.');
    const result = await client.rpc(name, {p_shop_id:shop.shop_id,...args});
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
    const active = result.inventories.filter(inv => ['open','review'].includes(inv.status));
    el('inventoryOpenSummary').textContent = active.length ? `Em andamento: ${active.map(inv=>`#${inv.id.slice(0,8)} · ${statusLabel[inv.status]}`).join(', ')}` : 'Nenhum inventário em andamento nesta página.';
    el('inventoryLastCompleted').textContent = result.last_completed
      ? `Último concluído: ${date(result.last_completed.completed_at)} · ${actor(result.last_completed.completed_by,result.last_completed.completed_by_label)}` : 'Nenhum inventário concluído.';
    for (const inv of result.inventories) {
      const entry = document.createElement('article');
      entry.className = 'inventory-history-card';
      const info = document.createElement('p');
      info.textContent = `#${inv.id.slice(0,8)} · ${statusLabel[inv.status]} · Início: ${date(inv.started_at)} · ${actor(inv.started_by,inv.started_by_label)} · Itens: ${inv.item_count} · Conferidos: ${inv.counted_count} · Divergentes: ${inv.divergent_count} · Conclusão: ${date(inv.completed_at)}`;
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'btn'; open.textContent = 'Abrir inventário';
      open.dataset.inventoryOpen='true';
      open.addEventListener('click', () => void readInventory(inv.id));
      entry.append(info,open); list.append(entry);
    }
    if (!result.inventories.length) list.textContent = 'Nenhum inventário registrado.';
    el('inventoryPage').textContent = `Página ${page+1} · ${total} inventário(s)`;
    loaded = true;
    sync();
  }
  async function readInventory(id, propagate = false) {
    const ticket = ++detailLoading;
    try {
      const result = await rpc('guigs_get_inventory',{p_inventory_id:id});
      if (ticket !== detailLoading) return;
      if (data?.inventory.id !== result.inventory.id || data?.inventory.version !== result.inventory.version) reviewApproved = false;
      data = result;
      renderDetail();
    } catch (error) {
      if (propagate) throw error;
      message(error.message,true);
    }
    sync();
  }
  function stateOf(item) {
    if (item.counted_quantity === null) return 'pending';
    return Number(item.counted_quantity) === Number(item.basis_quantity) ? 'equal' : Number(item.counted_quantity) > Number(item.basis_quantity) ? 'positive' : 'negative';
  }
  function renderDetail() {
    const current = data.inventory;
    const items = data.items;
    el('inventoryDetail').classList.remove('hidden');
    el('inventoryDetailTitle').textContent = `Inventário #${current.id.slice(0,8)} · ${statusLabel[current.status]}`;
    el('inventoryDetailInfo').textContent = `Iniciado ${date(current.started_at)} · ${actor(current.started_by,current.started_by_label)} · ${current.observation || 'Sem observação'}`;
    const counted = items.filter(item => item.counted_quantity !== null).length;
    const different = items.filter(item => ['positive','negative'].includes(stateOf(item))).length;
    el('inventoryTotals').textContent = `Itens: ${items.length} · Conferidos: ${counted} · Pendentes: ${items.length-counted} · Sem divergência: ${counted-different} · Divergentes: ${different}`;
    const active = ['open','review'].includes(current.status);
    const conflicts = items.filter(item=>item.conflict).length;
    el('inventoryMovementWarning').classList.toggle('hidden', !active || !(data.movements_after_start || data.new_lots));
    el('inventoryMovementWarning').classList.toggle('danger', conflicts > 0 || data.new_lots > 0);
    el('inventoryMovementWarning').textContent = `${data.movements_after_start} movimentação(ões) após o início. Itens ainda exigindo recontagem: ${conflicts}. Lotes novos fora do escopo: ${data.new_lots}. ${conflicts ? 'Reconte os locais afetados.' : 'Os itens já reconferidos não estão bloqueados por esses movimentos.'} O fechamento verifica novamente no servidor.`;
    const selected = el('inventoryItemSelect').value;
    el('inventoryItemSelect').replaceChildren(new Option('Todos os produtos / lotes',''));
    for (const item of items) el('inventoryItemSelect').add(new Option(`${item.product_name} · ${item.lot_code} · ${localLabel(item.location)}`,item.id));
    el('inventoryItemSelect').value = items.some(item=>item.id===selected) ? selected : '';
    el('inventoryReviewCheck').checked = reviewApproved;
    el('inventoryReviewGate').classList.toggle('hidden', current.status !== 'review' || getContext().shop?.role !== 'owner');
    const differences = el('inventoryDifferences');
    differences.replaceChildren();
    if (current.status !== 'open') {
      for (const item of items.filter(item=>['positive','negative'].includes(stateOf(item)))) {
        const row=document.createElement('p');
        row.textContent=`${item.product_name} · ${item.lot_code} · ${localLabel(item.location)}: base ${item.basis_quantity} → contado ${item.counted_quantity} (${Number(item.counted_quantity)-Number(item.basis_quantity)>0?'+':''}${Number(item.counted_quantity)-Number(item.basis_quantity)})${item.conflict && active?' · MOVIMENTADO: RECONTAR':''}`;
        differences.append(row);
      }
      if (!differences.children.length) differences.textContent = 'Nenhuma divergência registrada.';
    }
    el('inventoryDifferencesPanel').classList.toggle('hidden',current.status==='open');
    const audit=el('inventoryAudit'); audit.replaceChildren();
    for (const entry of data.audit) {
      const row=document.createElement('p');
      const names={created:'Criação',counted:'Contagem',recount:'Recontagem preparada',scope_refreshed:'Escopo atualizado',review:'Revisão',reopened:'Reabertura',completed:'Fechamento',cancelled:'Cancelamento'};
      const item=items.find(item=>item.id===entry.item_id);
      row.textContent=`${date(entry.created_at)} · ${actor(entry.actor_id,entry.actor_label)} · ${names[entry.action] || entry.action}${item?` · ${item.product_name} / ${item.lot_code} / ${localLabel(item.location)}`:''}${entry.counted_quantity!==null?` · Contado: ${entry.counted_quantity}`:''}${entry.previous_quantity!==null?` · Contagem anterior: ${entry.previous_quantity}`:''}${entry.note?` · ${entry.note}`:''}`;
      audit.append(row);
    }
    renderItems(); sync();
  }
  function renderItems() {
    if (!data) return;
    const list=el('inventoryItems'); list.replaceChildren();
    const filter=el('inventoryFilter').value;
    const location=el('inventoryLocation').value;
    const selected=el('inventoryItemSelect').value;
    const current=data.inventory;
    const items=data.items.filter(item=>{
      const state=stateOf(item);
      return (!selected || item.id===selected) && (!location || item.location===location) &&
        (filter==='all' || (filter==='divergent' && ['positive','negative'].includes(state)) || (filter==='pending' && state==='pending') || (filter==='counted' && state!=='pending'));
    });
    for (const item of items) {
      const card=document.createElement('article');
      const state=stateOf(item);
      card.className=`inventory-item inventory-${state}`; card.dataset.itemId=item.id;
      const title=document.createElement('h3');title.textContent=`${item.product_name} · ${item.lot_code}`;
      const meta=document.createElement('p');meta.className='muted';meta.textContent=`${localLabel(item.location)} · Validade: ${item.expiry.split('-').reverse().join('/')} · Fornecedor: ${item.supplier_name || 'Não informado'}`;
      const info=document.createElement('p');
      const reveal=current.status!=='open' || item.counted_quantity!==null;
      info.textContent=reveal ? `Esperado inicial: ${item.expected_initial} · Base de conferência: ${item.basis_quantity} · Contado: ${item.counted_quantity ?? 'Não contado'} · Diferença: ${item.counted_quantity===null?'—':Number(item.counted_quantity)-Number(item.basis_quantity)}` : 'Contagem cega: saldo esperado oculto até registrar a quantidade.';
      const status=document.createElement('strong');
      status.textContent={pending:'Não contado',equal:'Sem divergência',positive:'Diferença positiva',negative:'Diferença negativa'}[state];
      card.append(title,meta,info,status);
      if (item.conflict && ['open','review'].includes(current.status)) {
        const warning=document.createElement('p');warning.className='notice danger';warning.textContent='Movimentado após a base de conferência. Prepare uma recontagem física antes de finalizar.';card.append(warning);
      }
      if (current.status==='open') {
        if (item.counted_quantity===null) {
          const form=document.createElement('form');form.className='inventory-count-form';
          const label=document.createElement('label'); label.htmlFor=`count-${item.id}`;label.textContent='Quantidade física';
          const input=document.createElement('input');input.id=label.htmlFor;input.type='number';input.inputMode='numeric';input.min='0';input.max='2147483647';input.step='1';input.required=true;input.className='inventory-count-input';
          const draft=drafts.get(item.id);
          if (draft?.version===item.version) input.value=draft.value;
          else drafts.delete(item.id);
          input.addEventListener('input',()=>drafts.set(item.id,{value:input.value,version:item.version}));
          const save=document.createElement('button');save.type='submit';save.className='btn green';save.dataset.inventoryWrite='true';save.textContent='Salvar contagem';
          form.addEventListener('submit',event=>{
            event.preventDefault();if (!form.reportValidity()) return;
            const quantity=Number(input.value);
            void action(save,async()=>{
              await rpc('guigs_count_inventory_item',{p_inventory_id:current.id,p_item_id:item.id,p_quantity:quantity,p_version:item.version});
              drafts.delete(item.id);
              return 'Contagem salva. Estoque não alterado.';
            },current.id,()=>focusNext(item.id));
          });
          form.append(label,input,save);card.append(form);
        }
        const recount=document.createElement('button');recount.type='button';recount.className='btn';recount.textContent='Recontar';recount.dataset.inventoryWrite='true';
        recount.addEventListener('click',()=>void action(recount,async()=>{
          if (!await confirmAction('Preparar recontagem',`Reconte fisicamente ${item.product_name} / ${item.lot_code} / ${localLabel(item.location)}. A evidência anterior será preservada e a base será atualizada.`)) return;
          await rpc('guigs_recount_inventory_item',{p_inventory_id:current.id,p_item_id:item.id,p_version:item.version});
          drafts.delete(item.id);
          return 'Recontagem preparada. Conte novamente; estoque não alterado.';
        },current.id,()=>el(`count-${item.id}`)?.focus()));
        card.append(recount);
      }
      if (item.counted_at) {const by=document.createElement('p');by.className='muted';by.textContent=`Contagem: ${actor(item.counted_by,item.counted_by_label)} · ${date(item.counted_at)}`;card.append(by);}
      list.append(card);
    }
    if (!items.length) list.textContent='Nenhum item para estes filtros.';
    sync();
  }
  function focusNext(previousId) {
    const next=data.items.find(item=>item.counted_quantity===null && item.id!==previousId);
    if (!next) {el('inventoryTotals').focus();return;}
    el('inventoryItemSelect').value='';el('inventoryFilter').value='pending';el('inventoryLocation').value='';
    el('inventoryItemSelect').dispatchEvent(new Event('change',{bubbles:true}));
    const input=el(`count-${next.id}`);input?.scrollIntoView({block:'center'});input?.focus();
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
  el('inventoryItemSelect').addEventListener('change',renderItems);
  el('inventoryFilter').addEventListener('change',renderItems);
  el('inventoryLocation').addEventListener('change',renderItems);
  el('inventoryReviewCheck').addEventListener('change',()=>{reviewApproved=el('inventoryReviewCheck').checked;sync();});
  el('inventoryNextItem').addEventListener('click',()=>{if(data)focusNext('');});
  el('newInventory').addEventListener('click',()=>{
    el('inventoryCreateMessage').textContent='';el('inventoryCreateDialog').showModal();
  });
  el('inventoryCreateDialog').addEventListener('cancel',event=>{if(pending)event.preventDefault();});
  el('inventoryCreateForm').addEventListener('submit',event=>{
    event.preventDefault();if (!event.currentTarget.reportValidity() || getContext().shop?.role!=='owner') return;
    const observation=el('inventoryObservation').value.trim();
    let createdId;
    void action(el('inventoryCreateSubmit'),async()=>{
      createdId=await rpc('guigs_create_inventory',{p_observation:observation});
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
      const result=await rpc('guigs_complete_inventory',{p_inventory_id:current.id,p_version:current.version,p_confirm:true});
      return `Inventário concluído: ${result.adjustments} ajuste(s) registrados no histórico.`;
    },current.id,refreshStock);
  });
  async function reload() {
    if (pending) return;
    try {await loadList();if(data)await readInventory(data.inventory.id,true);} catch(error){message(error.message,true);}sync();
  }
  el('inventoryReload').addEventListener('click',()=>void reload());
  el('inventoryPrevious').addEventListener('click',()=>{page--;void reload();});
  el('inventoryNext').addEventListener('click',()=>{page++;void reload();});
  window.addEventListener('offline',sync);
  window.addEventListener('online',()=>{sync();if(location.hash==='#inventario')void reload();});
  return {activate(){sync();if(getContext().shop && navigator.onLine && (!loaded || location.hash==='#inventario'))void reload();}};
}
