const BRANDS = {
  si: { name: 'Stone Island', mono: 'SI' },
  cp: { name: 'C.P. Company', mono: 'CP' },
  empty: { name: 'Без вещей', mono: 'BV' },
};
const product = (id, extra = {}) => ({ id, brand: 'si', kind: 'худи', title: 'Худи ' + id, size: 'M', fit: ['M'], cond: 9, price: 12790, seller: 'ambssl', status: 'stock', photos: [], ...extra });
const makeStore = (products = [], settings = {}) => ({
  settings: { appLink: 'https://t.me/bot/shop', contact: 'ambssl', buyer: 'ambssl', featured: '', tape: ['Архив'], admins: ['workpagerepetitor', 'ambssl'], ...settings },
  brands: BRANDS,
  products,
});

const tgStub = user => `window.Telegram = { WebApp: {
  initData: 'signed', initDataUnsafe: { user: ${JSON.stringify(user)} },
  ready() {}, expand() {}, isVersionAtLeast: () => false, openTelegramLink() {}, openLink() {},
} };`;

// Открывает сайт: настоящий index.html, подставные Telegram и store.json
async function open(page, { user = null, store = makeStore(), hash = '', storage = {}, api = '' } = {}) {
  await page.route('https://telegram.org/js/**', r => r.fulfill({ contentType: 'text/javascript', body: user ? tgStub(user) : '' }));
  await page.route(/localhost:\d+\/store\.json/, r => r.fulfill({ json: store }));
  if (Object.keys(storage).length) await page.addInitScript(s => { Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v)); }, storage);
  if (api) {
    await page.route(/localhost:\d+\/index\.html/, async r => {
      const res = await r.fetch();
      r.fulfill({ response: res, body: (await res.text()).replace("api: '',", `api: '${api}',`) });
    });
  }
  await page.goto('index.html' + hash);
  await page.waitForFunction(() => document.querySelector('#stats dd').textContent !== '··');
}

// Репозиторий GitHub в памяти, для админки с токеном
function fakeGitHub(page, start) {
  const repo = { store: JSON.parse(JSON.stringify(start)), trees: [], messages: [] };
  const b64 = s => Buffer.from(s, 'utf8').toString('base64');
  return page.route('https://api.github.com/repos/**', async route => {
    const req = route.request();
    const path = req.url().replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, '');
    const method = req.method();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH', 'access-control-allow-headers': 'authorization,content-type,accept,x-github-api-version' };
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const json = data => route.fulfill({ json: data, headers });
    if (path === '') return json({});
    if (path.startsWith('/git/ref/')) return json({ object: { sha: 'head' } });
    if (path.startsWith('/contents/store.json')) return json({ content: b64(JSON.stringify(repo.store)) });
    if (method === 'GET' && path.startsWith('/git/commits/')) return json({ tree: { sha: 'tree' } });
    if (method === 'GET' && path.startsWith('/git/trees/')) return json({ tree: [] });
    const body = req.postDataJSON();
    if (path === '/git/blobs') return json({ sha: 'blob' });
    if (path === '/git/trees') {
      repo.trees.push(body.tree);
      const next = body.tree.find(e => e.path === 'store.json');
      repo.pending = JSON.parse(next.content);
      return json({ sha: 'newtree' });
    }
    if (path === '/git/commits') { repo.messages.push(body.message); return json({ sha: 'newcommit' }); }
    if (path.startsWith('/git/refs/')) { repo.store = repo.pending; return json({}); }
    return route.fulfill({ status: 404, json: {}, headers });
  }).then(() => repo);
}

// Сервер магазина в памяти: отвечает так же, как Worker
function fakeWorker(page, start, { admin = true, channel = false, down = false } = {}) {
  const srv = { store: JSON.parse(JSON.stringify(start)), calls: [], photos: 0 };
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE', 'access-control-allow-headers': 'authorization,content-type' };
  return page.route('https://api.test/**', async route => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (down) return route.abort();
    const path = new URL(req.url()).pathname;
    const body = req.postDataJSON();
    srv.calls.push({ method, path, body, auth: req.headers().authorization });
    const json = (data, status = 200) => route.fulfill({ json: data, status, headers });
    if (path === '/me') return json({ admin });
    if (!admin) return json({ error: 'forbidden' }, 403);
    if (path === '/store') return json({ store: srv.store, channel });
    if (path === '/photos') return json({ path: `img/srv-${++srv.photos}.jpg`, sha: 'a'.repeat(40) });
    const m = path.match(/^\/products\/([^/]+)(\/status)?$/);
    if (m && method === 'PUT') {
      if (body.seller === 'taken_conflict') return json({ error: 'conflict' }, 409);
      const i = srv.store.products.findIndex(p => p.id === m[1]);
      const { uploads, newBrand, publish, ...p } = body;
      if (i >= 0) srv.store.products[i] = p; else srv.store.products.unshift(p);
      return json({ store: srv.store, ...(publish ? { published: !srv.failPublish } : {}) });
    }
    if (m && method === 'PATCH') { srv.store.products.find(p => p.id === m[1]).status = body.status; return json({ store: srv.store }); }
    if (m && method === 'DELETE') { srv.store.products = srv.store.products.filter(p => p.id !== m[1]); return json({ store: srv.store }); }
    if (path === '/settings') { Object.assign(srv.store.settings, body); return json({ store: srv.store }); }
    return json({ error: 'not_found' }, 404);
  }).then(() => srv);
}

module.exports = { open, makeStore, product, fakeGitHub, fakeWorker };
