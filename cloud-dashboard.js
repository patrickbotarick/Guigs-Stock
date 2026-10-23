import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createInventoryUI } from './inventory.js';

const el = id => document.getElementById(id);

// A viewport visual também encolhe quando o teclado sobrepõe a página no celular.
function updateDialogViewport() {
  const viewport = window.visualViewport;
  document.documentElement.style.setProperty('--dialog-viewport-height', `${viewport?.height || innerHeight}px`);
  document.documentElement.style.setProperty('--dialog-viewport-top', `${viewport?.offsetTop || 0}px`);
}
window.visualViewport?.addEventListener('resize', updateDialogViewport);
window.visualViewport?.addEventListener('scroll', updateDialogViewport);
window.addEventListener('resize', updateDialogViewport);
updateDialogViewport();

// O select continua responsável pelo valor, pelas opções e pela validação.
// A pesquisa só apresenta essas mesmas opções, sem alterar a ordem (inclusive FEFO).
const searchableSelects = new Map();
function enhanceSearchableSelect(id) {
  const select = el(id);
  const wrapper = document.createElement('div');
  wrapper.className = 'searchable-select';
  const input = document.createElement('input');
  input.id = `${id}Search`;
  input.type = 'search';
  input.autocomplete = 'off';
  input.placeholder = 'Digite para pesquisar';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  const list = document.createElement('div');
  list.id = `${id}Options`;
  list.className = 'searchable-options';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  input.setAttribute('aria-controls', list.id);
  const label = document.querySelector(`label[for="${id}"]`);
  if (label) {
    label.htmlFor = input.id;
    label.id ||= `${id}Label`;
    list.setAttribute('aria-labelledby', label.id);
  } else {
    // Filtros sem label visível recebem um nome acessível.
    input.setAttribute('aria-label', select.getAttribute('aria-label') || 'Produto');
    list.setAttribute('aria-label', input.getAttribute('aria-label'));
  }
  select.before(wrapper);
  wrapper.append(input, list, select);
  select.classList.add('searchable-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  let shown = [];
  let active = -1;
  let opened = false;
  let pointerOutside = false;
  const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  function sync() {
    input.value = select.selectedOptions[0]?.textContent || '';
    input.disabled = select.disabled;
    input.setAttribute('aria-required', String(select.required));
    if (select.validity.valid) input.removeAttribute('aria-invalid');
  }
  function close() {
    opened = false;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    sync();
  }
  function activate(index) {
    active = index;
    [...list.querySelectorAll('[role="option"]')].forEach((row, i) => {
      row.classList.toggle('active', i === active);
    });
    const row = list.children[active];
    if (row && shown.length) {
      input.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({block: 'nearest'});
    } else input.removeAttribute('aria-activedescendant');
  }
  function choose(index) {
    const option = shown[index];
    if (!option) return;
    select.value = option.value;
    input.focus();
    close();
    select.dispatchEvent(new Event('change', {bubbles: true}));
  }
  function render(term = '') {
    opened = true;
    shown = [...select.options].filter(option => !option.disabled && !option.hidden && normalize(option.textContent).includes(normalize(term)));
    list.replaceChildren();
    for (const [index, option] of shown.entries()) {
      const row = document.createElement('div');
      row.id = `${id}Option${index}`;
      row.className = 'searchable-option';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(option.selected));
      row.textContent = option.textContent;
      row.addEventListener('click', () => choose(index));
      list.append(row);
    }
    if (!shown.length) {
      const empty = document.createElement('div');
      empty.className = 'searchable-empty';
      empty.setAttribute('role', 'status');
      empty.textContent = 'Nenhum resultado encontrado';
      list.append(empty);
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    activate(shown.length ? Math.max(0, shown.findIndex(option => option.selected)) : -1);
  }
  input.addEventListener('focus', () => { sync(); render(); input.select(); });
  input.addEventListener('click', () => { if (!opened) { render(); input.select(); } });
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape' && opened) {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (event.key === 'Enter' && opened) {
      event.preventDefault(); choose(active);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!opened) render();
      else activate(Math.max(0, Math.min(shown.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Tab') close();
  });
  wrapper.addEventListener('focusout', event => {
    if (!pointerOutside && !wrapper.contains(event.relatedTarget)) close();
  });
  // Evita que o blur descarte o filtro antes do click; toque mantém scroll nativo.
  list.addEventListener('mousedown', event => event.preventDefault());
  // Fechar antes do click deslocaria os botões abaixo da lista entre down e up.
  document.addEventListener('pointerdown', event => { pointerOutside = !wrapper.contains(event.target); });
  document.addEventListener('keydown', () => { pointerOutside = false; }, true);
  document.addEventListener('pointercancel', () => { pointerOutside = false; });
  document.addEventListener('click', event => {
    pointerOutside = false;
    if (!wrapper.contains(event.target)) close();
  });
  select.addEventListener('change', close);
  select.addEventListener('invalid', event => {
    event.preventDefault();
    input.setAttribute('aria-invalid', 'true');
    // O navegador termina a validação de todos os campos antes de direcionar o foco.
    queueMicrotask(() => {
      if (!select.form || select.form.querySelector(':invalid') === select) {
        input.focus(); render();
      }
    });
  });
  select.form?.addEventListener('reset', () => setTimeout(close, 0));
  new MutationObserver(close).observe(select, {childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label']});
  const dialog = select.closest('dialog');
  if (dialog) {
    new MutationObserver(close).observe(dialog, {attributes: true, attributeFilter: ['open']});
    dialog.addEventListener('close', close);
  }
  searchableSelects.set(id, close);
  sync();
}

['receiveProduct', 'receiveSupplier', 'transferLot', 'saleLot', 'lossLot',
  'adjustLot', 'editProductSelect', 'historyProduct', 'supplierSelect']
  .forEach(enhanceSearchableSelect);

const cfg = window.GUIGS_SUPABASE_CONFIG || {};

let client = null;

let shop = null;

let products = [];
let suppliers = [];
let lots = [];
let moves = [];
let lotBalances = new Map();

let historyPage = 0;
let historyTotal = 0;
const historyPageSize = 20;

let query = '';

let historyProduct = '';
let historyType = '';
let historyActor = '';
let historyDateFrom = '';
let historyDateTo = '';

let historyActors = [];

let historySearchTimer = null;
const pendingOperations = new Map();
const HIGH_QUANTITY = 48; // Confirmação de UX; não é limite de estoque/RPC.
let attentionFilter = 'all';
let feedbackVersion = 0;

let requestCounter = 0;

let isOffline =
  !navigator.onLine;

// ============================================================
// HELPERS
// ============================================================

function say(message, kind = '') {
  el('status').textContent = message;
  el('status').className = 'notice ' + kind;
}
function setOfflineDashboardState() {

  isOffline = true;

  say(
    'Você está sem conexão com a internet. '
    + 'Os dados em nuvem e as operações de estoque ficarão indisponíveis '
    + 'até a conexão ser restaurada.',
    'danger'
  );

  const ids = [
    'refresh',
    'receiveStock',
    'transferStock',
    'registerSale',
    'registerLoss',
    'newProduct',
    'editProduct',
    'adjustStock',
    'manageSuppliers',
    'newReceiveSupplier',
    'saveSupplier',
    'saveReceipt',
    'saveTransfer', 'saveSale', 'saveLoss', 'saveAdjust', 'saveProduct', 'saveProductEdit'
  ];

  for (const id of ids) {

    const node =
      el(id);

    if (node) {
      node.disabled = true;
    }
  }
  syncOperationButtons();
}


function setOnlineDashboardState() {

  isOffline = false;

  const ids = [
    'refresh',
    'receiveStock',
    'transferStock',
    'registerSale',
    'registerLoss'
  ];

  for (const id of ids) {

    const node =
      el(id);

    if (node) {
      node.disabled = false;
    }
  }

  if (shop?.role === 'owner') {

    const ownerIds = [
      'newProduct',
      'editProduct',
      'adjustStock',
      'manageSuppliers',
      'newReceiveSupplier',
      'saveSupplier'
    ];

    for (const id of ownerIds) {

      const node =
        el(id);

      if (node) {
        node.disabled = false;
      }
    }
  }
  populateReceiveSuppliers();
  if (el('transferDialog').open && !operationPending('transferForm')) populateTransferLots();
  syncOperationButtons();
}


function cell(row, text, className = '') {

  const td = document.createElement('td');

  td.textContent = String(text ?? '');

  if (className) {
    td.className = className;
  }

  row.append(td);
}


function empty(tbody, text, colspan) {

  const tr = tbody.insertRow();

  const td = tr.insertCell();

  td.colSpan = colspan;
  td.className = 'empty';
  td.textContent = text;
}


function dateBR(d) {

  if (!d) return '—';

  const p = d.slice(0, 10).split('-');

  return p.length === 3
    ? `${p[2]}/${p[1]}/${p[0]}`
    : d;
}


function timestamp(t) {

  return t
    ? new Date(t).toLocaleString('pt-BR')
    : '—';
}


function dayDifference(d) {

  const today = new Date();

  const anchor = new Date(
    Date.UTC(
      today.getFullYear(),
      today.getMonth(),
      today.getDate()
    )
  );

  return Math.round(
    (
      Date.parse(d + 'T00:00:00Z')
      - anchor.getTime()
    ) / 86400000
  );
}


function fail(e) {

  el('content').classList.add('hidden');

  say(
    'Não foi possível consultar o Supabase: '
    + String(e.message || e),
    'danger'
  );
}


function formMessage(id, message = '', good = false) {

  const node = el(id);

  node.textContent = message;
  node.setAttribute('role', good ? 'status' : 'alert');

  node.className = good
    ? 'formmsg good'
    : 'formmsg';
}

function operationPending(formId) { return pendingOperations.has(formId); }
const locationLabel = location => location === 'fridge' ? 'Geladeira' : 'Estoque seco';

function syncOperationButtons() {
  const rules = [
    ['productForm', 'saveProduct', true, true],
    ['editProductForm', 'saveProductEdit', true, !!el('editProductSelect').value],
    ['supplierForm', 'saveSupplier', true, true],
    ['receiveForm', 'saveReceipt', false, !!el('receiveProduct').value && suppliers.some(s => s.active)],
    ['transferForm', 'saveTransfer', false, !!el('transferLot').value],
    ['saleForm', 'saveSale', false, !!el('saleLot').value],
    ['lossForm', 'saveLoss', false, !!el('lossLot').value],
    ['adjustForm', 'saveAdjust', true, !!el('adjustLot').value]
  ];
  for (const [form, button, owner, available] of rules) {
    el(button).disabled = operationPending(form) || !navigator.onLine || !available || (owner && shop?.role !== 'owner');
  }
  for (const [form, action, owner] of [
    ['productForm','newProduct',true], ['editProductForm','editProduct',true], ['supplierForm','manageSuppliers',true],
    ['supplierForm','newReceiveSupplier',true], ['receiveForm','receiveStock',false], ['transferForm','transferStock',false],
    ['saleForm','registerSale',false], ['lossForm','registerLoss',false], ['adjustForm','adjustStock',true]
  ]) el(action).disabled = operationPending(form) || !navigator.onLine || (owner && shop?.role !== 'owner');
}

function showOperationFeedback(message, warning = false) {
  const node = el('operationFeedback');
  node.textContent = message;
  node.className = `notice ${warning ? 'danger' : 'good'}`;
}

function confirmOperation(context, title, reason, details) {
  const dialog = el('operationConfirmDialog');
  el('operationConfirmTitle').textContent = title;
  el('operationConfirmReason').textContent = reason;
  const summary = el('operationConfirmSummary');
  summary.replaceChildren();
  for (const [label, value] of details) {
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = String(value);
    summary.append(term, description);
  }
  return context.waitForConfirmation(dialog, 'cancelOperation', 'confirmOperation');
}

function waitForDialogConfirmation(confirmation, cancelId, continueId, parent, isCancelled = () => false) {
  return new Promise(resolve => {
    const cancel = () => confirmation.close('cancel');
    const proceed = () => confirmation.close('continue');
    const closed = () => {
      el(cancelId).removeEventListener('click', cancel);
      el(continueId).removeEventListener('click', proceed);
      parent?.removeEventListener('close', cancel);
      resolve(!isCancelled() && confirmation.returnValue === 'continue');
    };
    confirmation.returnValue = 'cancel';
    el(cancelId).addEventListener('click', cancel);
    el(continueId).addEventListener('click', proceed);
    parent?.addEventListener('close', cancel, {once:true});
    confirmation.addEventListener('close', closed, {once:true});
    confirmation.showModal();
    el(cancelId).focus();
  });
}

async function runOperation(event, {buttonId, messageId, owner = false, reset = true, task, afterSave}) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = el(buttonId);
  if (operationPending(form.id) || button.disabled) return;
  formMessage(messageId);
  const dialog = form.closest('dialog');
  const state = {cancelled: false, writing: false};
  const originalText = button.textContent;
  const controls = [...form.querySelectorAll('input, select, textarea, button')];
  const originalDisabled = new Map(controls.map(control => [control, control.disabled]));
  const closeButtons = controls.filter(control => control.matches('[data-close]'));
  const cancelled = () => { state.cancelled = true; };
  const cancelDuringWrite = event => { if (state.writing) event.preventDefault(); };
  const context = {
    ensure() {
      if (state.cancelled || !dialog.open) throw Error('Operação cancelada.');
      requireOnline();
    },
    async write(name, args) {
      context.ensure();
      state.writing = true;
      closeButtons.forEach(control => { control.disabled = true; });
      const result = await client.rpc(name, args);
      if (result.error) throw result.error;
      return result.data;
    },
    waitForConfirmation(confirmation, cancelId, continueId) {
      context.ensure();
      return waitForDialogConfirmation(confirmation,cancelId,continueId,dialog,()=>state.cancelled);
    }
  };
  try {
    requireOnline();
    if (owner && shop?.role !== 'owner') throw Error('Ação disponível apenas ao proprietário.');
    if (!form.reportValidity()) return;
    pendingOperations.set(form.id, state);
    dialog.addEventListener('close', cancelled);
    dialog.addEventListener('cancel', cancelDuringWrite);
    syncOperationButtons();
    form.setAttribute('aria-busy', 'true');
    button.textContent = 'Salvando…';
    controls.filter(control => !control.matches('[data-close]')).forEach(control => { control.disabled = true; });
    // task captura os campos antes de qualquer await. O valor confirmado é o enviado.
    const message = await task(context);
    if (!message) return;
    dialog.removeEventListener('close', cancelled);
    dialog.close();
    if (reset) form.reset();
    const version = ++feedbackVersion;
    showOperationFeedback(message);
    const updated = await refresh();
    if (afterSave) afterSave();
    if (version === feedbackVersion && updated !== true) {
      showOperationFeedback(`${message} Registro confirmado; atualização pendente. Não repita a operação.`, true);
    }
  } catch (error) {
    if (!state.cancelled) {
      const uncertain = state.writing && /fetch|network|timeout|internet/i.test(error.message || '');
      formMessage(messageId, uncertain
        ? 'Não foi possível confirmar o resultado. Confira o histórico antes de repetir a operação.'
        : error.message || 'Não foi possível salvar. Tente novamente.');
    }
  } finally {
    const wasPending = operationPending(form.id);
    dialog.removeEventListener('close', cancelled);
    pendingOperations.delete(form.id);
    dialog.removeEventListener('cancel', cancelDuringWrite);
    form.removeAttribute('aria-busy');
    button.textContent = originalText;
    for (const [control, disabled] of originalDisabled) control.disabled = disabled;
    syncOperationButtons();
    if (wasPending && dialog.open && !button.disabled) button.focus();
  }
}

function lotDetails(lot, quantity, location, note) {
  return [['Produto', productById(lot.product_id)?.name || 'Produto'], ['Lote', lot.code],
    ['Quantidade', `${quantity} unidade(s)`], ['Local', locationLabel(location)], ['Motivo / observação', note || 'Não informado']];
}

function quantityRisk(quantity, current) {
  return [quantity >= HIGH_QUANTITY ? `Quantidade alta (${HIGH_QUANTITY} ou mais unidades).` : '',
    current > 0 && quantity === current ? 'Esta operação vai zerar o saldo da origem.' : ''].filter(Boolean).join(' ');
}


// ============================================================
// LEITURA PAGINADA
// ============================================================

async function allRows(table, columns) {

  const output = [];

  for (
    let from = 0;
    from < 100000;
    from += 1000
  ) {

    const {
      data,
      error
    } = await client
      .from(table)
      .select(columns)
      .eq('shop_id', shop.shop_id)
      .range(from, from + 999);

    if (error) {
      throw error;
    }

    output.push(...(data || []));

    if (!data || data.length < 1000) {
      return output;
    }
  }

  throw Error(
    'Limite de 100.000 linhas excedido.'
  );
}


// ============================================================
// AUTENTICAÇÃO
// ============================================================

async function bootstrap() {

  if (
    !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i
      .test(cfg.url || '')
    ||
    !/^sb_publishable_[A-Za-z0-9_-]+$/
      .test(cfg.publishableKey || '')
  ) {

    say(
      'Configure a URL e a chave PUBLICÁVEL no config.js.',
      'danger'
    );

    el('signout').disabled = true;

    return;
  }


  client = createClient(
    cfg.url,
    cfg.publishableKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    }
  );


  const {
    data: { user },
    error
  } = await client.auth.getUser();


  if (error || !user) {

    location.replace(
      'auth-preview.html'
    );

    return;
  }


  const membership = await client
    .from('guigs_memberships')
    .select('shop_id,role,active')
    .eq('user_id', user.id)
    .eq('active', true);


  if (membership.error) {
    throw membership.error;
  }


  if (!membership.data?.length) {

    say(
      'Conta autenticada, mas sem vínculo ativo com a pizzaria.',
      'danger'
    );

    return;
  }


  if (membership.data.length !== 1) {

    say(
      'Existem múltiplas lojas associadas. Nenhuma foi escolhida automaticamente.',
      'danger'
    );

    return;
  }


  shop = membership.data[0];


  el('identity').textContent =
    `${user.email || 'Usuário'} · `
    +
    (
      shop.role === 'owner'
        ? 'Proprietário(a)'
        : 'Atendente'
    );


  // Cadastro de produto é exclusivo do proprietário.

  if (shop.role !== 'owner') {

    el('newProduct')
      .classList
      .add('hidden');

    el('editProduct')
      .classList
      .add('hidden');

    el('adjustStock')
      .classList
      .add('hidden');
    el('manageSuppliers').classList.add('hidden');
    el('newReceiveSupplier').classList.add('hidden');
  }


  el('refresh').disabled = false;


  client.auth.onAuthStateChange(
    (event, session) => {

      if (
        event === 'SIGNED_OUT'
        || !session
      ) {

        el('content')
          .classList
          .add('hidden');

        location.replace(
          'auth-preview.html'
        );
      }
    }
  );


  await refresh();

  if (!navigator.onLine) {

  setOfflineDashboardState();
}
}


// ============================================================
// ATUALIZAÇÃO DOS DADOS
// ============================================================

async function refresh() {

  if (!shop) return;

if (!navigator.onLine) {

  setOfflineDashboardState();

  return;
}

  const ticket =
    ++requestCounter;


  el('refresh').disabled = true;


  say(
    'Atualizando dados do estoque…'
  );


  try {

    const [p, l, balanceResult, s] =
      await Promise.all([

        allRows(
          'guigs_products',
          'id,name,category,min_total,target_total,min_fridge,target_fridge,active'
        ),

        allRows(
          'guigs_lots',
          'id,product_id,code,expiry,created_at,supplier_id'
        ),

        client.rpc(
          'guigs_get_lot_balances',
          {
            p_shop: shop.shop_id
          }
        ),
        allRows('guigs_suppliers', 'id,name,active,created_at')
      ]);


    if (ticket !== requestCounter) {
      return;
    }


    if (balanceResult.error) {
      throw balanceResult.error;
    }


    products = p;
    lots = l;
    suppliers = s;



    lotBalances =
      new Map(
        (balanceResult.data || []).map(
          row => [
            row.lot_id,
            {
              stock: Number(row.stock),
              fridge: Number(row.fridge)
            }
          ]
        )
      );


    render();

    populateReceiveProducts();
    populateReceiveSuppliers();

await loadHistoryActors();

populateHistoryFilters();

await loadHistory();


    el('content')
      .classList
      .remove('hidden');
    if (location.hash === '#inventario') inventoryUI.activate();


    say(
      'Estoque sincronizado com o Supabase.',
      'good'
    );
    return true;

  }
  catch (e) {
    if (el('content').classList.contains('hidden')) fail(e);
    else say('Não foi possível atualizar. Os dados exibidos podem estar desatualizados. ' + (e.message || ''), 'danger');
    return false;
  }
  finally {

    el('refresh').disabled = !navigator.onLine;
    syncOperationButtons();
  }
}


// ============================================================
// RENDERIZAÇÃO DO DASHBOARD
// ============================================================

function replenishmentFor(product, balance) {
  const deficit = Math.max(0, product.target_fridge - balance.fridge);
  const eligible = lots.filter(lot => lot.product_id === product.id && dayDifference(lot.expiry) >= 0 && (lotBalances.get(lot.id)?.stock || 0) > 0)
    .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const available = eligible.reduce((total, lot) => total + lotBalances.get(lot.id).stock, 0);
  return {deficit, available, suggested: Math.min(deficit, available), first: eligible[0]};
}

function matchesAttention(product, balance, lotList) {
  if (attentionFilter === 'all') return true;
  if (!product.active) return false;
  if (attentionFilter === 'minimum') return balance.stock + balance.fridge < product.min_total || balance.fridge < product.min_fridge;
  if (attentionFilter === 'replenish') return balance.fridge < product.target_fridge;
  return lotList.some(lot => lot.product_id === product.id &&
    (attentionFilter === 'expired' ? lot.days < 0 : lot.days >= 0 && lot.days <= 30));
}

function renderReplenishment(productBalances, visibleIds) {
  const list = el('replenishmentList');
  list.replaceChildren();
  const ordered = products.filter(product => product.active && visibleIds.has(product.id) && productBalances.get(product.id).fridge < product.target_fridge)
    .sort((a, b) => Number(productBalances.get(b.id).fridge < b.min_fridge) - Number(productBalances.get(a.id).fridge < a.min_fridge) || a.name.localeCompare(b.name, 'pt-BR'));
  for (const product of ordered) {
    const balance = productBalances.get(product.id);
    const advice = replenishmentFor(product, balance);
    const card = document.createElement('article');
    card.className = 'replenishment-card' + (balance.fridge < product.min_fridge ? ' warning' : '');
    card.dataset.productId = product.id;
    const title = document.createElement('strong');
    title.textContent = product.name;
    const quantities = document.createElement('p');
    quantities.textContent = `Geladeira: ${balance.fridge} · Mínimo: ${product.min_fridge} · Meta: ${product.target_fridge} · Estoque seco: ${balance.stock} (${advice.available} não vencidas).`;
    const suggestion = document.createElement('p');
    suggestion.textContent = `Sugestão de reposição: ${advice.suggested} unidade(s). ${balance.fridge < product.min_fridge ? 'Abaixo do mínimo.' : 'Reposição sugerida até a meta.'}`;
    const guidance = document.createElement('p');
    guidance.className = 'muted';
    guidance.textContent = advice.first ? `Primeiro lote FEFO: ${advice.first.code} · ${dateBR(advice.first.expiry)}. Confira os lotes no modal Movimentar.` : 'Sem estoque seco não vencido para repor.';
    card.append(title, quantities, suggestion, guidance);
    if (advice.suggested < advice.deficit) {
      const shortage = document.createElement('p');
      shortage.textContent = `Estoque seco insuficiente: faltam ${advice.deficit - advice.suggested} unidade(s) para atingir a meta.`;
      card.append(shortage);
    }
    list.append(card);
  }
  if (!ordered.length) list.textContent = 'Nenhuma reposição sugerida para este filtro.';
}

function render() {

  const productMap =
    new Map(
      products.map(
        p => [p.id, p]
      )
    );


  const lotMap =
    new Map(
      lots.map(
        l => [l.id, l]
      )
    );

  if (
    [...lotBalances.values()]
      .some(
        b =>
          b.stock < 0
          ||
          b.fridge < 0
      )
  ) {

    throw Error(
      'Saldo negativo identificado no banco.'
    );
  }


  const ps =
    new Map(
      products.map(
        p => [
          p.id,
          {
            stock: 0,
            fridge: 0
          }
        ]
      )
    );


  let near = 0;

  const lotList = [];


  for (const l of lots) {

    if (!ps.has(l.product_id)) {

      throw Error(
        'Lote sem produto correspondente.'
      );
    }


    const b =
      lotBalances.get(l.id)
      || {
        stock: 0,
        fridge: 0
      };


    const q =
      b.stock + b.fridge;


    const days =
      dayDifference(l.expiry);


    ps.get(l.product_id).stock
      += b.stock;


    ps.get(l.product_id).fridge
      += b.fridge;


    if (
      days >= 0
      &&
      days <= 30
    ) {

      near += q;
    }


    if (q > 0) {

      lotList.push({
        ...l,
        qty: q,
        days,
        product:
          productMap
            .get(l.product_id)
            ?.name
          || 'Produto desconhecido'
      });
    }
  }


  let stock = 0;

  let fridge = 0;


  for (const b of ps.values()) {

    stock += b.stock;

    fridge += b.fridge;
  }


  const productsAttention =
    products.filter(
      p => {

        if (!p.active) {
          return false;
        }


        const b =
          ps.get(p.id);


        const total =
          b.stock + b.fridge;


        return (
          total === 0
          ||
          total < p.min_total
          ||
          b.fridge < p.min_fridge
        );
      }
    ).length;


  const criticalLots =
    lotList.filter(
      l =>
        l.days <= 30
    ).length;


  el('stock').textContent =
    stock;


  el('fridge').textContent =
    fridge;


  el('productsAttention').textContent =
    productsAttention;


  el('criticalLots').textContent =
    criticalLots;

  const visibleProducts = products.filter(product => matchesAttention(product, ps.get(product.id), lotList));
  const visibleIds = new Set(visibleProducts.map(product => product.id));
  const visibleLots = lotList.filter(lot => visibleIds.has(lot.product_id) &&
    (attentionFilter === 'expired' ? lot.days < 0 : attentionFilter === 'near' ? lot.days >= 0 && lot.days <= 30 : true));
  renderReplenishment(ps, visibleIds);
  const filterButton = document.querySelector(`[data-attention="${attentionFilter}"]`);
  el('attentionFilterStatus').textContent = `${filterButton.textContent}: ${visibleProducts.length} produto(s), ${visibleLots.length} lote(s) com saldo. Métricas mostram o estoque completo.`;

  // ALERTAS OPERACIONAIS

  const alerts = [];


  for (const p of products) {

    if (!p.active || !visibleIds.has(p.id) || attentionFilter === 'near' || attentionFilter === 'expired') {
      continue;
    }


    const b =
      ps.get(p.id);


    const total =
      b.stock + b.fridge;


    if (total === 0) {

      alerts.push({
        level: 'danger',
        title: `${p.name} está zerado`,
        description:
          'Não há unidades no estoque nem na geladeira.'
      });

      continue;
    }


    if (total < p.min_total) {

      alerts.push({
        level: 'warning',
        title: `${p.name} abaixo do estoque mínimo`,
        description:
          `${total} unidades disponíveis · mínimo definido: ${p.min_total}.`
      });
    }


    if (b.fridge < p.min_fridge) {

      alerts.push({
        level: 'warning',
        title: `${p.name} com geladeira abaixo do mínimo`,
        description:
          `${b.fridge} unidades na geladeira · mínimo definido: ${p.min_fridge}.`
      });
    }
  }


  for (const l of visibleLots) {

    if (l.days < 0) {

      alerts.push({
        level: 'danger',
        title: `${l.product} possui lote vencido`,
        badge: 'Vencido',
        description:
          `Lote ${l.code} · ${l.qty} unidade(s) · validade ${dateBR(l.expiry)}.`
      });

    }
    else if (l.days <= 30) {

      alerts.push({
        level: 'warning',
        title: `${l.product} próximo do vencimento`,
        badge: l.days <= 15 ? 'Urgente' : 'Atenção',
        description:
          `Lote ${l.code} · vence em ${l.days} dia(s) · ${l.qty} unidade(s).`
      });
    }
  }


  const alertsPanel =
    el('alertsPanel');


  const alertsList =
    el('operationalAlerts');


  alertsList.replaceChildren();


  if (!alerts.length) {

    alertsPanel.classList.add(
      'hidden'
    );

  }
  else {

    alertsPanel.classList.remove(
      'hidden'
    );


    for (const alert of alerts) {

      const item =
        document.createElement('div');


      item.className =
        `operational-alert ${alert.level}`;


      const text =
        document.createElement('div');


      const title =
        document.createElement('strong');


      title.textContent =
        alert.title;


      const description =
        document.createElement('small');


      description.textContent =
        alert.description;


      text.append(
        title,
        description
      );


      const level =
        document.createElement('span');


      level.className =
        'alert-level';


      level.textContent =
        alert.badge || (alert.level === 'danger'
          ? 'Urgente'
          : 'Atenção');


      item.append(
        text,
        level
      );


      alertsList.append(
        item
      );
    }


    el('alertCount').textContent =
      alerts.length
      +
      (
        alerts.length === 1
          ? ' alerta'
          : ' alertas'
      );
  }

  // PRODUTOS

  const pt =
    el('products');


  pt.replaceChildren();


  for (
    const p
    of [...visibleProducts]
      .sort(
        (a, b) =>
          a.name.localeCompare(
            b.name,
            'pt-BR'
          )
      )
  ) {

    const b =
      ps.get(p.id);


    const r =
      pt.insertRow();


    const total =
      b.stock + b.fridge;


    let statusText =
      'OK';


    let statusClass =
      'ok';


    if (!p.active) {

      statusText =
        'Inativo';

      statusClass =
        'inactive';

    }
    else if (total === 0) {

      statusText =
        'Zerado';

      statusClass =
        'danger';

      r.classList.add(
        'product-row-danger'
      );

    }
    else if (total < p.min_total) {

      statusText =
        'Estoque baixo';

      statusClass =
        'warning';

      r.classList.add(
        'product-row-warning'
      );

    }
    else if (b.fridge < p.min_fridge) {

      statusText =
        'Geladeira baixa';

      statusClass =
        'warning';

      r.classList.add(
        'product-row-warning'
      );
    } else if (total < p.target_total || b.fridge < p.target_fridge) {
      statusText = 'Reposição sugerida';
      statusClass = 'warning';
    }


    cell(
      r,
      p.name
    );
    const thresholds = document.createElement('small');
    thresholds.className = 'muted stock-thresholds';
    thresholds.textContent = `Total: mínimo ${p.min_total} / meta ${p.target_total} · Geladeira: mínimo ${p.min_fridge} / meta ${p.target_fridge}`;
    r.cells[0].append(thresholds);


    cell(
      r,
      b.stock,
      'num'
    );


    cell(
      r,
      b.fridge,
      'num'
    );


    cell(
      r,
      total,
      'num'
    );


    const statusCell =
      document.createElement('td');


    const statusBadge =
      document.createElement('span');


    statusBadge.className =
      `product-status ${statusClass}`;


    statusBadge.textContent =
      statusText;


    statusCell.append(
      statusBadge
    );


    r.append(
      statusCell
    );
  }


  if (!visibleProducts.length) {

    empty(
      pt,
      'Nenhuma bebida para este filtro.',
      5
    );
  }


  el('productCount').textContent =
    visibleProducts.length
    + ' produtos';


  // LOTES

  const lt =
    el('lots');


  lt.replaceChildren();


  for (
    const l
    of visibleLots
      .sort(
        (a, b) =>
          a.expiry.localeCompare(
            b.expiry
          )
      )
      .slice(0, 100)
  ) {

    const r =
      lt.insertRow();


    cell(
      r,
      l.product
      + ' · '
      + l.code
    );
    const supplierInfo = document.createElement('small');
    supplierInfo.className = 'muted';
    supplierInfo.style.display = 'block';
    supplierInfo.textContent = `Fornecedor: ${supplierName(l)}`;
    r.cells[0].append(supplierInfo);


    cell(
      r,
      dateBR(l.expiry)
    );


    cell(
      r,
      l.qty,
      'num'
    );


    let expiryText =
      'OK';


    let expiryClass =
      'normal';


    if (l.days < 0) {

      expiryText =
        'Vencido';

      expiryClass =
        'expired';

      r.classList.add(
        'expiry-row-expired'
      );

    }
    else if (l.days <= 15) {

      expiryText =
        'Urgente';

      expiryClass =
        'urgent';

      r.classList.add(
        'expiry-row-urgent'
      );

    }
    else if (l.days <= 30) {

      expiryText =
        'Atenção';

      expiryClass =
        'attention';

      r.classList.add(
        'expiry-row-attention'
      );
    }


    const expiryCell =
      document.createElement('td');


    const expiryBadge =
      document.createElement('span');


    expiryBadge.className =
      `expiry-status ${expiryClass}`;


    expiryBadge.textContent =
      expiryText;


    expiryCell.append(
      expiryBadge
    );


    r.append(
      expiryCell
    );
  }


  if (!visibleLots.length) {

    empty(
      lt,
      'Nenhum lote com unidades registradas.',
      4
    );
  }


  el('lotCount').textContent =
    visibleLots.length
    + ' lotes com saldo (até 100 exibidos)';


  el('updated').textContent =
    `Atualizado em ${new Date()
      .toLocaleString('pt-BR')
    }.`;

}


// ============================================================
// HISTÓRICO
// ============================================================

async function loadHistoryActors() {

  if (!shop || !client) {
    return;
  }


  const {
    data,
    error
  } = await client.rpc(
    'guigs_get_history_actors',
    {
      p_shop: shop.shop_id
    }
  );


  if (error) {
    throw error;
  }


  historyActors =
    data || [];
}


function populateHistoryFilters() {

  const productSelect =
    el('historyProduct');


  const actorSelect =
    el('historyActor');


  productSelect.replaceChildren();


  const allProducts =
    document.createElement('option');


  allProducts.value = '';

  allProducts.textContent =
    'Todos os produtos';


  productSelect.append(
    allProducts
  );


  for (
    const product
    of [...products].sort(
      (a, b) =>
        a.name.localeCompare(
          b.name,
          'pt-BR'
        )
    )
  ) {

    const option =
      document.createElement('option');


    option.value =
      product.id;


    option.textContent =
      product.name;


    productSelect.append(
      option
    );
  }


  productSelect.value =
    historyProduct;


  actorSelect.replaceChildren();


  const allActors =
    document.createElement('option');


  allActors.value = '';

  allActors.textContent =
    'Todos os usuários';


  actorSelect.append(
    allActors
  );


  for (const actor of historyActors) {

    const option =
      document.createElement('option');


    option.value =
      actor.actor_id;


    option.textContent =
      actor.actor_email
      || 'Usuário desconhecido';


    actorSelect.append(
      option
    );
  }


  actorSelect.value =
    historyActor;
}

async function loadHistory() {

  if (!shop || !client) {
    return;
  }


  const offset =
    historyPage * historyPageSize;


  const {
    data,
    error
  } = await client.rpc(
    'guigs_get_history',
    {
      p_shop: shop.shop_id,
      p_limit: historyPageSize,
      p_offset: offset,
      p_product:
  historyProduct || null,

p_type:
  historyType || null,

p_actor:
  historyActor || null,

p_date_from:
  historyDateFrom
    ? new Date(
        `${historyDateFrom}T00:00:00`
      ).toISOString()
    : null,

p_date_to:
  historyDateTo
    ? new Date(
        `${historyDateTo}T23:59:59.999`
      ).toISOString()
    : null,
      p_search:
        query.trim()
          ? query.trim()
          : null
    }
  );


  if (error) {
    throw error;
  }


  moves =
    data || [];


  historyTotal =
    moves.length
      ? Number(moves[0].total_count)
      : 0;


  /*
   * Se uma página deixou de existir após filtros ou alterações,
   * volta automaticamente para a última página válida.
   */
  const pages =
    Math.max(
      1,
      Math.ceil(
        historyTotal / historyPageSize
      )
    );


  if (historyPage > pages - 1) {

    historyPage =
      pages - 1;

    return loadHistory();
  }


  renderHistory();
}

function renderHistory() {

  const ht =
    el('history');


  ht.replaceChildren();


  for (const m of moves) {

    const r =
      ht.insertRow();


    cell(
      r,
      timestamp(m.created_at)
    );


    cell(
      r,
      (m.product_name || 'Desconhecido')
      + ' · '
      + (m.lot_code || '—')
    );
    if (m.note) {
      const note = document.createElement('small');
      note.className = 'muted';
      note.style.display = 'block';
      note.textContent = m.note;
      r.cells[1].append(note);
    }


    const movementLabels = {
      receipt: 'Recebimento',
      transfer: 'Transferência',
      return: 'Retorno',
      sale: 'Venda',
      loss: 'Perda',
      adjust: 'Ajuste'
    };


    const typeCell =
      document.createElement('td');


    const typeBadge =
      document.createElement('span');


    typeBadge.className =
      `movement-type ${m.movement_type}`;


    typeBadge.textContent =
      movementLabels[m.movement_type]
      || m.movement_type;


    typeCell.append(
      typeBadge
    );


    r.append(
      typeCell
    );


    const locationCell =
      document.createElement('td');


    const locationBadge =
      document.createElement('span');


    locationBadge.className =
      'location-badge';


    locationBadge.textContent =
      m.location === 'stock'
        ? 'Estoque'
        : 'Geladeira';


    locationCell.append(
      locationBadge
    );


    r.append(
      locationCell
    );

    cell(
      r,
      m.actor_email
      || 'Usuário desconhecido'
    );

    cell(
      r,
      (m.delta > 0 ? '+' : '')
      + m.delta,
      m.delta > 0
        ? 'num delta-positive'
        : m.delta < 0
          ? 'num delta-negative'
          : 'num'
    );
  }


  if (!moves.length) {

    empty(
      ht,
      'Nenhuma movimentação encontrada.',
      6
    );
  }


  const pages =
    Math.max(
      1,
      Math.ceil(
        historyTotal / historyPageSize
      )
    );


  el('page').textContent =
    `${historyPage + 1}/${pages}`
    + ` · ${historyTotal} lançamentos`;


  el('prev').disabled =
    historyPage === 0;


  el('next').disabled =
    historyPage >= pages - 1;
}


// ============================================================
// PRODUTOS PARA O FORMULÁRIO DE RECEBIMENTO
// ============================================================

function populateReceiveProducts() {

  const select =
    el('receiveProduct');


  select.replaceChildren();


  const active =
    products
      .filter(
        p => p.active
      )
      .sort(
        (a, b) =>
          a.name.localeCompare(
            b.name,
            'pt-BR'
          )
      );


  if (!active.length) {

    const option =
      document.createElement(
        'option'
      );

    option.value = '';

    option.textContent =
      'Cadastre um produto primeiro';

    select.append(option);

    el('saveReceipt').disabled =
      true;

    return;
  }


  for (const product of active) {

    const option =
      document.createElement(
        'option'
      );

    option.value =
      product.id;

    option.textContent =
      product.name;

    select.append(option);
  }


  el('saveReceipt').disabled =
    false;
}


// ============================================================
// CRIAR PRODUTO
// ============================================================

async function createProduct(event) {
  return runOperation(event, {buttonId:'saveProduct',messageId:'productMessage',owner:true,task:async context => {
    const args = {p_shop_id:shop.shop_id,p_name:el('productName').value.trim(),p_category:el('productCategory').value,
      p_min_total:Number(el('minTotal').value),p_target_total:Number(el('targetTotal').value),
      p_min_fridge:Number(el('minFridge').value),p_target_fridge:Number(el('targetFridge').value)};
    await context.write('guigs_create_product',args);
    return `Produto cadastrado: ${args.p_name}.`;
  }});
}


// ============================================================
// EDITAR PRODUTO
// ============================================================

function populateEditProducts() {

  const select =
    el('editProductSelect');

  select.replaceChildren();

  const ordered =
    [...products]
      .sort(
        (a, b) =>
          a.name.localeCompare(
            b.name,
            'pt-BR'
          )
      );

  if (!ordered.length) {

    const option =
      document.createElement('option');

    option.value = '';

    option.textContent =
      'Nenhum produto cadastrado';

    select.append(option);

    el('saveProductEdit').disabled =
      true;

    return;
  }


  for (const product of ordered) {

    const option =
      document.createElement('option');

    option.value =
      product.id;

    option.textContent =
      product.name;

    select.append(option);
  }


  el('saveProductEdit').disabled =
    false;


  fillEditProductForm();
}


function fillEditProductForm() {

  const product =
    products.find(
      p =>
        p.id ===
        el('editProductSelect').value
    );


  if (!product) {
    return;
  }


  el('editProductName').value =
    product.name;


  el('editProductCategory').value =
    product.category || 'Outro';


  el('editMinTotal').value =
    product.min_total;


  el('editTargetTotal').value =
    product.target_total;


  el('editMinFridge').value =
    product.min_fridge;


  el('editTargetFridge').value =
    product.target_fridge;


  el('editProductActive').value =
    String(product.active);
}


async function updateProductOperation(event) {
  return runOperation(event, {buttonId:'saveProductEdit',messageId:'editProductMessage',owner:true,reset:false,task:async context => {
    const args = {p_shop_id:shop.shop_id,p_product_id:el('editProductSelect').value,p_name:el('editProductName').value.trim(),
      p_category:el('editProductCategory').value,p_min_total:Number(el('editMinTotal').value),
      p_target_total:Number(el('editTargetTotal').value),p_min_fridge:Number(el('editMinFridge').value),
      p_target_fridge:Number(el('editTargetFridge').value),p_active:el('editProductActive').value==='true'};
    const data = await context.write('guigs_update_product',args);
    return data ? `Produto atualizado: ${args.p_name}.` : 'Nenhuma alteração realizada no produto.';
  }});
}


// ============================================================
// RECEBIMENTO
// ============================================================

async function receiveStock(event) {
  return runOperation(event, {buttonId:'saveReceipt',messageId:'receiveMessage',task:async context => {
    const args = {p_shop_id:shop.shop_id,p_product_id:el('receiveProduct').value,p_supplier_id:el('receiveSupplier').value,
      p_lot_code:el('lotCode').value.trim(),p_expiry:el('expiry').value,p_quantity:Number(el('receiveQuantity').value),p_note:el('receiveNote').value.trim()};
    if (!suppliers.some(s=>s.id===args.p_supplier_id && s.active)) throw Error('Selecione um fornecedor ativo.');
    const name = productById(args.p_product_id)?.name || 'Produto';
    if (args.p_quantity >= HIGH_QUANTITY && !await confirmOperation(context,'Confirmar recebimento',quantityRisk(args.p_quantity),[
      ['Produto',name],['Lote',args.p_lot_code],['Quantidade',`${args.p_quantity} unidade(s)`],
      ['Fornecedor',suppliers.find(s=>s.id===args.p_supplier_id)?.name || ''],['Validade',dateBR(args.p_expiry)],['Observação',args.p_note || 'Não informada']])) return;
    const data = await context.write('guigs_receive_stock',args);
    return `Recebimento registrado: +${data.quantity} ${name}.`;
  }});
}


// ============================================================
// OPERAÇÕES DE MOVIMENTAÇÃO
// ============================================================

function requireOnline() {
  if (!navigator.onLine) throw Error('Conecte-se à internet para concluir a operação.');
}

function supplierName(lot) {
  return suppliers.find(s => s.id === lot?.supplier_id)?.name || 'Não informado';
}

function populateReceiveSuppliers(selected = el('receiveSupplier').value) {
  const select = el('receiveSupplier');
  select.replaceChildren(new Option('Selecione um fornecedor', ''));
  for (const supplier of [...suppliers].filter(s => s.active).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))) {
    select.add(new Option(supplier.name, supplier.id));
  }
  select.value = selected;
  el('saveReceipt').disabled = operationPending('receiveForm') || !navigator.onLine || !products.some(p => p.active) || !suppliers.some(s => s.active);
}

