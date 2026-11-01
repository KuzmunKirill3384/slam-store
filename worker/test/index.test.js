import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker, { verifyInitData, isAdmin, photoExt, cleanProduct, postCaption } from '../src/index.js';

const BOT = '123:test-bot-token';
const NOW = () => Math.floor(Date.now() / 1000);

function sign(fields, token = BOT) {
  const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
}
const initData = (user, opts = {}) => sign({ auth_date: String(opts.at ?? NOW()), user: JSON.stringify(user), query_id: 'q' }, opts.token);

const OWNER = { id: 1, username: 'WorkPageRepetitor' };
const SECOND = { id: 2, username: 'ambssl' };
const STRANGER = { id: 3, username: 'q1ban' };

function memoryKV() {
  const m = new Map();
  return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } };
}

/* Репозиторий в памяти вместо GitHub и Telegram */
let repo, tgCalls, failRefs, realFetch, tgFails;

function installFakes() {
  repo = {
    head: 'c0',
    commits: { c0: { tree: 't0' } },
    trees: { t0: { 'store.json': JSON.stringify({ settings: { contact: 'x', featured: 'a', admins: ['old'] }, brands: { si: { name: 'Stone Island', mono: 'SI' } }, products: [] }), 'index.html': '<html>' } },
    n: 0,
  };
  tgCalls = [];
  failRefs = 0;
  tgFails = false;
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.startsWith('https://api.telegram.org/')) {
      const method = url.split('/').pop();
      tgCalls.push({ method, body });
      if (tgFails) return json({ ok: false, description: 'fail' });
      return json({ ok: true, result: method === 'sendMediaGroup' ? [{ message_id: 77 }] : { message_id: 77 } });
    }
    const path = url.replace('https://api.github.com/repos/KuzmunKirill3384/slam-store', '');
    const method = opts.method || 'GET';
    if (path === '/git/ref/heads/main') return json({ object: { sha: repo.head } });
    if (path.startsWith('/contents/store.json')) {
      const sha = path.split('ref=')[1];
      const content = repo.trees[repo.commits[sha].tree]['store.json'];
      return json({ content: btoa(String.fromCharCode(...new TextEncoder().encode(content))) });
    }
    if (method === 'GET' && path.startsWith('/git/commits/')) return json({ tree: { sha: repo.commits[path.split('/').pop()].tree } });
    if (method === 'GET' && path.startsWith('/git/trees/')) {
      const id = path.split('/').pop().split('?')[0];
      return json({ tree: Object.keys(repo.trees[id]).map(p => ({ path: p })) });
    }
    if (path === '/git/blobs') return json({ sha: 'b'.repeat(40) });
    if (path === '/git/trees') {
      const tree = { ...repo.trees[body.base_tree] };
      for (const e of body.tree) {
        if (e.sha === null) delete tree[e.path];
        else tree[e.path] = e.content ?? e.sha;
      }
      const id = 't' + ++repo.n;
      repo.trees[id] = tree;
      return json({ sha: id });
    }
    if (path === '/git/commits') {
      const id = 'c' + ++repo.n;
      repo.commits[id] = { tree: body.tree, message: body.message };
      return json({ sha: id });
    }
    if (path === '/git/refs/heads/main') {
      if (failRefs > 0) { failRefs--; return json({ message: 'not fast forward' }, 422); }
      repo.head = body.sha;
      return json({});
    }
    throw new Error('unexpected request ' + url);
  };
}

const files = () => repo.trees[repo.commits[repo.head].tree];
const stored = () => JSON.parse(files()['store.json']);

function makeEnv(extra = {}) {
  return {
    BOT_TOKEN: BOT, GITHUB_TOKEN: 'gh', GITHUB_REPO: 'KuzmunKirill3384/slam-store', BRANCH: 'main',
    ALLOWED_ORIGIN: 'https://kuzmunkirill3384.github.io', SITE_URL: 'https://site/', APP_LINK: 'https://t.me/bot/shop',
    ADMINS: 'workpagerepetitor,ambssl', CHANNEL: '', WEBHOOK_SECRET: 'hook', KV: memoryKV(), ...extra,
  };
}

