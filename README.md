## Telegram Paywall Bot (MonoPay)

Features:
- Показывает тарифы (1 мес, 3 мес)
- Создаёт счёт в MonoPay и обрабатывает вебхук
- Выдаёт уникальную ссылку на канал после оплаты
- Автоматически удаляет пользователя по окончании подписки

### Настройка
1) Создайте бота в Telegram через @BotFather и получите токен
2) Создайте приватный канал, добавьте бота как администратора с правами приглашения/бана
3) Получите токен MonoPay (X-Token) и, при необходимости, секрет вебхука
4) Создайте файл `.env` по аналогии:

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHANNEL_ID=-100XXXXXXXXXX
MONOPAY_TOKEN=...
MONOPAY_WEBHOOK_SECRET=...
PUBLIC_BASE_URL=https://your-domain.com
PORT=3000
DATABASE_PATH=./data/bot.db
CCY=980
TEST_MODE=1
```

### Запуск

```
npm run dev
```

Для продакшена:
```
npm run build && npm start
```

Настройте в кабинете MonoPay URL вебхука: `https://your-domain.com/monopay/webhook`

### Локальный запуск через Docker

1) Создайте `.env` в корне проекта (см. пример выше)
2) Запустите в дев-режиме с лайв-обновлениями:
```
docker compose up --build
```
Приложение будет доступно на `http://localhost:3000`. Вебхук MonoPay локально можно тестировать через `ngrok` или `cloudflared`, пробрасывая `PUBLIC_BASE_URL`.

Для продакшен-образа:
```
docker build -t julia-bot:prod --target prod .
docker run --env-file .env -p 3000:3000 -v $(pwd)/data:/app/data julia-bot:prod
```

### Тестирование без оплаты
- Установите в `.env`: `TEST_MODE=1`
- Запустите бота и нажмите тариф. Бот сразу выдаст одноразовую ссылку на канал без оплаты.
- Сигнатура вебхука в тестовом режиме не проверяется.


# Julia_bot