function fillSupplierForm() {
  const supplier = suppliers.find(s => s.id === el('supplierSelect').value);
  el('supplierName').value = supplier?.name || '';
  el('supplierActive').value = String(supplier?.active ?? true);
}

async function openSupplierDialog() {
  if (shop?.role !== 'owner') return;
  formMessage('supplierMessage');
  try {
    requireOnline();
    suppliers = await allRows('guigs_suppliers', 'id,name,active,created_at');
    const select = el('supplierSelect');
    select.replaceChildren(new Option('+ Novo fornecedor', ''));
    for (const supplier of [...suppliers].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))) {
      select.add(new Option(`${supplier.name}${supplier.active ? '' : ' · Inativo'}`, supplier.id));
    }
    fillSupplierForm();
    el('saveSupplier').disabled = false;
    el('supplierDialog').showModal();
  } catch (error) {
    say(error.message || 'Não foi possível consultar fornecedores.', 'danger');
  }
}

async function saveSupplier(event) {
  let selected = '';
  return runOperation(event, {buttonId:'saveSupplier',messageId:'supplierMessage',owner:true,reset:false,afterSave:()=>populateReceiveSuppliers(selected),task:async context => {
    const id = el('supplierSelect').value;
    const args = {p_shop_id:shop.shop_id,p_name:el('supplierName').value.trim(),p_active:el('supplierActive').value==='true'};
    if (id) args.p_supplier_id = id;
    const data = await context.write(id ? 'guigs_update_supplier' : 'guigs_create_supplier',args);
    selected = args.p_active ? (id || data) : '';
    return `Fornecedor ${id ? 'atualizado' : 'cadastrado'}: ${args.p_name}.`;
  }});
}


