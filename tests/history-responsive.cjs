// Build estático e PWA instalada no Edge; API simulada, sem banco ou credenciais reais.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {setTimeout: delay} = require('node:timers/promises');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const {build, files} = require('../scripts/build.cjs');
const {fixture} = require('./browser.cjs');

const controls = [
  ['historyProductSearch', 'Produto'], ['historyType', 'Tipo'], ['historyPartition', 'Localização'],
  ['historyDateFrom', 'Data inicial'], ['historyDateTo', 'Data final'], ['historyActor', 'Responsável'],
  ['search', 'Busca'], ['clearHistoryFilters', 'Limpar filtros']
];
const viewports = [[1920, 1080], [1366, 768], [1280, 800], [1024, 768], [390, 844], [360, 800]];

function extendFixture(legacy = false) {
  const rpc = window.__mockClient.rpc;
  window.__mockClient.rpc = async (name, args) => {
    if (name === 'guigs_get_spatial_history') {
      if (legacy) return {data: null, error: {code: 'PGRST202'}};
      window.__test.calls.push({name, args: structuredClone(args)});
      if (args.p_partition && args.p_partition !== 'stock') return {data: [], error: null};
      return rpc('guigs_get_history', args);
    }
    if (name === 'guigs_list_inventories') return {data: [], error: null};
    if (name === 'guigs_get_shopping_board') {
      return {data: {needs: [], orders: [], suppliers: [], order_counts: {total: 0, draft: 0, pending: 0, awaiting: 0}}, error: null};
    }
    return rpc(name, args);
  };
}

async function geometry(page, expected = controls) {
  return page.evaluate(ids => {
    const grid = document.querySelector('.historyfilters');
    const viewport = document.documentElement.clientWidth;
    const boundary = grid.getBoundingClientRect();
    const problems = [];
    const rects = ids.map(id => {
      const node = document.getElementById(id);
      const box = node.getBoundingClientRect();
      const own = node.closest('.history-filter')?.getBoundingClientRect() || boundary;
      if (!box.width || !box.height || box.left < Math.max(0, own.left) - 0.5 ||
          box.right > Math.min(viewport, own.right) + 0.5) problems.push(id);
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) {
        const r = label.getBoundingClientRect();
        if (!r.height || r.left < own.left - 0.5 || r.right > own.right + 0.5 || label.scrollWidth > label.clientWidth) {
          problems.push(`rótulo: ${id}`);
        }
      }
      return box;
    });
    rects.forEach((a, i) => rects.slice(i + 1).forEach((b, j) => {
      if (a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5) {
        problems.push(`${ids[i]} sobre ${ids[i + j + 1]}`);
      }
    }));
    return {viewport, panel: Math.round(boundary.width), overflow: document.documentElement.scrollWidth - viewport,
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(x => parseFloat(x) > 0).length, problems};
  }, expected.map(([id]) => id));
}

async function keyboardFilters(page) {
  const product = page.getByRole('combobox', {name: 'Produto', exact: true});
  await product.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#historyProduct').inputValue(), 'product-1');
  for (const [previous, next] of controls.slice(1).map(([id], i) => [controls[i][0], id])) {
    // Os inputs de data do Chromium podem ter mais de um segmento tabulável.
    let current;
    for (let tries = 0; tries < 8; tries++) {
      await page.keyboard.press('Tab');
      current = await page.evaluate(() => document.activeElement.id);
      if (current !== previous) break;
    }
    assert.equal(current, next, `Tab de ${previous} para ${next}`);
  }
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'search');
}

async function filterFlow(page) {
  const grid = page.locator('.historyfilters');
  const fieldByLabel = name => grid.getByLabel(name, {exact: true}).and(grid.locator('input, select'));
  for (const [id, label] of controls) {
    const field = id === 'clearHistoryFilters' ? grid.getByRole('button', {name: label, exact: true}) : fieldByLabel(label);
    assert.equal(await field.getAttribute('id'), id, `Nome acessível do campo ${id}`);
    await field.scrollIntoViewIfNeeded();
    assert.ok(await field.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), `${id} visível e sem sobreposição`);
  }
  await keyboardFilters(page);
  await fieldByLabel('Tipo').selectOption('receipt');
  await fieldByLabel('Localização').selectOption('stock');
  await fieldByLabel('Data inicial').fill('2026-10-06');
  await fieldByLabel('Data final').fill('2026-10-08');
  await fieldByLabel('Responsável').selectOption('user-test');
  await fieldByLabel('Busca').fill('Distribuidora teste');
  await page.waitForFunction(() => document.querySelectorAll('#history tr').length === 1 &&
    document.getElementById('history').textContent.includes('Distribuidora teste'));
  const args = await page.evaluate(() => window.__test.calls.filter(c => c.name === 'guigs_get_spatial_history').at(-1).args);
  assert.equal(args.p_product, 'product-1');
  assert.equal(args.p_type, 'receipt');
  assert.equal(args.p_partition, 'stock');
  assert.equal(args.p_actor, 'user-test');
  assert.ok(args.p_date_from && args.p_date_to);
  assert.equal(args.p_search, 'Distribuidora teste');
  await fieldByLabel('Busca').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'clearHistoryFilters');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#history tr').length === 20 &&
    document.getElementById('page').textContent.includes('45 lançamentos'));
  const reset = await page.evaluate(() => window.__test.calls.filter(c => c.name === 'guigs_get_spatial_history').at(-1).args);
  for (const key of ['p_product', 'p_type', 'p_partition', 'p_actor', 'p_date_from', 'p_date_to', 'p_search']) assert.equal(reset[key], null);
  for (const id of ['historyProduct', ...controls.slice(1, -1).map(([id]) => id)]) assert.equal(await page.locator('#' + id).inputValue(), '');
}

