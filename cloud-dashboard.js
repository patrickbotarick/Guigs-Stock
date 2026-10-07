import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const el = id => document.getElementById(id);

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
let receiptPending = false;
let transferPending = false;
let transferDialogVersion = 0;

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
    'saveTransfer'
  ];

  for (const id of ids) {

    const node =
      el(id);

    if (node) {
      node.disabled = true;
    }
  }
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
  if (el('transferDialog').open && !transferPending) populateTransferLots();
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

  node.className = good
    ? 'formmsg good'
    : 'formmsg';
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


    say(
      'Estoque sincronizado com o Supabase.',
      'good'
    );

  }
  catch (e) {

    fail(e);
  }
  finally {

    el('refresh').disabled = !navigator.onLine;
  }
}


// ============================================================
// RENDERIZAÇÃO DO DASHBOARD
// ============================================================

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

  // ALERTAS OPERACIONAIS

  const alerts = [];


  for (const p of products) {

    if (!p.active) {
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


  for (const l of lotList) {

    if (l.days < 0) {

      alerts.push({
        level: 'danger',
        title: `${l.product} possui lote vencido`,
        description:
          `Lote ${l.code} · ${l.qty} unidade(s) · validade ${dateBR(l.expiry)}.`
      });

    }
    else if (l.days <= 15) {

      alerts.push({
        level: 'warning',
        title: `${l.product} próximo do vencimento`,
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
        alert.level === 'danger'
          ? 'Urgente'
          : 'Atenção';


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
    of [...products]
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
    }


    cell(
      r,
      p.name
    );


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


  if (!products.length) {

    empty(
      pt,
      'Nenhuma bebida cadastrada.',
      5
    );
  }


  el('productCount').textContent =
    products.length
    + ' produtos';


  // LOTES

  const lt =
    el('lots');


  lt.replaceChildren();


  for (
    const l
    of lotList
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
      'Normal';


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


  if (!lotList.length) {

    empty(
      lt,
      'Nenhum lote com unidades registradas.',
      4
    );
  }


  el('lotCount').textContent =
    lotList.length
    + ' lotes com saldo';


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

  event.preventDefault();


  formMessage(
    'productMessage'
  );


  const button =
    el('saveProduct');


  button.disabled = true;


  try {

    const args = {

      p_shop_id:
        shop.shop_id,

      p_name:
        el('productName')
          .value
          .trim(),

      p_category:
        el('productCategory')
          .value,

      p_min_total:
        Number(
          el('minTotal')
            .value
        ),

      p_target_total:
        Number(
          el('targetTotal')
            .value
        ),

      p_min_fridge:
        Number(
          el('minFridge')
            .value
        ),

      p_target_fridge:
        Number(
          el('targetFridge')
            .value
        )

    };


    const {
      data,
      error
    } = await client.rpc(
      'guigs_create_product',
      args
    );


    if (error) {
      throw error;
    }


    formMessage(
      'productMessage',
      'Produto cadastrado com sucesso.',
      true
    );


    console.info(
      'Produto criado:',
      data
    );


    await refresh();


    setTimeout(
      () => {

        el('productDialog')
          .close();

        el('productForm')
          .reset();

      },
      500
    );

  }
  catch (e) {

    formMessage(
      'productMessage',
      e.message
      || 'Não foi possível cadastrar o produto.'
    );
  }
  finally {

    button.disabled = false;
  }
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

  event.preventDefault();


  formMessage(
    'editProductMessage'
  );


  const button =
    el('saveProductEdit');


  button.disabled = true;


  try {

    const {
      data,
      error
    } = await client.rpc(
      'guigs_update_product',
      {

        p_shop_id:
          shop.shop_id,

        p_product_id:
          el('editProductSelect').value,

        p_name:
          el('editProductName')
            .value
            .trim(),

        p_category:
          el('editProductCategory')
            .value,

        p_min_total:
          Number(
            el('editMinTotal').value
          ),

        p_target_total:
          Number(
            el('editTargetTotal').value
          ),

        p_min_fridge:
          Number(
            el('editMinFridge').value
          ),

        p_target_fridge:
          Number(
            el('editTargetFridge').value
          ),

        p_active:
          el('editProductActive').value
          === 'true'

      }
    );


    if (error) {
      throw error;
    }


    formMessage(
      'editProductMessage',
      data
        ? 'Produto atualizado com sucesso.'
        : 'Nenhuma alteração realizada.',
      true
    );


    await refresh();


    setTimeout(
      () => {

        el('editProductDialog')
          .close();

      },
      500
    );

  }
  catch (e) {

    formMessage(
      'editProductMessage',
      e.message
      || 'Não foi possível atualizar o produto.'
    );

  }
  finally {

    button.disabled = false;
  }
}

// ============================================================
// RECEBIMENTO
// ============================================================

async function receiveStock(event) {

  event.preventDefault();
  if (receiptPending || el('saveReceipt').disabled) return;
  receiptPending = true;


  formMessage(
    'receiveMessage'
  );


  const button =
    el('saveReceipt');


  button.disabled = true;


  try {
    requireOnline();
    if (!el('receiveSupplier').value) throw Error('Selecione um fornecedor ativo.');

    const args = {

      p_shop_id:
        shop.shop_id,

      p_product_id:
        el('receiveProduct')
          .value,
      p_supplier_id: el('receiveSupplier').value,

      p_lot_code:
        el('lotCode')
          .value
          .trim(),

      p_expiry:
        el('expiry')
          .value,

      p_quantity:
        Number(
          el('receiveQuantity')
            .value
        ),

      p_note:
        el('receiveNote')
          .value
          .trim()

    };


    const {
      data,
      error
    } = await client.rpc(
      'guigs_receive_stock',
      args
    );


    if (error) {
      throw error;
    }


    formMessage(
      'receiveMessage',
      `Recebimento registrado: ${data.quantity} unidade(s).`,
      true
    );


    await refresh();


    setTimeout(
      () => {

        el('receiveDialog')
          .close();

        el('receiveForm')
          .reset();

        populateReceiveProducts();
        populateReceiveSuppliers();

      },
      500
    );

  }
  catch (e) {

    formMessage(
      'receiveMessage',
      e.message
      || 'Não foi possível registrar o recebimento.'
    );
  }
  finally {

    receiptPending = false;
    populateReceiveSuppliers();
  }
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
  el('saveReceipt').disabled = receiptPending || !navigator.onLine || !products.some(p => p.active) || !suppliers.some(s => s.active);
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
  event.preventDefault();
  const button = el('saveSupplier');
  if (button.disabled || shop?.role !== 'owner') return;
  button.disabled = true;
  formMessage('supplierMessage');
  try {
    requireOnline();
    const id = el('supplierSelect').value;
    const args = {p_shop_id: shop.shop_id, p_name: el('supplierName').value.trim(), p_active: el('supplierActive').value === 'true'};
    if (id) args.p_supplier_id = id;
    const {data, error} = await client.rpc(id ? 'guigs_update_supplier' : 'guigs_create_supplier', args);
    if (error) throw error;
    suppliers = await allRows('guigs_suppliers', 'id,name,active,created_at');
    populateReceiveSuppliers(args.p_active ? (id || data) : '');
    render();
    el('supplierDialog').close();
    say('Fornecedor salvo.', 'good');
  } catch (error) {
    formMessage('supplierMessage', error.message || 'Não foi possível salvar o fornecedor.');
  } finally {
    button.disabled = !navigator.onLine;
  }
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

function confirmFefo(selected, candidates) {
  const list = el('fefoCandidates');
  list.replaceChildren();
  for (const candidate of candidates) {
    const item = document.createElement('p');
    item.textContent = `Lote: ${candidate.code} · Validade: ${dateBR(candidate.expiry)} · Disponível no estoque: ${candidate.stock} unidades`;
    list.append(item);
  }
  el('fefoSelected').textContent = `Você está movimentando: ${lotLabel(selected)} · Validade: ${dateBR(selected.expiry)}.`;
  const dialog = el('fefoDialog');
  return new Promise(resolve => {
    const cancel = () => dialog.close('cancel');
    const proceed = () => dialog.close('continue');
    const closed = () => {
      el('cancelFefo').removeEventListener('click', cancel);
      el('continueFefo').removeEventListener('click', proceed);
      resolve(dialog.returnValue === 'continue');
    };
    dialog.returnValue = 'cancel';
    el('cancelFefo').addEventListener('click', cancel);
    el('continueFefo').addEventListener('click', proceed);
    dialog.addEventListener('close', closed, {once: true});
    dialog.showModal();
    el('cancelFefo').focus();
  });
}

async function transferStockOperation(event) {

  event.preventDefault();

  formMessage('transferMessage');

  const button =
    el('saveTransfer');
  if (transferPending || button.disabled) return;
  transferPending = true;

  button.disabled = true;

  try {
    requireOnline();

    const direction =
      el('transferDirection').value;

    const from =
      direction === 'stock-fridge'
        ? 'stock'
        : 'fridge';

    const to =
      direction === 'stock-fridge'
        ? 'fridge'
        : 'stock';

    // Captura o lote/quantidade antes da consulta e mantém a escolha ao confirmar.
    const args = {
      p_shop_id: shop.shop_id,
      p_lot_id: el('transferLot').value,
      p_from_location: from,
      p_to_location: to,
      p_quantity: Number(el('transferQuantity').value),
      p_note: el('transferNote').value.trim()
    };
    const selected = lots.find(lot => lot.id === args.p_lot_id);
    if (!selected) throw Error('Selecione um lote disponível.');
    const dialogVersion = transferDialogVersion;
    if (from === 'stock' && to === 'fridge') {
      const result = await client.rpc('guigs_get_fefo_candidates', {
        p_shop_id: shop.shop_id, p_lot_id: args.p_lot_id
      });
      if (result.error) throw result.error;
      if (!el('transferDialog').open || dialogVersion !== transferDialogVersion) return;
      if (result.data?.length && !await confirmFefo(selected, result.data)) return;
    }
    requireOnline();

    const {
      data,
      error
    } = await client.rpc(
      'guigs_transfer_stock',
      args
    );

    if (error) {
      throw error;
    }

    formMessage(
      'transferMessage',
      `Movimentação concluída: ${data.quantity} unidade(s).`,
      true
    );

    await refresh();

    setTimeout(
      () => {
        el('transferDialog').close();
        el('transferForm').reset();
      },
      500
    );

  }
  catch (e) {

    formMessage(
      'transferMessage',
      e.message
      || 'Não foi possível realizar a movimentação.'
    );

  }
  finally {

    transferPending = false;
    button.disabled = !navigator.onLine;
  }
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

  event.preventDefault();

  formMessage('saleMessage');

  const button =
    el('saveSale');

  button.disabled = true;

  try {

    const {
      data,
      error
    } = await client.rpc(
      'guigs_register_sale',
      {
        p_shop_id:
          shop.shop_id,

        p_lot_id:
          el('saleLot').value,

        p_quantity:
          Number(
            el('saleQuantity').value
          ),

        p_note:
          el('saleNote')
            .value
            .trim()
      }
    );

    if (error) {
      throw error;
    }

    formMessage(
      'saleMessage',
      `Venda registrada: ${data.quantity} unidade(s).`,
      true
    );

    await refresh();

    setTimeout(
      () => {
        el('saleDialog').close();
        el('saleForm').reset();
      },
      500
    );

  }
  catch (e) {

    formMessage(
      'saleMessage',
      e.message
      || 'Não foi possível registrar a venda.'
    );

  }
  finally {

    button.disabled = false;
  }
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

  event.preventDefault();

  formMessage('lossMessage');

  const button =
    el('saveLoss');

  button.disabled = true;

  try {

    const {
      data,
      error
    } = await client.rpc(
      'guigs_register_loss',
      {
        p_shop_id:
          shop.shop_id,

        p_lot_id:
          el('lossLot').value,

        p_location:
          el('lossLocation').value,

        p_quantity:
          Number(
            el('lossQuantity').value
          ),

        p_note:
          el('lossNote')
            .value
            .trim()
      }
    );

    if (error) {
      throw error;
    }

    formMessage(
      'lossMessage',
      `Perda registrada: ${data.quantity} unidade(s).`,
      true
    );

    await refresh();

    setTimeout(
      () => {
        el('lossDialog').close();
        el('lossForm').reset();
      },
      500
    );

  }
  catch (e) {

    formMessage(
      'lossMessage',
      e.message
      || 'Não foi possível registrar a perda.'
    );

  }
  finally {

    button.disabled = false;
  }
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
}


async function adjustStockOperation(event) {

  event.preventDefault();

  formMessage('adjustMessage');

  const button =
    el('saveAdjust');

  button.disabled = true;

  try {

    const {
      data,
      error
    } = await client.rpc(
      'guigs_adjust_stock',
      {
        p_shop_id:
          shop.shop_id,

        p_lot_id:
          el('adjustLot').value,

        p_location:
          el('adjustLocation').value,

        p_new_quantity:
          Number(
            el('adjustQuantity').value
          ),

        p_note:
          el('adjustNote')
            .value
            .trim()
      }
    );

    if (error) {
      throw error;
    }

    if (data.changed === false) {

      formMessage(
        'adjustMessage',
        'Nenhuma diferença encontrada. O saldo já estava correto.',
        true
      );

    } else {

      formMessage(
        'adjustMessage',
        `Ajuste aplicado: ${data.delta > 0 ? '+' : ''}${data.delta} unidade(s).`,
        true
      );
    }

    await refresh();

    setTimeout(
      () => {
        el('adjustDialog').close();
        el('adjustForm').reset();
      },
      500
    );

  }
  catch (e) {

    formMessage(
      'adjustMessage',
      e.message
      || 'Não foi possível ajustar o inventário.'
    );

  }
  finally {

    button.disabled = false;
  }
}

// ============================================================
// EVENTOS DE INTERFACE
// ============================================================

function applyView() {
  const history = location.hash === '#historico';
  el('overviewView').classList.toggle('hidden', history);
  el('historyView').classList.toggle('hidden', !history);
  document.querySelector('.main').classList.toggle('history-view', history);
  el('viewTitle').textContent = history ? 'Histórico de movimentações' : 'Painel do estoque';
  for (const [id, active] of [['navOverview', !history], ['navHistory', history]]) {
    if (active) el(id).setAttribute('aria-current', 'page');
    else el(id).removeAttribute('aria-current');
  }
}

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
el('transferDialog').addEventListener('close', () => { transferDialogVersion++; });


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