function productById(id) {
  return products.find(p => p.id === id);
}

function lotLabel(lot) {

  const product =
    productById(lot.product_id);

  return `${product?.name || 'Produto'} · ${lot.code}`;
}


function populateTransferLots() {

  const select = el('transferLot');

  select.replaceChildren();

  const direction =
    el('transferDirection').value;

  const source =
    direction === 'stock-fridge'
      ? 'stock'
      : 'fridge';

  const available =
    lots
      .filter(lot => {
        const balance =
          lotBalances.get(lot.id);

        return balance
          && balance[source] > 0;
      })
      .sort(
        (a, b) =>
          a.expiry.localeCompare(b.expiry) || a.created_at.localeCompare(b.created_at)
      );

  if (!available.length) {

    const option =
      document.createElement('option');

    option.value = '';

    option.textContent =
      'Nenhum lote disponível';

    select.append(option);

    el('saveTransfer').disabled = true;

    updateTransferBalance();

    return;
  }

  for (const lot of available) {

    const balance =
      lotBalances.get(lot.id);

    const option =
      document.createElement('option');

    option.value = lot.id;

    option.textContent =
      `${lotLabel(lot)} · ${balance[source]} un.`;

    select.append(option);
  }

  el('saveTransfer').disabled = false;

  updateTransferBalance();
}


