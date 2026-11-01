// API админки SLAM STORE. Проверяет подпись Telegram и список админов,
// а в репозиторий пишет только store.json и img/
const INIT_DATA_TTL = 24 * 3600;
const COMMIT_ATTEMPTS = 3;
const MAX_PHOTO_B64 = 4 * 1024 * 1024;
const MAX_PHOTOS = 10;

const STATUSES = ['stock', 'reserved', 'sold'];
const FITS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'OS'];
const RE_ID = /^[\w-]{1,64}$/;
const RE_BRAND = /^[a-z0-9]{1,24}$/;
const RE_USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const RE_PHOTO = /^img\/[\w.-]{1,128}\.(webp|jpg)$/;
const RE_SHA = /^[0-9a-f]{40}$/;

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const bad = code => new HttpError(400, code);

/* ---------- Подпись Telegram ---------- */
const enc = new TextEncoder();
const hmacKey = (raw, usage) => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
const hexToBytes = hex => Uint8Array.from(hex.match(/../g).map(b => parseInt(b, 16)));

// Возвращает пользователя из initData или null, если подпись неверна или устарела
export async function verifyInitData(raw, botToken, now = Date.now() / 1000) {
  if (!raw || !botToken) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = await crypto.subtle.sign('HMAC', await hmacKey(enc.encode('WebAppData'), 'sign'), enc.encode(botToken));
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), hexToBytes(hash), enc.encode(check));
  if (!ok) return null;
  const age = now - Number(params.get('auth_date'));
  if (!(age >= -60 && age <= INIT_DATA_TTL)) return null;
  try {
    const user = JSON.parse(params.get('user'));
    return user && user.id ? user : null;
  } catch (e) { return null; }
}

/* ---------- Список админов ---------- */
const adminEntries = env => String(env.ADMINS || '').split(/[\s,]+/).map(x => x.replace(/^@/, '').toLowerCase()).filter(Boolean);

// Username может занять другой человек, поэтому при первом входе ID закрепляется за ним
export async function isAdmin(env, user) {
  const list = adminEntries(env);
  if (list.includes(String(user.id))) return true;
  const name = String(user.username || '').toLowerCase();
  if (!name || !list.includes(name)) return false;
  const key = `admin:${name}`;
  const pinned = await env.KV.get(key);
  if (pinned) return pinned === String(user.id);
  await env.KV.put(key, String(user.id));
  return true;
}

async function adminChatIds(env) {
  const ids = [];
  for (const entry of adminEntries(env)) {
    if (/^\d+$/.test(entry)) ids.push(entry);
    else { const id = await env.KV.get(`admin:${entry}`); if (id) ids.push(id); }
  }
  return ids;
}