async function run() {
  const destination = process.env.TEST_ARTIFACTS_DIR;
  assert.ok(destination && path.isAbsolute(destination), 'Defina TEST_ARTIFACTS_DIR externo a Git.');
  const external = fs.realpathSync(destination);
  for (let p = external;; p = path.dirname(p)) {
    assert.ok(!fs.existsSync(path.join(p, '.git')), 'O teste escreve somente fora de Git.');
    if (path.dirname(p) === p) break;
  }
  const root = fs.mkdtempSync(path.join(external, 'history-'));
  for (const file of files) {
    const out = path.join(root, file);
    fs.mkdirSync(path.dirname(out), {recursive: true});
    fs.copyFileSync(path.join(__dirname, '..', file), out);
  }
  const artifact = build({sourceRoot: root, env: {GUIGS_SUPABASE_URL: 'https://test.supabase.co', GUIGS_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_TEST_ONLY'}});
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://127.0.0.1').pathname.slice(1) || 'index.html';
    if (name === 'fixture-sdk.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end('export const createClient = () => window.__mockClient;');
    }
    if (!artifact.files.includes(name)) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.html') ? 'text/html' : name.endsWith('.png') ? 'image/png' : 'application/manifest+json');
    const bytes = fs.readFileSync(path.join(artifact.directory, name));
    res.end(name.endsWith('.js') ? bytes.toString().replace('https://esm.sh/@supabase/supabase-js@2', './fixture-sdk.js') : bytes);
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const base = `http://127.0.0.1:${server.address().port}`;
  const manifestId = base + '/';
  const evidence = {status: 'FAIL', viewports: [], zoom: [], standalone: [], regressions: []};
  let context, cdp, installed = false;
  try {
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
      headless: false, viewport: {width: 1920, height: 1080}, args: ['--disable-background-networking'],
      executablePath: process.env.BROWSER_EXECUTABLE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const fixtureScript = `(${fixture})(${JSON.stringify({role: 'owner', session: true, readOnly: true})});`;
    await context.addInitScript({content: fixtureScript + `(${extendFixture})(location.search === '?legacy');`});
    const page = context.pages()[0];
    const errors = [];
    context.on('page', opened => opened.on('pageerror', err => errors.push(err.message)));
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(base + '/#historico');
    await page.waitForSelector('#content:not(.hidden)');
    for (const [width, height] of viewports) {
      await page.setViewportSize({width, height});
      const dimensions = await geometry(page);
      evidence.viewports.push({width, height, ...dimensions});
      await page.screenshot({path: path.join(root, `history-${width}.png`), fullPage: true});
      assert.equal(dimensions.overflow, 0, `Overflow em ${width}×${height}`);
      assert.deepEqual(dimensions.problems, [], `Controles em ${width}×${height}`);
      await filterFlow(page);
      evidence.viewports.at(-1).filtersAndKeyboard = 'PASS';
    }
    // Zoom de layout: mesma área útil em pixels CSS que 1280×800 teria a 125%/200%.
    for (const zoom of [1.25, 2]) {
      const width = Math.floor(1280 / zoom), height = Math.floor(800 / zoom);
      await page.setViewportSize({width, height});
      const result = await geometry(page);
      evidence.zoom.push({scale: zoom, width, height, ...result});
      assert.equal(result.overflow, 0, `Zoom equivalente de ${zoom * 100}%`);
      assert.deepEqual(result.problems, []);
    }
    await page.setViewportSize({width: 1024, height: 768});
    await page.goto(base + '/?legacy#historico');
    await page.waitForSelector('#content:not(.hidden)');
    assert.ok(!await page.locator('#historyPartition').isVisible());
    assert.ok(!await page.locator('label[for="historyPartition"]').isVisible());
    const legacy = await geometry(page, controls.filter(([id]) => id !== 'historyPartition'));
    assert.equal(legacy.overflow, 0); assert.deepEqual(legacy.problems, []);
    evidence.regressions.push('Histórico legado: campo e rótulo de localização ocultos, sem overflow');
    await page.goto(base + '/');
    await page.waitForSelector('#content:not(.hidden)');
    for (const [link, view] of [['navOverview', 'overviewView'], ['navFridges', 'fridgesView'],
      ['navInventory', 'inventoryView'], ['navShopping', 'shoppingView'], ['navHistory', 'historyView'], ['navOverview', 'overviewView']]) {
      await page.click('#' + link);
      await page.waitForSelector('#' + view + ':not(.hidden)');
      assert.equal(await page.locator('#' + link).getAttribute('aria-current'), 'page');
      evidence.regressions.push(`Navegação: ${view}`);
    }
    await page.click('#receiveStock'); await page.waitForSelector('#receiveDialog[open]');
    await page.locator('#receiveDialog [data-close="receiveDialog"]').press('Enter');
    await page.waitForSelector('#receiveDialog:not([open])', {state: 'attached'});
    evidence.regressions.push('Modal de recebimento abre e fecha pelo teclado');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    assert.ok(await page.evaluate(async () => (await caches.keys()).includes('guigs-stock-shell-v20')));
    cdp = await context.newCDPSession(page);
    const {installabilityErrors} = await cdp.send('Page.getInstallabilityErrors');
    assert.deepEqual(installabilityErrors, []);
    await cdp.send('PWA.install', {manifestId, installUrlOrBundleUrl: base + '/'});
    installed = true;
    // O Edge pode instalar em modo aba por padrão. A preferência vale só para este app de teste.
    await cdp.send('PWA.changeAppUserSettings', {manifestId, displayMode: 'standalone'});
    const {targetId} = await cdp.send('PWA.launch', {manifestId});
    assert.ok(targetId);
    // O Edge pode abrir um target intermediário. Identifique a janela pelo modo efetivo.
    let standalone;
    for (let tries = 0; !standalone && tries < 50; tries++) {
      for (const opened of context.pages()) {
        if (opened === page || !opened.url().startsWith(base + '/')) continue;
        if (await opened.evaluate(() => matchMedia('(display-mode: standalone)').matches).catch(() => false)) {
          standalone = opened;
          break;
        }
      }
      if (!standalone) await delay(200);
    }
    if (!standalone) {
      evidence.launchTarget = await cdp.send('Target.getTargetInfo', {targetId}).catch(error => ({error: error.message}));
      evidence.launchPages = await Promise.all(context.pages().map(async opened => ({url: opened.url(),
        mode: await opened.evaluate(() => ['browser', 'standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay']
          .find(mode => matchMedia(`(display-mode: ${mode})`).matches)).catch(() => null)})));
    }
    assert.ok(standalone, 'Janela instalada do Edge com display-mode standalone não encontrada');
    await standalone.waitForSelector('#content:not(.hidden)');
    assert.ok(await standalone.evaluate(() => matchMedia('(display-mode: standalone)').matches));
    await standalone.click('#navHistory');
    for (const [width, height] of [[1024, 768], [1280, 800]]) {
      await standalone.setViewportSize({width, height});
      const result = await geometry(standalone);
      evidence.standalone.push({width, height, ...result});
      assert.equal(result.overflow, 0); assert.deepEqual(result.problems, []);
      await standalone.screenshot({path: path.join(root, `pwa-${width}.png`), fullPage: true});
      await filterFlow(standalone);
      evidence.standalone.at(-1).filtersAndKeyboard = 'PASS';
    }
    await standalone.close();
    await context.setOffline(true);
    await page.waitForFunction(() => !navigator.onLine);
    const offlineShell = await page.goto(base + '/auth-preview.html', {waitUntil: 'domcontentloaded'});
    assert.ok(offlineShell?.ok() && offlineShell.fromServiceWorker(), 'Shell offline servido pelo service worker');
    assert.match(await page.locator('#message').textContent(), /sem conexão/i);
    await context.setOffline(false);
    assert.deepEqual(errors, []);
    evidence.regressions.push('PWA v20: instalação, standalone, cache, navegação offline e console');
    evidence.status = 'PASS';
    console.log('Histórico: 6 resoluções, 2 larguras equivalentes a zoom e 2 resoluções em PWA instalada passaram.');
  } catch (error) {
    evidence.error = error.message;
    throw error;
  } finally {
    if (installed) await cdp.send('PWA.uninstall', {manifestId}).catch(() => {});
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(root, 'history-results.json'), JSON.stringify(evidence, null, 2));
    console.log(`Evidência externa: ${path.join(root, 'history-results.json')}`);
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