function updateTransferBalance() {

  const lotId =
    el('transferLot').value;

  const direction =
    el('transferDirection').value;

  const source =
    direction === 'stock-fridge'
      ? 'stock'
      : 'fridge';

  const balance =
    lotBalances.get(lotId);

  el('transferBalance').textContent =
    balance
      ? `Disponível na origem: ${balance[source]} unidade(s).`
      : '';
}

function confirmFefo(context, selected, candidates, args, risk) {
  const list = el('fefoCandidates');
  list.replaceChildren();
  for (const candidate of candidates) {
    const item = document.createElement('p');
    item.textContent = `Lote: ${candidate.code} · Validade: ${dateBR(candidate.expiry)} · Disponível no estoque: ${candidate.stock} unidades`;
    list.append(item);
  }
  el('fefoSelected').textContent = `Você está movimentando: ${lotLabel(selected)} · Validade: ${dateBR(selected.expiry)} · ${args.p_quantity} unidade(s) de estoque seco para geladeira. ${risk} Observação: ${args.p_note || 'Não informada'}.`;
  return context.waitForConfirmation(el('fefoDialog'),'cancelFefo','continueFefo');
}

async function transferStockOperation(event) {
  return runOperation(event, {buttonId:'saveTransfer',messageId:'transferMessage',task:async context => {
    const from = el('transferDirection').value==='stock-fridge' ? 'stock' : 'fridge';
    const to = from==='stock' ? 'fridge' : 'stock';
    const args = {p_shop_id:shop.shop_id,p_lot_id:el('transferLot').value,p_from_location:from,p_to_location:to,
      p_quantity:Number(el('transferQuantity').value),p_note:el('transferNote').value.trim()};
    const selected = lots.find(lot=>lot.id===args.p_lot_id);
    if (!selected) throw Error('Selecione um lote disponível.');
    const risk = quantityRisk(args.p_quantity,lotBalances.get(selected.id)?.[from]);
    let fefoConfirmed = false;
    if (from==='stock') {
      const result = await client.rpc('guigs_get_fefo_candidates',{p_shop_id:shop.shop_id,p_lot_id:args.p_lot_id});
      if (result.error) throw result.error;
      context.ensure();
      if (result.data?.length) {
        if (!await confirmFefo(context,selected,result.data,args,risk)) return;
        fefoConfirmed = true;
      }
    }
    if (risk && !fefoConfirmed && !await confirmOperation(context,'Confirmar movimentação',risk,
      [...lotDetails(selected,args.p_quantity,from,args.p_note),['Destino',locationLabel(to)]])) return;
    const data = await context.write('guigs_transfer_stock',args);
    return `${data.quantity} unidade(s) de ${productById(selected.product_id)?.name} movidas para ${locationLabel(to).toLowerCase()}.`;
  }});
}