/* ---------- Telegram Bot API ---------- */
async function tgCall(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description || r.status}`);
  return data.result;
}

// Истёкший токен GitHub ломает админку целиком: сообщаем сразу, но не чаще раза в час
async function alertGithubAuth(env) {
  try {
    if (await env.KV.get('alert:github')) return;
    await env.KV.put('alert:github', '1', { expirationTtl: 3600 });
    for (const chat_id of await adminChatIds(env)) {
      await tgCall(env, 'sendMessage', { chat_id, text: 'Админка магазина не может записать каталог: GitHub отклонил токен. Создайте новый и обновите секрет GITHUB_TOKEN в Worker.' }).catch(() => {});
    }
  } catch (e) {}
}

/* ---------- GitHub ---------- */
async function gh(env, path, opts = {}) {
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'slam-store-worker',
  };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, { ...opts, headers });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) await alertGithubAuth(env);
    const err = new Error(`github ${r.status}`);
    err.ghStatus = r.status;
    throw err;
  }
  return r.json();
}

function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function normalizeStore(s) {
  s = s && typeof s === 'object' ? s : {};
  return {
    ...s,
    settings: s.settings && typeof s.settings === 'object' ? s.settings : {},
    brands: s.brands && typeof s.brands === 'object' ? s.brands : {},
    products: Array.isArray(s.products) ? s.products : [],
  };
}

const headSha = async env => (await gh(env, `/git/ref/heads/${env.BRANCH}`)).object.sha;

async function readStoreAt(env, sha) {
  try {
    const f = await gh(env, `/contents/store.json?ref=${sha}`);
    return normalizeStore(JSON.parse(b64decodeUtf8(f.content)));
  } catch (e) {
    if (e.ghStatus === 404) return normalizeStore(null);
    throw e;
  }
}

// Один коммит: store.json, новые фото и удаления. mutate может вернуть { remove: [...] }
async function commit(env, message, mutate, uploads = {}) {
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
    const head = await headSha(env);
    const store = await readStoreAt(env, head);
    const remove = (mutate(store) || {}).remove || [];
    const base = await gh(env, `/git/commits/${head}`);
    const tree = [{ path: 'store.json', mode: '100644', type: 'blob', content: JSON.stringify(store, null, 2) + '\n' }];
    for (const [path, sha] of Object.entries(uploads)) tree.push({ path, mode: '100644', type: 'blob', sha });
    const gone = remove.filter(p => RE_PHOTO.test(p));
    if (gone.length) {
      const existing = await gh(env, `/git/trees/${base.tree.sha}?recursive=1`);
      const have = new Set(existing.tree.map(x => x.path));
      gone.filter(p => have.has(p)).forEach(path => tree.push({ path, mode: '100644', type: 'blob', sha: null }));
    }
    const t = await gh(env, '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree }) });
    const c = await gh(env, '/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: t.sha, parents: [head] }) });
    try {
      await gh(env, `/git/refs/heads/${env.BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
      return { store, sha: c.sha };
    } catch (e) {
      if (e.ghStatus !== 422) throw e;
    }
  }
  throw new HttpError(409, 'conflict');
}

/* ---------- Проверка данных ---------- */
function text(v, max, code) {
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) throw bad(code);
  return v.trim() || undefined;
}
function int(v, min, max, code) {
  if (v == null || v === '') return undefined;
  if (!Number.isInteger(v) || v < min || v > max) throw bad(code);
  return v;
}
function username(v, code) {
  const s = text(v, 33, code);
  if (s === undefined) return undefined;
  const clean = s.replace(/^@/, '');
  if (!RE_USERNAME.test(clean)) throw bad(code);
  return clean;
}

function cleanBrand(b) {
  const name = text(b && b.name, 60, 'brand_name');
  if (!name) throw bad('brand_name');
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/);
  const auto = words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2);
  const mono = text(b.mono, 4, 'brand_mono') || auto;
  return { name, mono: mono.toUpperCase() };
}

export function cleanProduct(id, body) {
  if (!RE_ID.test(id)) throw bad('id');
  const status = body.status || 'stock';
  if (!STATUSES.includes(status)) throw bad('status');
  const brand = String(body.brand || '');
  if (!RE_BRAND.test(brand)) throw bad('brand');
  const title = text(body.title, 120, 'title');
  const size = text(body.size, 60, 'size');
  if (!title) throw bad('title');
  if (!size) throw bad('size');
  const price = int(body.price, 0, 100000000, 'price');
  const seller = username(body.seller, 'seller');
  if (status !== 'sold' && !price) throw bad('price');
  if (status !== 'sold' && !seller) throw bad('seller');
  const fit = Array.isArray(body.fit) ? body.fit.filter(f => FITS.includes(f)) : [];
  const m = body.measure || {};
  const measure = {};
  for (const k of ['pit', 'length', 'sleeve']) {
    const n = int(m[k], 1, 500, 'measure');
    if (n) measure[k] = n;
  }
  const photos = Array.isArray(body.photos) ? body.photos : [];
  if (photos.length > MAX_PHOTOS) throw bad('too_many_photos');
  if (!photos.every(p => typeof p === 'string' && RE_PHOTO.test(p))) throw bad('photo_path');
  const thumbs = {};
  for (const [k, v] of Object.entries(body.thumbs || {})) {
    if (!photos.includes(k) || typeof v !== 'string' || !RE_PHOTO.test(v)) throw bad('photo_path');
    thumbs[k] = v;
  }
  return {
    id, brand,
    kind: (text(body.kind, 40, 'kind') || 'вещь').toLowerCase(),
    title, size, fit,
    cond: int(body.cond, 1, 10, 'cond') || 9,
    price: price || undefined,
    seller,
    haggle: body.haggle === true || undefined,
    note: text(body.note, 300, 'note'),
    desc: text(body.desc, 3000, 'desc'),
    measure: Object.keys(measure).length ? measure : undefined,
    status,
    photos,
    thumbs: Object.keys(thumbs).length ? thumbs : undefined,
  };
}

