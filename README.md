# SLAM STORE

Telegram Mini App магазина архивной одежды со встроенной админкой. Витрина живёт на GitHub Pages, каталог лежит в `store.json`. Покупатель пишет продавцу в Telegram, оплаты в приложении нет.

```
index.html   приложение целиком: витрина и админка
store.json   товары, бренды, настройки витрины
img/         фото товаров и превью, создаётся админкой
fonts/       шрифты с лицензиями OFL
worker/      сервер админки на Cloudflare Workers: проверка админов, запись каталога, бот
tests/       проверка витрины в браузере (Playwright)
```

## Витрина

1. Settings → Pages → Source: `Deploy from a branch`, ветка `main`, папка `/ (root)`
2. В @BotFather: `/newapp`, ссылка на сайт, короткое имя `shop`
3. Сайт: `https://kuzmunkirill3384.github.io/slam-store/`, Mini App: `https://t.me/SlamStoreSPB_bot/shop`

## Сервер админки

Worker проверяет подпись Telegram и список админов. Токен GitHub хранится только на сервере, поэтому на телефонах его нет, а записать можно только `store.json` и `img/`.

```bash
cd worker
```

```bash
npx wrangler login
```

```bash
npx wrangler kv namespace create slam-store
```

Вставь полученный `id` в [worker/wrangler.toml](worker/wrangler.toml), затем задай секреты. Команды сами спросят значения:

```bash
npx wrangler secret put BOT_TOKEN
```

```bash
npx wrangler secret put GITHUB_TOKEN
```

```bash
npx wrangler secret put WEBHOOK_SECRET
```

- `BOT_TOKEN`: токен бота от @BotFather
- `GITHUB_TOKEN`: [новый токен](https://github.com/settings/personal-access-tokens/new), доступ только к `slam-store`, право Contents: Read and write
- `WEBHOOK_SECRET`: любая длинная случайная строка, например из `openssl rand -hex 32`

```bash
npx wrangler deploy
```

Команда покажет адрес вида `https://slam-store-api.<аккаунт>.workers.dev`. Его нужно указать в `CONFIG.api` в `index.html`.

Чтобы бот отвечал на `/start`, подключи вебхук, подставив свои значения:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" -d "url=https://<адрес Worker>/tg/webhook" -d "secret_token=<WEBHOOK_SECRET>"
```

## Админы

Список задаётся в `ADMINS` в `worker/wrangler.toml`: username или Telegram ID через запятую. После изменения выполни `npx wrangler deploy`. При первом входе ID закрепляется за username, поэтому человек, занявший чужой username, админом не станет. Если админ законно сменил аккаунт, удали его запись `admin:<username>` из KV.

Пока `CONFIG.api` пуст, админка работает по-старому: вкладка видна тем, кто в `settings.admins`, а запись идёт по токену GitHub, сохранённому на устройстве.

## Публикация в канал

1. Добавь бота в канал админом с правом публикации
2. Укажи `CHANNEL = "@канал"` в `worker/wrangler.toml` и выполни `npx wrangler deploy`
3. В форме новой вещи появится переключатель «Опубликовать в канал»

При смене статуса и правке вещи подпись поста обновляется сама.

## Работа с каталогом

- **Добавить вещь:** «Добавить вещь» → «Вставить пост из канала», вставь текст поста как есть, поля заполнятся сами. Проверь, добавь фото, «Сохранить»
- **Продано или бронь:** переключатель статуса прямо в списке вещей
- **Фото:** до 10 на вещь, сжимаются на телефоне. Первое фото будет обложкой
- **Лот недели, контакты, бегущая лента, ссылка на Mini App:** раздел «Витрина»
- **Бренды:** новый бренд добавляется в форме вещи, переименовать или удалить можно в разделе «Бренды». Удалить можно только бренд без вещей

После сохранения изменения появляются у покупателей примерно через минуту, пока GitHub Pages пересобирает сайт. В админке они видны сразу.

## Если что-то сломалось

- **«Сервер не смог записать каталог», админам пришло сообщение от бота:** истёк `GITHUB_TOKEN`. Создай новый и повтори `npx wrangler secret put GITHUB_TOKEN`
- **Сервер недоступен:** витрина продолжает работать, пропадает только админка. Проверь адрес Worker с телефона. В России Cloudflare может работать с перебоями
- **Потерян телефон админа:** на сервере нет привязки к устройству, достаточно завершить сеанс Telegram на потерянном устройстве
- **Откат каталога:** все правки это коммиты, нужную версию `store.json` можно вернуть из истории репозитория

## Тесты

```bash
cd worker && npm test
```

```bash
cd tests && npm ci && npx playwright install chromium && npx playwright test
```

В GitHub Actions они запускаются при каждом пуше.