// ============================================================
// VENDA
// ============================================================

function populateSaleLots() {

  const select =
    el('saleLot');

  select.replaceChildren();

  const available =
    lots
      .filter(lot => {

        const balance =
          lotBalances.get(lot.id);

        return balance
          && balance.fridge > 0
          && dayDifference(lot.expiry) >= 0;
      })
      .sort(
        (a, b) =>
          a.expiry.localeCompare(b.expiry)
      );

  if (!available.length) {

    const option =
      document.createElement('option');

    option.value = '';

    option.textContent =
      'Nenhum lote disponível na geladeira';

    select.append(option);

    el('saveSale').disabled = true;

    updateSaleBalance();

    return;
  }

  for (const lot of available) {

    const balance =
      lotBalances.get(lot.id);

    const option =
      document.createElement('option');

    option.value = lot.id;

    option.textContent =
      `${lotLabel(lot)} · ${balance.fridge} un.`;

    select.append(option);
  }

  el('saveSale').disabled = false;

  updateSaleBalance();
}


function updateSaleBalance() {

  const balance =
    lotBalances.get(
      el('saleLot').value
    );

  el('saleBalance').textContent =
    balance
      ? `Disponível na geladeira: ${balance.fridge} unidade(s).`
      : '';
}


async function registerSaleOperation(event) {
  return runOperation(event, {buttonId:'saveSale',messageId:'saleMessage',task:async context => {
    const args = {p_shop_id:shop.shop_id,p_lot_id:el('saleLot').value,p_quantity:Number(el('saleQuantity').value),p_note:el('saleNote').value.trim()};
    const lot = lots.find(l=>l.id===args.p_lot_id);
    if (!lot) throw Error('Selecione um lote disponível.');
    const risk = quantityRisk(args.p_quantity,lotBalances.get(lot.id)?.fridge);
    if (risk && !await confirmOperation(context,'Confirmar venda',risk,lotDetails(lot,args.p_quantity,'fridge',args.p_note))) return;
    const data = await context.write('guigs_register_sale',args);
    return `Venda registrada: ${data.quantity} unidade(s) de ${productById(lot.product_id)?.name}.`;
  }});
}