function cleanUploads(raw, allowed) {
  const out = {};
  for (const [path, sha] of Object.entries(raw || {})) {
    if (!RE_PHOTO.test(path) || !RE_SHA.test(String(sha))) throw bad('upload');
    if (!allowed.has(path)) throw bad('upload');
    out[path] = sha;
  }
  return out;
}

function cleanSettings(body) {
  const patch = {};
  if ('contact' in body) patch.contact = username(body.contact, 'contact') || '';
  if ('buyer' in body) patch.buyer = username(body.buyer, 'buyer') || '';
  if ('featured' in body) {
    const f = String(body.featured || '');
    if (f && !RE_ID.test(f)) throw bad('featured');
    patch.featured = f;
  }
  if ('tape' in body) {
    if (!Array.isArray(body.tape) || body.tape.length > 40) throw bad('tape');
    patch.tape = body.tape.map(x => text(x, 60, 'tape')).filter(Boolean);
  }
  if ('appLink' in body) {
    const a = String(body.appLink || '').trim();
    if (a && !a.startsWith('https://t.me/')) throw bad('app_link');
    patch.appLink = a;
  }
  return patch;
}

// По первым байтам: в img/ попадут только настоящие JPEG и WebP, а не HTML или SVG
export function photoExt(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  const tag = String.fromCharCode(...bytes.slice(0, 4), ...bytes.slice(8, 12));
  return tag === 'RIFFWEBP' ? 'webp' : null;
}

/* ---------- Канал ---------- */
const escHtml = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const rub = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';

export function postCaption(env, store, p) {
  const brand = (store.brands[p.brand] || {}).name || p.brand;
  const price = p.status === 'sold' ? '<b>SOLD</b>'
    : `<b>${rub(p.price || 0)}</b>${p.status === 'reserved' ? ' · бронь' : p.haggle ? ' · торг' : ''}`;
  const lines = [
    `<b>${escHtml(brand)} ${escHtml(p.title)}</b>`,
    `Размер: ${escHtml(p.size)}`,
    `Состояние: ${p.cond}/10${p.note ? ` (${escHtml(p.note)})` : ''}`,
    price,
  ];
  if (p.status !== 'sold' && env.APP_LINK) lines.push(`<a href="${escHtml(env.APP_LINK)}?startapp=item_${p.id}">Открыть в магазине</a>`);
  return lines.join('\n');
}

async function publishToChannel(env, store, p, sha) {
  const caption = postCaption(env, store, p);
  const chat_id = env.CHANNEL;
  // Telegram надёжно принимает по ссылке только JPEG
  const urls = p.photos.filter(x => x.endsWith('.jpg')).map(x => `https://raw.githubusercontent.com/${env.GITHUB_REPO}/${sha}/${x}`);
  if (urls.length > 1) {
    const media = urls.map((media, i) => ({ type: 'photo', media, ...(i ? {} : { caption, parse_mode: 'HTML' }) }));
    const sent = await tgCall(env, 'sendMediaGroup', { chat_id, media });
    return { chat: chat_id, id: sent[0].message_id, kind: 'caption' };
  }
  if (urls.length === 1) {
    const sent = await tgCall(env, 'sendPhoto', { chat_id, photo: urls[0], caption, parse_mode: 'HTML' });
    return { chat: chat_id, id: sent.message_id, kind: 'caption' };
  }
  const sent = await tgCall(env, 'sendMessage', { chat_id, text: caption, parse_mode: 'HTML' });
  return { chat: chat_id, id: sent.message_id, kind: 'text' };
}