async function call(env, method, path, { user = OWNER, body, auth, origin } = {}) {
  const headers = {};
  if (auth !== undefined) headers.Authorization = auth;
  else if (user) headers.Authorization = 'tma ' + initData(user);
  if (origin) headers.Origin = origin;
  if (body) headers['Content-Type'] = 'application/json';
  const r = await worker.fetch(new Request('https://api.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, headers: r.headers, data: r.status === 204 ? null : await r.json() };
}

const item = (extra = {}) => ({ brand: 'si', title: 'Худи', size: 'M', fit: ['M'], cond: 9, price: 1000, seller: 'ambssl', status: 'stock', photos: [], ...extra });

beforeEach(installFakes);
afterEach(() => { globalThis.fetch = realFetch; });

/* ---------- Подпись ---------- */
test('верная подпись даёт пользователя', async () => {
  const u = await verifyInitData(initData(OWNER), BOT);
  assert.equal(u.id, 1);
});

test('подпись чужого бота не проходит', async () => {
  assert.equal(await verifyInitData(initData(OWNER, { token: '999:other' }), BOT), null);
});

test('подмена пользователя при старой подписи не проходит', async () => {
  const params = new URLSearchParams(initData(STRANGER));
  params.set('user', JSON.stringify(OWNER));
  assert.equal(await verifyInitData(params.toString(), BOT), null);
});

test('просроченная подпись не проходит', async () => {
  assert.equal(await verifyInitData(initData(OWNER, { at: NOW() - 90000 }), BOT), null);
});

test('подпись из будущего и мусор не проходят', async () => {
  assert.equal(await verifyInitData(initData(OWNER, { at: NOW() + 3600 }), BOT), null);
  assert.equal(await verifyInitData('hash=zz&user=1', BOT), null);
  assert.equal(await verifyInitData('', BOT), null);
});

/* ---------- Админы ---------- */
test('регистр username не важен, ID закрепляется при первом входе', async () => {
  const env = makeEnv();
  assert.equal(await isAdmin(env, OWNER), true);
  assert.equal(env.KV.m.get('admin:workpagerepetitor'), '1');
});

test('чужой человек с занятым username не становится админом', async () => {
  const env = makeEnv();
  await isAdmin(env, OWNER);
  assert.equal(await isAdmin(env, { id: 666, username: 'workpagerepetitor' }), false);
});

test('человек не из списка и без username не админ', async () => {
  const env = makeEnv();
  assert.equal(await isAdmin(env, STRANGER), false);
  assert.equal(await isAdmin(env, { id: 4 }), false);
});

test('убранный из списка теряет доступ, несмотря на закреплённый ID', async () => {
  const env = makeEnv();
  await isAdmin(env, SECOND);
  env.ADMINS = 'workpagerepetitor';
  assert.equal(await isAdmin(env, SECOND), false);
});

/* ---------- Доступ к API ---------- */
test('без подписи 401, с поддельной 401', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'GET', '/me', { auth: '' })).status, 401);
  assert.equal((await call(env, 'GET', '/store', { auth: 'tma hash=00&user=1' })).status, 401);
});

test('/me отвечает админу и не-админу', async () => {
  const env = makeEnv();
  assert.deepEqual((await call(env, 'GET', '/me')).data, { admin: true });
  assert.deepEqual((await call(env, 'GET', '/me', { user: STRANGER })).data, { admin: false });
});

test('не-админ получает 403 на всех операциях и ничего не меняет', async () => {
  const env = makeEnv();
  const head = repo.head;
  const u = { user: STRANGER };
  const results = await Promise.all([
    call(env, 'GET', '/store', u),
    call(env, 'POST', '/photos', { ...u, body: { b64: 'x' } }),
    call(env, 'PUT', '/products/a', { ...u, body: item() }),
    call(env, 'PATCH', '/products/a/status', { ...u, body: { status: 'sold' } }),
    call(env, 'DELETE', '/products/a', u),
    call(env, 'PUT', '/settings', { ...u, body: {} }),
    call(env, 'PUT', '/brands/x', { ...u, body: { name: 'X' } }),
    call(env, 'DELETE', '/brands/si', u),
  ]);
  results.forEach(r => assert.equal(r.status, 403));
  assert.equal(repo.head, head);
});