// ============================================================
// PERDA
// ============================================================

function populateLossLots() {

  const select =
    el('lossLot');

  select.replaceChildren();

  for (
    const lot
    of [...lots]
      .sort(
        (a, b) =>
          a.expiry.localeCompare(b.expiry)
      )
  ) {

    const balance =
      lotBalances.get(lot.id);

    if (
      !balance
      ||
      (
        balance.stock <= 0
        &&
        balance.fridge <= 0
      )
    ) {
      continue;
    }

    const option =
      document.createElement('option');

    option.value = lot.id;

    option.textContent =
      lotLabel(lot);

    select.append(option);
  }

  el('saveLoss').disabled =
    !select.value;

  updateLossBalance();
}


function updateLossBalance() {

  const balance =
    lotBalances.get(
      el('lossLot').value
    );

  const location =
    el('lossLocation').value;

  el('lossBalance').textContent =
    balance
      ? `Disponível neste local: ${balance[location]} unidade(s).`
      : '';
}


async function registerLossOperation(event) {
  return runOperation(event, {buttonId:'saveLoss',messageId:'lossMessage',task:async context => {
    const args = {p_shop_id:shop.shop_id,p_lot_id:el('lossLot').value,p_location:el('lossLocation').value,
      p_quantity:Number(el('lossQuantity').value),p_note:el('lossNote').value.trim()};
    const lot = lots.find(l=>l.id===args.p_lot_id);
    if (!lot) throw Error('Selecione um lote disponível.');
    const risk = quantityRisk(args.p_quantity,lotBalances.get(lot.id)?.[args.p_location]);
    if (!await confirmOperation(context,'Confirmar perda',`Confira o descarte antes de registrar. ${risk}`,
      lotDetails(lot,args.p_quantity,args.p_location,args.p_note))) return;
    const data = await context.write('guigs_register_loss',args);
    return `Perda registrada: ${data.quantity} unidade(s) de ${productById(lot.product_id)?.name}.`;
  }});
}


