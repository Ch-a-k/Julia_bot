// Константы для бота

// Таймауты и интервалы (в секундах)
export const PAYMENT_VALIDATION_TIMEOUT_SEC = 10 * 60; // 10 минут для подтверждения оплаты
export const INVITE_LINK_EXPIRE_SEC = 24 * 60 * 60; // 24 часа срок действия ссылки-приглашения
export const ONE_DAY_SEC = 24 * 60 * 60;
export const ONE_MONTH_APPROX_SEC = 30 * 24 * 60 * 60;

// Задержки между запросами (в миллисекундах)
export const BROADCAST_DELAY_MS = 100;
export const SCHEDULER_ANTIFLOOD_DELAY_MS = 120;

// Часовой пояс для cron задач
export const CRON_TIMEZONE = 'Europe/Kyiv';

// Ключи для системы напоминаний
export const EXPIRY_NOTICE_KEY = 0; // Маркер для уведомления об истечении подписки
