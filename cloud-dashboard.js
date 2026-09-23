import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const el = id => document.getElementById(id);

const cfg = window.GUIGS_SUPABASE_CONFIG || {};

let client = null;

let shop = null;

let products = [];
let lots = [];
let moves = [];

let historyPage = 0;
let query = '';

let requestCounter = 0;


// ============================================================
// HELPERS
// ============================================================

function say(message, kind = '') {
  el('status').textContent = message;
  el('status').className = 'notice ' + kind;
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
}


// ============================================================
// ATUALIZAÇÃO DOS DADOS
// ============================================================

async function refresh() {

  if (!shop) return;


  const ticket =
    ++requestCounter;


  el('refresh').disabled = true;


  say(
    'Atualizando dados do estoque…'
  );


  try {

    const [p, l, m] =
      await Promise.all([

        allRows(
          'guigs_products',
          'id,name,category,min_total,target_total,min_fridge,target_fridge,active'
        ),

        allRows(
          'guigs_lots',
          'id,product_id,code,expiry'
        ),

        allRows(
          'guigs_movements',
          'id,lot_id,event_id,movement_type,location,delta,actor_id,note,created_at'
        )

      ]);


    if (ticket !== requestCounter) {
      return;
    }


    products = p;
    lots = l;
    moves = m;


    render();

    populateReceiveProducts();


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

    el('refresh').disabled = false;
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


  const balance =
    new Map(
      lots.map(
        l => [
          l.id,
          {
            stock: 0,
            fridge: 0
          }
        ]
      )
    );


  for (const m of moves) {

    if (
      !balance.has(m.lot_id)
      ||
      !['stock', 'fridge']
        .includes(m.location)
      ||
      !Number.isSafeInteger(m.delta)
    ) {

      throw Error(
        'Movimentação inconsistente no banco de dados.'
      );
    }


    balance
      .get(m.lot_id)[m.location]
      += m.delta;
  }


  if (
    [...balance.values()]
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
      balance.get(l.id);


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


  el('total').textContent =
    stock + fridge;

  el('stock').textContent =
    stock;

  el('fridge').textContent =
    fridge;

  el('expiring').textContent =
    near;


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


    cell(
      r,
      p.name
      +
      (
        p.active
          ? ''
          : ' (inativo)'
      )
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
      b.stock + b.fridge,
      'num'
    );
  }


  if (!products.length) {

    empty(
      pt,
      'Nenhuma bebida cadastrada.',
      4
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


    cell(
      r,
      dateBR(l.expiry)
    );


    cell(
      r,
      l.qty,
      'num'
    );


    cell(
      r,
      l.days < 0
        ? 'Vencido'
        : l.days <= 15
          ? 'Urgente'
          : l.days <= 30
            ? 'Atenção'
            : 'Normal'
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
    `Atualizado em ${
      new Date()
        .toLocaleString('pt-BR')
    }.`;


  renderHistory(
    lotMap,
    productMap
  );
}


// ============================================================
// HISTÓRICO
// ============================================================

function renderHistory(
  lotMap =
    new Map(
      lots.map(
        l => [l.id, l]
      )
    ),
  productMap =
    new Map(
      products.map(
        p => [p.id, p]
      )
    )
) {

  const ordered =
    [...moves]
      .sort(
        (a, b) =>
          b.created_at.localeCompare(
            a.created_at
          )
          ||
          b.id.localeCompare(a.id)
      );


  const visible =
    ordered.filter(
      m => {

        const l =
          lotMap.get(m.lot_id);


        const p =
          productMap.get(
            l?.product_id
          );


        return [
          p?.name,
          l?.code,
          m.movement_type,
          m.note
        ].some(
          v =>
            String(v || '')
              .toLocaleLowerCase(
                'pt-BR'
              )
              .includes(query)
        );
      }
    );


  const pages =
    Math.max(
      1,
      Math.ceil(
        visible.length / 20
      )
    );


  historyPage =
    Math.min(
      historyPage,
      pages - 1
    );


  const ht =
    el('history');


  ht.replaceChildren();


  for (
    const m
    of visible.slice(
      historyPage * 20,
      historyPage * 20 + 20
    )
  ) {

    const l =
      lotMap.get(m.lot_id);


    const p =
      productMap.get(
        l?.product_id
      );


    const r =
      ht.insertRow();


    cell(
      r,
      timestamp(m.created_at)
    );


    cell(
      r,
      (p?.name || 'Desconhecido')
      + ' · '
      + (l?.code || '—')
    );


    cell(
      r,
      {
        receipt: 'Recebimento',
        transfer: 'Transferência',
        return: 'Devolução',
        sale: 'Venda',
        loss: 'Perda',
        adjust: 'Ajuste'
      }[m.movement_type]
      || m.movement_type
    );


    cell(
      r,
      m.location === 'stock'
        ? 'Estoque'
        : 'Geladeira'
    );


    cell(
      r,
      (m.delta > 0 ? '+' : '')
      + m.delta,
      'num'
    );
  }


  if (!visible.length) {

    empty(
      ht,
      'Nenhuma movimentação encontrada.',
      5
    );
  }


  el('page').textContent =
    `${historyPage + 1}/${pages}`
    + ` · ${visible.length} lançamentos`;


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
// RECEBIMENTO
// ============================================================

async function receiveStock(event) {

  event.preventDefault();


  formMessage(
    'receiveMessage'
  );


  const button =
    el('saveReceipt');


  button.disabled = true;


  try {

    const args = {

      p_shop_id:
        shop.shop_id,

      p_product_id:
        el('receiveProduct')
          .value,

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

    button.disabled = false;
  }
}


// ============================================================
// EVENTOS DE INTERFACE
// ============================================================

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


el('search')
  .addEventListener(
    'input',
    event => {

      query =
        event
          .target
          .value
          .toLocaleLowerCase(
            'pt-BR'
          );

      historyPage = 0;

      renderHistory();
    }
  );


el('prev')
  .addEventListener(
    'click',
    () => {

      historyPage--;

      renderHistory();
    }
  );


el('next')
  .addEventListener(
    'click',
    () => {

      historyPage++;

      renderHistory();
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


el('receiveStock')
  .addEventListener(
    'click',
    () => {

      formMessage(
        'receiveMessage'
      );

      populateReceiveProducts();

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


// ============================================================
// INICIALIZAÇÃO
// ============================================================

void bootstrap()
  .catch(fail);