test('CORS только для адреса сайта', async () => {
  const env = makeEnv();
  const ok = await call(env, 'GET', '/me', { origin: 'https://kuzmunkirill3384.github.io' });
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://kuzmunkirill3384.github.io');
  const no = await call(env, 'GET', '/me', { origin: 'https://evil.example' });
  assert.equal(no.headers.get('Access-Control-Allow-Origin'), null);
});

/* ---------- Запись ---------- */
test('новая вещь получает номер, следующая получает следующий', async () => {
  const env = makeEnv();
  await call(env, 'PUT', '/products/a', { body: item() });
  await call(env, 'PUT', '/products/b', { body: item({ title: 'Кепка' }) });
  const s = stored();
  assert.equal(s.products.find(p => p.id === 'a').lot, 1);
  assert.equal(s.products.find(p => p.id === 'b').lot, 2);
  assert.equal(s.settings.nextLot, 3);
});

test('номер лота не меняется при правке и удалении соседа', async () => {
  const env = makeEnv();
  for (const id of ['a', 'b', 'c']) await call(env, 'PUT', '/products/' + id, { body: item() });
  await call(env, 'DELETE', '/products/a');
  await call(env, 'PUT', '/products/c', { body: item({ title: 'Новое' }) });
  const s = stored();
  assert.equal(s.products.find(p => p.id === 'b').lot, 2);
  assert.equal(s.products.find(p => p.id === 'c').lot, 3);
  await call(env, 'PUT', '/products/d', { body: item() });
  assert.equal(stored().products.find(p => p.id === 'd').lot, 4);
});

test('путь вне img/ в загрузках отклоняется, index.html не меняется', async () => {
  const env = makeEnv();
  for (const path of ['index.html', 'img/../index.html', '.github/workflows/x.yml', 'img/a.html', 'img/a.svg']) {
    const r = await call(env, 'PUT', '/products/a', { body: item({ photos: [path], uploads: { [path]: 'b'.repeat(40) } }) });
    assert.equal(r.status, 400, path);
  }
  const r = await call(env, 'PUT', '/products/a', { body: item({ photos: [], uploads: { 'index.html': 'b'.repeat(40) } }) });
  assert.equal(r.status, 400);
  assert.equal(files()['index.html'], '<html>');
  assert.equal(stored().products.length, 0);
});

test('sha загрузки проверяется', async () => {
  const env = makeEnv();
  const r = await call(env, 'PUT', '/products/a', { body: item({ photos: ['img/a.jpg'], uploads: { 'img/a.jpg': 'not-a-sha' } }) });
  assert.equal(r.status, 400);
});

test('нельзя сослаться на фото, которого нет ни в вещи, ни в загрузках', async () => {
  const env = makeEnv();
  const r = await call(env, 'PUT', '/products/a', { body: item({ photos: ['img/other.jpg'] }) });
  assert.equal(r.status, 400);
});

test('несуществующий бренд отклоняется, новый создаётся', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'PUT', '/products/a', { body: item({ brand: 'nope' }) })).status, 400);
  const r = await call(env, 'PUT', '/products/a', { body: item({ brand: 'massimo', newBrand: { name: 'Massimo Osti' } }) });
  assert.equal(r.status, 200);
  assert.deepEqual(stored().brands.massimo, { name: 'Massimo Osti', mono: 'MO' });
});

test('неверные поля вещи отклоняются', () => {
  const cases = [
    item({ title: '' }), item({ size: '' }), item({ price: 0 }), item({ seller: '' }),
    item({ seller: 'bad name"><script>' }), item({ status: 'gone' }), item({ cond: 11 }), item({ price: '5' }),
    item({ photos: Array(11).fill('img/a.jpg') }),
  ];
  cases.forEach(c => assert.throws(() => cleanProduct('a', c), JSON.stringify(c)));
  assert.throws(() => cleanProduct('../x', item()));
  assert.equal(cleanProduct('a', item({ status: 'sold', price: undefined, seller: undefined })).status, 'sold');
});

test('повтор при 422, после трёх неудач 409', async () => {
  const env = makeEnv();
  failRefs = 2;
  assert.equal((await call(env, 'PUT', '/products/a', { body: item() })).status, 200);
  assert.equal(stored().products.length, 1);
  failRefs = 3;
  assert.equal((await call(env, 'PUT', '/products/b', { body: item() })).status, 409);
  assert.equal(stored().products.length, 1);
});

