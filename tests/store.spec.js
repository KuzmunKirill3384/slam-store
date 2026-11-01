const { test, expect } = require('@playwright/test');
const { open, makeStore, product, fakeGitHub } = require('./helpers');

const ADMIN = { id: 1, username: 'workpagerepetitor', first_name: 'A' };
const SECOND = { id: 2, username: 'AmbSSL', first_name: 'B' };
const BUYER = { id: 3, username: 'q1ban', first_name: 'C' };
const TOKEN = { slam_gh: JSON.stringify({ repo: 'o/r', token: 't' }) };

// Проверяем отрисовку, а не свойство hidden: именно так вкладка и оказалась видна всем
const tabRow = page => page.locator('.tab:visible').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top)));

test.describe('вкладка «Админ»', () => {
  for (const [name, user] of [['покупатель', BUYER], ['без username', { id: 4, first_name: 'D' }]]) {
    test(`не видна: ${name}`, async ({ page }) => {
      await open(page, { user });
      await expect(page.locator('#admin-tab')).toBeHidden();
      const box = await page.locator('#admin-tab').boundingBox();
      expect(box).toBeNull();
      expect(await tabRow(page)).toHaveLength(3);
      await page.locator('#logo').click({ clickCount: 5, delay: 30 });
      await expect(page.locator('#v-admin')).toBeHidden();
    });
  }

  test('не видна в браузере без #admin', async ({ page }) => {
    await open(page);
    await expect(page.locator('#admin-tab')).toBeHidden();
  });

  test('покупатель не открывает админку через #admin', async ({ page }) => {
    await open(page, { user: BUYER, hash: '#admin' });
    await expect(page.locator('#v-admin')).toBeHidden();
  });

  for (const [name, user] of [['первый админ', ADMIN], ['второй админ, регистр другой', SECOND]]) {
    test(`видна: ${name}, меню в один ряд`, async ({ page }) => {
      await open(page, { user });
      await expect(page.locator('#admin-tab')).toBeVisible();
      const rows = await tabRow(page);
      expect(rows).toHaveLength(4);
      expect(new Set(rows).size).toBe(1);
    });
  }
});

test.describe('витрина', () => {
  test('пустой каталог: нет фильтров, брендов 00, понятное сообщение', async ({ page }) => {
    await open(page);
    await expect(page.locator('#grid')).toContainText('Каталог пока пуст');
    await expect(page.locator('.controls')).toBeHidden();
    await expect(page.locator('.result')).toBeHidden();
    await expect(page.locator('#stats')).toContainText('00');
    expect((await page.locator('#stats dd').allTextContents())).toEqual(['00', '00', '00']);
  });

  test('склонение количества', async ({ page }) => {
    const cases = [[1, '1 позиция'], [2, '2 позиции'], [5, '5 позиций']];
    for (const [n, want] of cases) {
      await open(page, { store: makeStore(Array.from({ length: n }, (_, i) => product('p' + i))) });
      await expect(page.locator('#found')).toHaveText(want);
    }
    expect(await page.evaluate(() => [11, 21, 22, 112].map(n => plural(n, 'a', 'b', 'c')))).toEqual(['c', 'a', 'b', 'c']);
  });

  test('номер лота берётся из вещи и не зависит от соседей', async ({ page }) => {
    await open(page, { store: makeStore([product('b', { lot: 7 }), product('a', { lot: 2 })]) });
    await expect(page.locator('[data-id="b"] .lot')).toHaveText('№07');
    await expect(page.locator('[data-id="a"] .lot')).toHaveText('№02');
  });

  test('ссылка на удалённую вещь сообщает об этом', async ({ page }) => {
    await open(page, { store: makeStore([product('a')]), hash: '#item-gone' });
    await expect(page.locator('#toast')).toHaveText('Вещь уже недоступна');
    expect(page.url()).not.toContain('#item-');
  });

  test('существующая вещь открывается, ссылка на продавца верная', async ({ page }) => {
    await open(page, { store: makeStore([product('a')]), hash: '#item-a' });
    const btn = page.locator('#sheet .btn-primary');
    await expect(btn).toContainText('@ambssl');
    expect(await btn.getAttribute('href')).toContain('https://t.me/ambssl?text=');
  });

  test('тексты не привязаны к роду', async ({ page }) => {
    const store = makeStore([product('s', { status: 'sold', price: undefined }), product('r', { status: 'reserved' })]);
    await open(page, { store, hash: '#item-s' });
    const sold = decodeURIComponent(await page.locator('#sheet .btn-quiet').getAttribute('href'));
    expect(sold).not.toMatch(/Видел|она/);
    await page.locator('#sheet [data-close]').click();
    await page.locator('[data-id="r"]').click();
    const reserved = decodeURIComponent(await page.locator('#sheet .btn-quiet').getAttribute('href'));
    expect(reserved).not.toContain('готов');
  });

  test('нет контактов: кнопки скупки и продавца нет', async ({ page }) => {
    const store = makeStore([product('a', { seller: undefined })], { contact: '', buyer: '' });
    await open(page, { store, hash: '#item-a' });
    await expect(page.locator('#sheet .btn-primary')).toHaveCount(0);
    await page.locator('#sheet [data-close]').click();
    await page.locator('.tab[data-tab="sell"]').click();
    await expect(page.locator('#sell-btn')).toBeHidden();
  });

  test('удалённая вещь пропадает из сохранённого избранного', async ({ page }) => {
    await open(page, { store: makeStore([product('a')]), storage: { slam_favs: JSON.stringify(['a', 'gone']) } });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('slam_favs')))).toEqual(['a']);
  });

  test('разбор поста из канала', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => parsePost('Худи C.P Company\nСостояние: 9/10 (подстёрлась линза)\nРазмер: S-M\n10.790₽\nТорг\n@ambssl'));
    expect(r).toMatchObject({ brand: 'cp', title: 'Худи', kind: 'худи', cond: 9, note: 'Подстёрлась линза', size: 'S-M', fit: ['S', 'M'], price: 10790, haggle: true, seller: 'ambssl', status: 'stock' });
  });
});

