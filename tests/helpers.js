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
async function open(page, { user = null, store = makeStore(), hash = '', storage = {} } = {}) {
  await page.route('https://telegram.org/js/**', r => r.fulfill({ contentType: 'text/javascript', body: user ? tgStub(user) : '' }));
  await page.route(/localhost:\d+\/store\.json/, r => r.fulfill({ json: store }));
  await page.route('https://fonts.googleapis.com/**', r => r.abort());
  await page.route('https://fonts.gstatic.com/**', r => r.abort());
  if (Object.keys(storage).length) await page.addInitScript(s => { Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v)); }, storage);
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

module.exports = { open, makeStore, product, fakeGitHub };