// Подпись в канале вторична: её сбой не должен отменять сохранённую правку
async function syncChannelPost(env, store, p) {
  if (!p || !p.tgPost) return;
  const { chat, id, kind } = p.tgPost;
  const body = { chat_id: chat, message_id: id, parse_mode: 'HTML' };
  const caption = postCaption(env, store, p);
  try {
    if (kind === 'text') await tgCall(env, 'editMessageText', { ...body, text: caption });
    else await tgCall(env, 'editMessageCaption', { ...body, caption });
  } catch (e) {}
}

/* ---------- Операции ---------- */
const who = user => (user.username ? ` (@${user.username})` : '');

async function uploadPhoto(env, body) {
  const b64 = String(body.b64 || '').replace(/\s/g, '');
  if (!b64 || b64.length > MAX_PHOTO_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw bad('photo');
  let head;
  try { head = Uint8Array.from(atob(b64.slice(0, 64)), c => c.charCodeAt(0)); } catch (e) { throw bad('photo'); }
  const ext = photoExt(head);
  if (!ext) throw bad('photo_format');
  const name = RE_ID.test(String(body.item || '')) ? body.item : 'item';
  const path = `img/${name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const blob = await gh(env, '/git/blobs', { method: 'POST', body: JSON.stringify({ content: b64, encoding: 'base64' }) });
  return { path, sha: blob.sha };
}

const photoFiles = p => [...(p.photos || []), ...Object.values(p.thumbs || {})];

async function putProduct(env, user, id, body) {
  const prod = cleanProduct(id, body);
  const newBrand = body.newBrand ? cleanBrand(body.newBrand) : null;
  const uploads = cleanUploads(body.uploads, new Set(photoFiles(prod)));
  let isNew = false;
  let brandName = '';
  const { store, sha } = await commit(env, `Вещь: ${prod.title}${who(user)}`, s => {
    if (newBrand) s.brands[prod.brand] = newBrand;
    if (!s.brands[prod.brand]) throw bad('brand');
    brandName = s.brands[prod.brand].name;
    const i = s.products.findIndex(x => x.id === id);
    const prev = i >= 0 ? s.products[i] : null;
    isNew = !prev;
    const known = new Set(prev ? photoFiles(prev) : []);
    if (!photoFiles(prod).every(p => known.has(p) || uploads[p])) throw bad('photo_path');
    const keep = new Set(photoFiles(prod));
    if (prev) {
      prod.lot = prev.lot;
      if (prev.tgPost) prod.tgPost = prev.tgPost;
    }
    if (!prod.lot) {
      prod.lot = s.settings.nextLot || 1;
      s.settings.nextLot = prod.lot + 1;
    }
    if (i >= 0) s.products[i] = prod; else s.products.unshift(prod);
    return { remove: prev ? photoFiles(prev).filter(p => !keep.has(p)) : [] };
  }, uploads);

  const current = store.products.find(x => x.id === id);
  if (!isNew || !body.publish || !env.CHANNEL) {
    await syncChannelPost(env, store, current);
    return { store };
  }
  try {
    const tgPost = await publishToChannel(env, store, current, sha);
    const next = await commit(env, `Пост в канале: ${brandName} ${prod.title}`, s => {
      const x = s.products.find(y => y.id === id);
      if (x) x.tgPost = tgPost;
    });
    return { store: next.store, published: true };
  } catch (e) {
    console.error('publish failed', e.message);
    return { store, published: false };
  }
}

async function patchStatus(env, user, id, body) {
  if (!STATUSES.includes(body.status)) throw bad('status');
  const { store } = await commit(env, `Статус ${id}: ${body.status}${who(user)}`, s => {
    const x = s.products.find(y => y.id === id);
    if (!x) throw new HttpError(404, 'not_found');
    x.status = body.status;
  });
  await syncChannelPost(env, store, store.products.find(x => x.id === id));
  return { store };
}

async function deleteProduct(env, user, id) {
  const { store } = await commit(env, `Удалена вещь ${id}${who(user)}`, s => {
    const x = s.products.find(y => y.id === id);
    if (!x) throw new HttpError(404, 'not_found');
    s.products = s.products.filter(y => y.id !== id);
    if (s.settings.featured === id) s.settings.featured = '';
    return { remove: photoFiles(x) };
  });
  return { store };
}

async function putSettings(env, user, body) {
  const patch = cleanSettings(body);
  const { store } = await commit(env, `Настройки витрины${who(user)}`, s => {
    Object.assign(s.settings, patch);
    delete s.settings.admins;
  });
  return { store };
}

async function putBrand(env, user, key, body) {
  if (!RE_BRAND.test(key)) throw bad('brand');
  const brand = cleanBrand(body);
  const { store } = await commit(env, `Бренд: ${brand.name}${who(user)}`, s => { s.brands[key] = brand; });
  return { store };
}

async function deleteBrand(env, user, key) {
  if (!RE_BRAND.test(key)) throw bad('brand');
  const { store } = await commit(env, `Удалён бренд ${key}${who(user)}`, s => {
    if (s.products.some(p => p.brand === key)) throw new HttpError(409, 'brand_in_use');
    delete s.brands[key];
  });
  return { store };
}

/* ---------- Бот ---------- */
async function telegramWebhook(request, env) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const update = await request.json().catch(() => ({}));
  const msg = update.message;
  if (msg && msg.chat && msg.chat.type === 'private' && /^\/start\b/.test(msg.text || '')) {
    await tgCall(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: 'SLAM STORE: архивная одежда. Открой каталог и пиши продавцу напрямую.',
      reply_markup: { inline_keyboard: [[{ text: 'Открыть магазин', web_app: { url: env.SITE_URL } }]] },
    }).catch(e => console.error(e.message));
  }
  return new Response('ok');
}

/* ---------- Маршруты ---------- */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const h = { Vary: 'Origin' };
  if (origin && origin === env.ALLOWED_ORIGIN) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Authorization,Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

async function route(request, env) {
  const { pathname } = new URL(request.url);
  const method = request.method;
  const auth = request.headers.get('Authorization') || '';
  const user = auth.startsWith('tma ') ? await verifyInitData(auth.slice(4), env.BOT_TOKEN) : null;
  if (!user) throw new HttpError(401, 'unauthorized');
  const admin = await isAdmin(env, user);
  if (method === 'GET' && pathname === '/me') return { admin };
  if (!admin) throw new HttpError(403, 'forbidden');

  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await request.json().catch(() => { throw bad('json'); }) : null;
  const m = pathname.match(/^\/(products|brands)\/([^/]+)(\/status)?$/);
  const key = m ? decodeURIComponent(m[2]) : '';

  if (method === 'GET' && pathname === '/store') return { store: await readStoreAt(env, await headSha(env)), channel: !!env.CHANNEL };
  if (method === 'POST' && pathname === '/photos') return uploadPhoto(env, body);
  if (method === 'PUT' && pathname === '/settings') return putSettings(env, user, body);
  if (m && m[1] === 'products') {
    if (!RE_ID.test(key)) throw bad('id');
    if (method === 'PUT' && !m[3]) return putProduct(env, user, key, body);
    if (method === 'PATCH' && m[3]) return patchStatus(env, user, key, body);
    if (method === 'DELETE' && !m[3]) return deleteProduct(env, user, key);
  }
  if (m && m[1] === 'brands' && !m[3]) {
    if (method === 'PUT') return putBrand(env, user, key, body);
    if (method === 'DELETE') return deleteBrand(env, user, key);
  }
  throw new HttpError(404, 'not_found');
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && pathname === '/tg/webhook') return telegramWebhook(request, env);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
    try {
      return reply(await route(request, env));
    } catch (e) {
      if (e instanceof HttpError) return reply({ error: e.code }, e.status);
      console.error(e.message);
      return reply({ error: e.ghStatus ? 'github' : 'internal' }, 502);
    }
  },
};