// ============================================================
// AJUSTE DE INVENTÁRIO
// ============================================================

function populateAdjustLots() {

  const select = el('adjustLot');

  select.replaceChildren();

  const available =
    lots
      .filter(lot => lotBalances.has(lot.id))
      .sort((a, b) => a.expiry.localeCompare(b.expiry));

  if (!available.length) {

    const option =
      document.createElement('option');

    option.value = '';

    option.textContent =
      'Nenhum lote disponível';

    select.append(option);

    el('saveAdjust').disabled = true;

    updateAdjustBalance();

    return;
  }

  for (const lot of available) {

    const balance =
      lotBalances.get(lot.id);

    const option =
      document.createElement('option');

    option.value = lot.id;

    option.textContent =
      `${lotLabel(lot)} · estoque ${balance.stock} / geladeira ${balance.fridge}`;

    select.append(option);
  }

  el('saveAdjust').disabled = false;

  updateAdjustBalance();
}


function updateAdjustBalance() {

  const balance =
    lotBalances.get(
      el('adjustLot').value
    );

  const location =
    el('adjustLocation').value;

  const current =
    balance
      ? balance[location]
      : 0;

  el('adjustBalance').textContent =
    balance
      ? `Saldo atual no sistema: ${current} unidade(s).`
      : '';

  el('adjustQuantity').value =
    current;
  updateAdjustImpact();
}

function updateAdjustImpact() {
  const current = lotBalances.get(el('adjustLot').value)?.[el('adjustLocation').value] || 0;
  const next = Number(el('adjustQuantity').value);
  const delta = next - current;
  el('adjustImpact').textContent = Number.isFinite(next) && el('adjustQuantity').value !== ''
    ? `Saldo atual: ${current} · Novo saldo: ${next} · Diferença: ${delta > 0 ? '+' : ''}${delta} unidade(s).`
    : 'Informe a contagem física para conferir a diferença.';
}