test('удаление убирает фото и лот недели, смена фото удаляет старое', async () => {
  const env = makeEnv();
  const sha = 'b'.repeat(40);
  await call(env, 'PUT', '/products/a', { body: item({ photos: ['img/1.jpg', 'img/2.jpg'], thumbs: { 'img/1.jpg': 'img/1t.webp' }, uploads: { 'img/1.jpg': sha, 'img/2.jpg': sha, 'img/1t.webp': sha } }) });
  assert.ok(files()['img/2.jpg']);
  await call(env, 'PUT', '/products/a', { body: item({ photos: ['img/1.jpg'], thumbs: { 'img/1.jpg': 'img/1t.webp' } }) });
  assert.equal(files()['img/2.jpg'], undefined);
  assert.ok(files()['img/1.jpg']);
  await call(env, 'PUT', '/settings', { body: { featured: 'a' } });
  await call(env, 'DELETE', '/products/a');
  assert.equal(files()['img/1.jpg'], undefined);
  assert.equal(files()['img/1t.webp'], undefined);
  assert.equal(stored().settings.featured, '');
});

test('настройки пишут только разрешённые поля и убирают старый список админов', async () => {
  const env = makeEnv();
  const r = await call(env, 'PUT', '/settings', { body: { contact: '@ambssl', tape: ['A', ' ', 'B'], admins: ['evil'], nextLot: 1, evil: 1 } });
  assert.equal(r.status, 200);
  const s = stored().settings;
  assert.equal(s.contact, 'ambssl');
  assert.deepEqual(s.tape, ['A', 'B']);
  assert.equal(s.admins, undefined);
  assert.equal(s.evil, undefined);
  assert.equal(s.nextLot, undefined);
  assert.equal((await call(env, 'PUT', '/settings', { body: { appLink: 'https://evil.example' } })).status, 400);
});

test('бренд с вещами нельзя удалить, переименование работает', async () => {
  const env = makeEnv();
  await call(env, 'PUT', '/products/a', { body: item() });
  assert.equal((await call(env, 'DELETE', '/brands/si')).status, 409);
  await call(env, 'PUT', '/brands/si', { body: { name: 'SI New', mono: 'sn' } });
  assert.deepEqual(stored().brands.si, { name: 'SI New', mono: 'SN' });
  await call(env, 'DELETE', '/products/a');
  assert.equal((await call(env, 'DELETE', '/brands/si')).status, 200);
  assert.equal(stored().brands.si, undefined);
});

/* ---------- Фото ---------- */
test('принимаются только JPEG и WebP', async () => {
  const b64 = bytes => btoa(String.fromCharCode(...bytes));
  const jpeg = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4];
  const webp = [...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBP')];
  assert.equal(photoExt(new Uint8Array(jpeg)), 'jpg');
  assert.equal(photoExt(new Uint8Array(webp)), 'webp');
  const env = makeEnv();
  const ok = await call(env, 'POST', '/photos', { body: { b64: b64(jpeg), item: 'a' } });
  assert.equal(ok.status, 200);
  assert.match(ok.data.path, /^img\/a-[a-z0-9]+\.jpg$/);
  const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
  assert.equal((await call(env, 'POST', '/photos', { body: { b64: b64(html) } })).status, 400);
  const svg = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
  assert.equal((await call(env, 'POST', '/photos', { body: { b64: b64(svg) } })).status, 400);
});

test('битый base64 даёт 400, а не сбой сервера', async () => {
  const env = makeEnv();
  for (const b64 of ['x', 'ab', '!!!!', '']) assert.equal((await call(env, 'POST', '/photos', { body: { b64 } })).status, 400, b64);
});

test('чужое имя в item не попадает в путь', async () => {
  const env = makeEnv();
  const r = await call(env, 'POST', '/photos', { body: { b64: btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0)), item: '../../index' } });
  assert.match(r.data.path, /^img\/item-/);
});