test.describe('админка с токеном', () => {
  async function openAdmin(page, store) {
    const repo = await fakeGitHub(page, store);
    await open(page, { user: ADMIN, store, storage: TOKEN });
    await page.locator('#admin-tab').click();
    await expect(page.locator('[data-new]')).toBeVisible();
    return repo;
  }

  test('новая вещь получает постоянный номер, правка его сохраняет', async ({ page }) => {
    const repo = await openAdmin(page, makeStore([], { nextLot: 5 }));
    await page.locator('[data-new]').click();
    await page.fill('#e-title', 'Кепка');
    await page.fill('#e-size', 'O/S');
    await page.fill('#e-price', '5500');
    await page.fill('#e-seller', 'ambssl');
    await page.locator('[data-save]').click();
    await expect(page.locator('.item-t')).toHaveText('Кепка');
    expect(repo.store.products[0].lot).toBe(5);
    expect(repo.store.settings.nextLot).toBe(6);

    await page.locator('.item').click();
    await page.fill('#e-title', 'Кепка новая');
    await page.locator('[data-save]').click();
    await expect(page.locator('.item-t')).toHaveText('Кепка новая');
    expect(repo.store.products[0].lot).toBe(5);
    expect(repo.store.settings.nextLot).toBe(6);
  });

  test('продавец с неверным username не сохраняется', async ({ page }) => {
    const repo = await openAdmin(page, makeStore());
    await page.locator('[data-new]').click();
    await page.fill('#e-title', 'Кепка');
    await page.fill('#e-size', 'M');
    await page.fill('#e-price', '100');
    await page.fill('#e-seller', 'плохой ник');
    await page.locator('[data-save]').click();
    await expect(page.locator('#e-err')).toContainText('username');
    expect(repo.store.products).toHaveLength(0);
  });

  test('бренд переименовывается; удалить можно только без вещей', async ({ page }) => {
    const repo = await openAdmin(page, makeStore([product('a')]));
    await page.fill('[data-brand-name="cp"]', 'CP New');
    await page.locator('[data-brand-save="cp"]').click();
    await expect(page.locator('#toast')).toHaveText('Бренд сохранён');
    expect(repo.store.brands.cp.name).toBe('CP New');

    await expect(page.locator('[data-brand-del="si"]')).toHaveCount(0);
    await page.locator('[data-brand-del="empty"]').click();
    await expect(page.locator('#toast')).toHaveText('Бренд удалён');
    expect(repo.store.brands.empty).toBeUndefined();
  });
});