el('adjustQuantity').addEventListener('input', updateAdjustImpact);
document.querySelectorAll('[data-attention]').forEach(button => button.addEventListener('click', () => {
  attentionFilter = button.dataset.attention;
  document.querySelectorAll('[data-attention]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  render();
}));


async function adjustStockOperation(event) {
  return runOperation(event, {buttonId:'saveAdjust',messageId:'adjustMessage',owner:true,task:async context => {
    const args = {p_shop_id:shop.shop_id,p_lot_id:el('adjustLot').value,p_location:el('adjustLocation').value,
      p_new_quantity:Number(el('adjustQuantity').value),p_note:el('adjustNote').value.trim()};
    const lot = lots.find(l=>l.id===args.p_lot_id);
    if (!lot) throw Error('Selecione um lote disponível.');
    const current = lotBalances.get(lot.id)?.[args.p_location] || 0;
    const delta = args.p_new_quantity-current;
    if (delta && !await confirmOperation(context,'Confirmar ajuste de estoque','Confira a diferença da contagem física antes de aplicar.',[
      ['Produto',productById(lot.product_id)?.name],['Lote',lot.code],['Local',locationLabel(args.p_location)],
      ['Saldo atual',current],['Novo saldo',args.p_new_quantity],['Diferença',`${delta>0?'+':''}${delta}`],['Motivo / observação',args.p_note]])) return;
    const data = await context.write('guigs_adjust_stock',args);
    return data.changed===false ? 'Nenhuma diferença encontrada. O saldo já estava correto.' : `Ajuste aplicado: ${data.delta>0?'+':''}${data.delta} unidade(s) de ${productById(lot.product_id)?.name}.`;
  }});
}


// ============================================================
// EVENTOS DE INTERFACE
// ============================================================

function applyView() {
  const history = location.hash === '#historico';
  const inventory = location.hash === '#inventario';
  el('overviewView').classList.toggle('hidden', history || inventory);
  el('historyView').classList.toggle('hidden', !history);
  el('inventoryView').classList.toggle('hidden', !inventory);
  document.querySelector('.main').classList.toggle('history-view', history || inventory);
  el('viewTitle').textContent = inventory ? 'Inventário físico' : history ? 'Histórico de movimentações' : 'Painel do estoque';
  for (const [id, active] of [['navOverview', !history && !inventory], ['navHistory', history], ['navInventory',inventory]]) {
    if (active) el(id).setAttribute('aria-current', 'page');
    else el(id).removeAttribute('aria-current');
  }
  if (inventory) inventoryUI.activate();
}

const inventoryUI = createInventoryUI({getContext:()=>({client,shop}),enhanceSelect:enhanceSearchableSelect,
  confirmAction:(title,reason)=>confirmOperation({waitForConfirmation:waitForDialogConfirmation},title,reason,[]),refreshStock:refresh});
window.addEventListener('hashchange', applyView);
applyView();

el('refresh')
  .addEventListener(
    'click',
    () => void refresh()
  );


el('signout')
  .addEventListener(
    'click',
    async () => {

      if (!client) {

        location.replace(
          'auth-preview.html'
        );

        return;
      }


      el('content')
        .classList
        .add('hidden');


      const {
        error
      } = await client.auth.signOut();


      if (error) {

        say(
          'Erro ao sair: '
          + error.message,
          'danger'
        );

      }
      else {

        location.replace(
          'auth-preview.html'
        );
      }
    }
  );

async function applyHistoryFilters() {

  historyPage = 0;


  try {

    await loadHistory();

  }
  catch (e) {

    say(
      'Não foi possível filtrar o histórico: '
      + (e.message || e),
      'danger'
    );
  }
}


el('historyProduct')
  .addEventListener(
    'change',
    event => {

      historyProduct =
        event.target.value;

      void applyHistoryFilters();
    }
  );


el('historyType')
  .addEventListener(
    'change',
    event => {

      historyType =
        event.target.value;

      void applyHistoryFilters();
    }
  );


el('historyActor')
  .addEventListener(
    'change',
    event => {

      historyActor =
        event.target.value;

      void applyHistoryFilters();
    }
  );


el('historyDateFrom')
  .addEventListener(
    'change',
    event => {

      historyDateFrom =
        event.target.value;

      void applyHistoryFilters();
    }
  );


el('historyDateTo')
  .addEventListener(
    'change',
    event => {

      historyDateTo =
        event.target.value;

      void applyHistoryFilters();
    }
  );


el('clearHistoryFilters')
  .addEventListener(
    'click',
    () => {

      historyProduct = '';
      historyType = '';
      historyActor = '';
      historyDateFrom = '';
      historyDateTo = '';
      query = '';


      el('historyProduct').value = '';
      searchableSelects.get('historyProduct')();
      el('historyType').value = '';
      el('historyActor').value = '';
      el('historyDateFrom').value = '';
      el('historyDateTo').value = '';
      el('search').value = '';


      void applyHistoryFilters();
    }
  );

el('search')
  .addEventListener(
    'input',
    event => {

      query =
        event
          .target
          .value;


      historyPage = 0;


      clearTimeout(
        historySearchTimer
      );


      historySearchTimer =
        setTimeout(
          async () => {

            try {
              await loadHistory();
            }
            catch (e) {

              say(
                'Não foi possível pesquisar o histórico: '
                + (e.message || e),
                'danger'
              );
            }

          },
          350
        );
    }
  );


el('prev')
  .addEventListener(
    'click',
    async () => {

      if (historyPage <= 0) {
        return;
      }


      historyPage--;


      try {
        await loadHistory();
      }
      catch (e) {

        historyPage++;

        say(
          'Não foi possível carregar o histórico: '
          + (e.message || e),
          'danger'
        );
      }
    }
  );


el('next')
  .addEventListener(
    'click',
    async () => {

      const pages =
        Math.max(
          1,
          Math.ceil(
            historyTotal / historyPageSize
          )
        );


      if (historyPage >= pages - 1) {
        return;
      }


      historyPage++;


      try {
        await loadHistory();
      }
      catch (e) {

        historyPage--;

        say(
          'Não foi possível carregar o histórico: '
          + (e.message || e),
          'danger'
        );
      }
    }
  );


el('newProduct')
  .addEventListener(
    'click',
    () => {

      formMessage(
        'productMessage'
      );

      el('productDialog')
        .showModal();
    }
  );

el('editProduct')
  .addEventListener(
    'click',
    () => {

      formMessage(
        'editProductMessage'
      );

      populateEditProducts();

      el('editProductDialog')
        .showModal();
    }
  );


el('editProductSelect')
  .addEventListener(
    'change',
    fillEditProductForm
  );


el('editProductForm')
  .addEventListener(
    'submit',
    updateProductOperation
  );

el('receiveStock')
  .addEventListener(
    'click',
    () => {

      formMessage(
        'receiveMessage'
      );

      populateReceiveProducts();
      populateReceiveSuppliers();

      el('receiveDialog')
        .showModal();
    }
  );


document
  .querySelectorAll(
    '[data-close]'
  )
  .forEach(
    button => {

      button
        .addEventListener(
          'click',
          () => {

            const id =
              button.dataset.close;

            el(id).close();
          }
        );
    }
  );


el('productForm')
  .addEventListener(
    'submit',
    createProduct
  );


el('receiveForm')
  .addEventListener(
    'submit',
    receiveStock
  );

el('manageSuppliers').addEventListener('click', openSupplierDialog);
el('newReceiveSupplier').addEventListener('click', openSupplierDialog);
el('supplierSelect').addEventListener('change', fillSupplierForm);
el('supplierForm').addEventListener('submit', saveSupplier);

el('transferStock')
  .addEventListener(
    'click',
    async () => {

      formMessage('transferMessage');

      await refresh();

      populateTransferLots();

      el('transferDialog')
        .showModal();
    }
  );


el('registerSale')
  .addEventListener(
    'click',
    async () => {

      formMessage('saleMessage');

      await refresh();

      populateSaleLots();

      el('saleDialog')
        .showModal();
    }
  );


el('registerLoss')
  .addEventListener(
    'click',
    async () => {

      formMessage('lossMessage');

      await refresh();

      populateLossLots();

      el('lossDialog')
        .showModal();
    }
  );


el('transferDirection')
  .addEventListener(
    'change',
    populateTransferLots
  );


el('transferLot')
  .addEventListener(
    'change',
    updateTransferBalance
  );


el('saleLot')
  .addEventListener(
    'change',
    updateSaleBalance
  );


el('lossLot')
  .addEventListener(
    'change',
    updateLossBalance
  );


el('lossLocation')
  .addEventListener(
    'change',
    updateLossBalance
  );


el('transferForm')
  .addEventListener(
    'submit',
    transferStockOperation
  );



el('saleForm')
  .addEventListener(
    'submit',
    registerSaleOperation
  );


el('lossForm')
  .addEventListener(
    'submit',
    registerLossOperation
  );

el('adjustStock')
  .addEventListener(
    'click',
    async () => {

      formMessage('adjustMessage');

      await refresh();

      populateAdjustLots();

      el('adjustDialog')
        .showModal();
    }
  );


el('adjustLot')
  .addEventListener(
    'change',
    updateAdjustBalance
  );


el('adjustLocation')
  .addEventListener(
    'change',
    updateAdjustBalance
  );


el('adjustForm')
  .addEventListener(
    'submit',
    adjustStockOperation
  );

// ============================================================
// INICIALIZAÇÃO
// ============================================================
window.addEventListener(
  'offline',
  () => {

    setOfflineDashboardState();
  }
);


window.addEventListener(
  'online',
  async () => {

    setOnlineDashboardState();


    say(
      'Conexão restaurada. Atualizando dados…'
    );


    try {

      await refresh();

    }
    catch (error) {

      say(
        'A conexão voltou, mas não foi possível atualizar os dados: '
        + (error.message || error),
        'danger'
      );
    }
  }
);

void bootstrap()
  .catch(fail);