/* ---------- Канал ---------- */
test('публикация: фото по ссылке на коммит, id поста сохраняется', async () => {
  const env = makeEnv({ CHANNEL: '@chan' });
  const sha = 'b'.repeat(40);
  const r = await call(env, 'PUT', '/products/a', { body: item({ publish: true, photos: ['img/1.jpg', 'img/2.jpg'], uploads: { 'img/1.jpg': sha, 'img/2.jpg': sha } }) });
  assert.equal(r.data.published, true);
  const call0 = tgCalls.find(c => c.method === 'sendMediaGroup');
  assert.equal(call0.body.chat_id, '@chan');
  assert.match(call0.body.media[0].media, /^https:\/\/raw\.githubusercontent\.com\/KuzmunKirill3384\/slam-store\/c\d+\/img\/1\.jpg$/);
  assert.ok(call0.body.media[0].caption);
  assert.equal(call0.body.media[1].caption, undefined);
  assert.deepEqual(stored().products[0].tgPost, { chat: '@chan', id: 77, kind: 'caption' });
});

test('без публикации в канал ничего не уходит', async () => {
  const env = makeEnv({ CHANNEL: '@chan' });
  await call(env, 'PUT', '/products/a', { body: item() });
  assert.equal(tgCalls.length, 0);
});

test('сбой Telegram не отменяет сохранение вещи', async () => {
  const env = makeEnv({ CHANNEL: '@chan' });
  tgFails = true;
  const r = await call(env, 'PUT', '/products/a', { body: item({ publish: true }) });
  assert.equal(r.status, 200);
  assert.equal(r.data.published, false);
  assert.equal(stored().products.length, 1);
});

test('смена статуса правит подпись поста, номер поста не теряется при правке', async () => {
  const env = makeEnv({ CHANNEL: '@chan' });
  await call(env, 'PUT', '/products/a', { body: item({ publish: true }) });
  tgCalls.length = 0;
  await call(env, 'PATCH', '/products/a/status', { body: { status: 'sold' } });
  const edit = tgCalls.find(c => c.method === 'editMessageText');
  assert.match(edit.body.text, /SOLD/);
  await call(env, 'PUT', '/products/a', { body: item({ title: 'Другое' }) });
  assert.equal(stored().products[0].tgPost.id, 77);
});

test('подпись экранирует HTML', () => {
  const store = { brands: { si: { name: 'S&I' } } };
  const cap = postCaption({ APP_LINK: 'https://t.me/b/s' }, store, { id: 'a', brand: 'si', title: '<b>x', size: 'M', cond: 9, price: 12790, status: 'stock' });
  assert.match(cap, /S&amp;I &lt;b&gt;x/);
  assert.match(cap, /12 790 ₽/);
  assert.match(cap, /startapp=item_a/);
});

/* ---------- Бот и сбои ---------- */
test('вебхук требует секрет, /start даёт кнопку магазина', async () => {
  const env = makeEnv();
  const post = (secret, body) => worker.fetch(new Request('https://api.test/tg/webhook', {
    method: 'POST',
    headers: secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {},
    body: JSON.stringify(body),
  }), env);
  const update = { message: { chat: { id: 5, type: 'private' }, text: '/start' } };
  assert.equal((await post('', update)).status, 403);
  assert.equal((await post('wrong', update)).status, 403);
  assert.equal(tgCalls.length, 0);
  assert.equal((await post('hook', update)).status, 200);
  assert.equal(tgCalls[0].body.reply_markup.inline_keyboard[0][0].web_app.url, 'https://site/');
});

test('отказ GitHub по токену пишет админам один раз и даёт 502', async () => {
  const env = makeEnv();
  env.KV.put = async (k, v) => { env.KV.m.set(k, v); };
  await isAdmin(env, OWNER);
  const fake = globalThis.fetch;
  globalThis.fetch = async (url, opts) => String(url).startsWith('https://api.github.com') ? new Response('{}', { status: 401 }) : fake(url, opts);
  const a = await call(env, 'GET', '/store');
  const b = await call(env, 'GET', '/store');
  assert.equal(a.status, 502);
  assert.equal(b.status, 502);
  assert.equal(tgCalls.filter(c => c.method === 'sendMessage').length, 1);
  assert.equal(tgCalls[0].body.chat_id, '1');
  globalThis.fetch = fake;
});

test('неизвестный путь 404', async () => {
  assert.equal((await call(makeEnv(), 'GET', '/nope')).status, 404);
  assert.equal((await call(makeEnv(), 'POST', '/products/a', { body: {} })).status, 404);
});
