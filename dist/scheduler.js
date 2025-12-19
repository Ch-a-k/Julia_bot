import cron from 'node-cron';
import { findExpiredActiveSubscriptions, deactivateSubscription, listKnownUserIds, hasActiveSubscription, getLastReminderAt, setReminderSentNow, getDb, createOrExtendSubscription, findExpiringSubscriptions, wasExpiryReminderSent, markExpiryReminderSent, initExpiryRemindersTable, tryMarkPaymentSuccess, listUserIdsWithoutSuccessfulPayment } from './db.js';
import { config, isAdmin } from './config.js';
import { Telegram, Markup } from 'telegraf';
import { removeUserFromChannel } from './bot.js';
import { PLAN_DETAILS } from './types.js';
import { fetchInvoiceStatus } from './monopay.js';
// Клавиатура тарифов для сообщений об истечении
const tariffsKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('Подписка 1 месяц — 700₴', 'buy:P1M')],
    [Markup.button.callback('Подписка 2 месяца — 1200₴', 'buy:P2M')],
]);
// Часовой пояс для cron (Киев)
const CRON_TIMEZONE = 'Europe/Kiev';
// daysBeforeExpiry=0 используем как "уведомление об истечении уже отправляли"
const EXPIRY_NOTICE_KEY = 0;
// Форматирование даты
function formatDateRu(timestamp) {
    const date = new Date(timestamp * 1000);
    const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
        'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    return `${date.getDate()} ${months[date.getMonth()]}`;
}
let expiredJobInProgress = false;
let unpaidAuditInProgress = false;
async function processExpiredSubscriptions(telegram, reason) {
    if (expiredJobInProgress) {
        console.log(`[Scheduler] Пропуск обработки истёкших подписок (уже выполняется): reason=${reason}`);
        return;
    }
    expiredJobInProgress = true;
    try {
        console.log(`[Scheduler] Проверка истёкших подписок... (${reason})`);
        const nowSec = Math.floor(Date.now() / 1000);
        const expired = findExpiredActiveSubscriptions(nowSec);
        console.log(`[Scheduler] Найдено истёкших подписок: ${expired.length}`);
        for (const sub of expired) {
            console.log(`[Scheduler] Обработка userId=${sub.telegramUserId}, chatId=${sub.chatId}, endAt=${sub.endAt}, now=${nowSec}`);
            let removed = false;
            try {
                // Используем chatId из подписки, а не из конфига
                await removeUserFromChannel(telegram, sub.chatId, sub.telegramUserId);
                console.log(`[Scheduler] Удалён из канала ${sub.chatId}: ${sub.telegramUserId}`);
                removed = true;
            }
            catch (err) {
                console.error(`[Scheduler] Ошибка удаления из канала userId=${sub.telegramUserId} chatId=${sub.chatId}:`, err);
            }
            // Важно: если не удалось удалить (например, нет прав), НЕ деактивируем,
            // чтобы бот продолжал пытаться на следующих запусках и было видно ошибку в логах.
            if (removed) {
                deactivateSubscription(sub.id);
            }
            else {
                console.warn(`[Scheduler] Подписка НЕ деактивирована (удаление не удалось): subId=${sub.id} userId=${sub.telegramUserId}`);
            }
            // Сообщение об истечении отправляем ровно 1 раз на подписку, чтобы не спамить при ретраях кика.
            if (wasExpiryReminderSent(sub.id, EXPIRY_NOTICE_KEY)) {
                continue;
            }
            try {
                const message = [
                    '😔 Подписка завершена',
                    '',
                    'Срок вашей подписки на канал «Психосоматика. Живая правда» истёк.',
                    '',
                    'Доступ к каналу закрыт, но вы всегда можете вернуться!',
                    '',
                    'Благодарю за время, проведённое вместе. Буду рада видеть вас снова! 🤍',
                    '',
                    'Выберите тариф для продления:'
                ].join('\n');
                await telegram.sendMessage(sub.telegramUserId, message, {
                    parse_mode: 'HTML',
                    reply_markup: tariffsKeyboard.reply_markup,
                });
                markExpiryReminderSent(sub.id, EXPIRY_NOTICE_KEY);
                console.log(`[Scheduler] Уведомление отправлено: ${sub.telegramUserId}`);
            }
            catch (err) {
                console.error(`[Scheduler] Ошибка отправки уведомления userId=${sub.telegramUserId}:`, err);
            }
        }
        console.log(`[Scheduler] Проверка истёкших подписок завершена. (${reason})`);
    }
    catch (err) {
        console.error('[Scheduler] Общая ошибка задачи обработки истёкших подписок:', err);
    }
    finally {
        expiredJobInProgress = false;
    }
}
export function startScheduler(telegram) {
    console.log(`[Scheduler] Запущен. Часовой пояс: ${CRON_TIMEZONE}`);
    // Инициализируем таблицу для напоминаний
    initExpiryRemindersTable();
    // === НАПОМИНАНИЯ ЗА 3 ДНЯ ДО ИСТЕЧЕНИЯ (в 11:00) ===
    cron.schedule('0 11 * * *', async () => {
        try {
            console.log(`[Scheduler] Проверка подписок, истекающих через 3 дня...`);
            const expiring = findExpiringSubscriptions(3);
            let sent = 0;
            for (const sub of expiring) {
                if (wasExpiryReminderSent(sub.id, 3))
                    continue;
                const endDate = formatDateRu(sub.endAt);
                const message = [
                    '💫 Напоминание о подписке',
                    '',
                    `Ваша подписка на канал «Психосоматика. Живая правда» заканчивается <b>${endDate}</b>.`,
                    '',
                    'Чтобы не потерять доступ к материалам и встречам, продлите подписку заранее.',
                    '',
                    'Благодарю, что вы с нами! 🤍'
                ].join('\n');
                try {
                    await telegram.sendMessage(sub.telegramUserId, message, { parse_mode: 'HTML' });
                    markExpiryReminderSent(sub.id, 3);
                    sent++;
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                catch (err) {
                    console.error(`[Scheduler] Ошибка напоминания за 3 дня userId=${sub.telegramUserId}:`, err);
                }
            }
            console.log(`[Scheduler] Напоминания за 3 дня: отправлено ${sent}`);
        }
        catch (err) {
            console.error('[Scheduler] Общая ошибка задачи напоминаний за 3 дня:', err);
        }
    }, { timezone: CRON_TIMEZONE });
    // === НАПОМИНАНИЕ ЗА 1 ДЕНЬ ДО ИСТЕЧЕНИЯ (в 18:00) ===
    cron.schedule('0 18 * * *', async () => {
        try {
            console.log(`[Scheduler] Проверка подписок, истекающих завтра...`);
            const expiring = findExpiringSubscriptions(1);
            let sent = 0;
            for (const sub of expiring) {
                if (wasExpiryReminderSent(sub.id, 1))
                    continue;
                const message = [
                    '⏰ Подписка заканчивается завтра',
                    '',
                    'Завтра заканчивается ваша подписка на канал «Психосоматика. Живая правда».',
                    '',
                    'Продлите сейчас, чтобы сохранить доступ к каналу и не пропустить новые материалы.',
                    '',
                    'Нажмите /start в боте для продления. 🤍'
                ].join('\n');
                try {
                    await telegram.sendMessage(sub.telegramUserId, message, { parse_mode: 'HTML' });
                    markExpiryReminderSent(sub.id, 1);
                    sent++;
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                catch (err) {
                    console.error(`[Scheduler] Ошибка напоминания за 1 день userId=${sub.telegramUserId}:`, err);
                }
            }
            console.log(`[Scheduler] Напоминания за 1 день: отправлено ${sent}`);
        }
        catch (err) {
            console.error('[Scheduler] Общая ошибка задачи напоминаний за 1 день:', err);
        }
    }, { timezone: CRON_TIMEZONE });
    // === ОБРАБОТКА ИСТЁКШИХ ПОДПИСОК ===
    // Важно: запускаем регулярно (каждые 15 минут), чтобы не было ощущения "ничего не происходит",
    // и дополнительно делаем запуск при старте (полезно после рестартов контейнера).
    cron.schedule('*/15 * * * *', async () => {
        await processExpiredSubscriptions(telegram, 'cron:*/15');
    }, { timezone: CRON_TIMEZONE });
    setTimeout(() => {
        void processExpiredSubscriptions(telegram, 'startup');
    }, 5_000);
    // === АУДИТ: В КАНАЛЕ, НО НЕТ УСПЕШНОЙ ОПЛАТЫ ===
    // Telegram не даёт получить список всех участников канала, поэтому мы:
    // - кикаем неоплативших при входе по chat_member апдейтам
    // - и регулярно проверяем "известных" пользователей без success-оплат (users/subscriptions/payments)
    //   и кикаем их, если они всё ещё состоят в канале.
    const auditUnpaid = async (reason) => {
        if (unpaidAuditInProgress)
            return;
        unpaidAuditInProgress = true;
        try {
            const unpaid = listUserIdsWithoutSuccessfulPayment();
            if (unpaid.length === 0)
                return;
            console.log(`[Scheduler] Аудит неоплативших (${reason}): кандидатов=${unpaid.length}`);
            let checked = 0;
            let kicked = 0;
            for (const uid of unpaid) {
                if (isAdmin(uid))
                    continue;
                checked++;
                try {
                    const member = await telegram.getChatMember(config.telegramChannelId, uid);
                    const status = member?.status;
                    const isIn = status === 'member' ||
                        status === 'restricted' ||
                        status === 'administrator' ||
                        status === 'creator';
                    if (!isIn)
                        continue;
                    try {
                        await removeUserFromChannel(telegram, config.telegramChannelId, uid);
                        kicked++;
                        console.log(`[Scheduler] Кик (нет оплаты): userId=${uid}`);
                    }
                    catch (err) {
                        console.error(`[Scheduler] Ошибка кика (нет оплаты) userId=${uid}:`, err);
                    }
                }
                catch {
                    // getChatMember может падать если бот не видит пользователя (или пользователь не в чате) — игнорируем
                }
                // антифлуд
                await new Promise(resolve => setTimeout(resolve, 120));
            }
            console.log(`[Scheduler] Аудит неоплативших завершён (${reason}): checked=${checked}, kicked=${kicked}`);
        }
        finally {
            unpaidAuditInProgress = false;
        }
    };
    cron.schedule('0 * * * *', async () => {
        await auditUnpaid('cron:hourly');
    }, { timezone: CRON_TIMEZONE });
    setTimeout(() => {
        void auditUnpaid('startup');
    }, 15_000);
    // Remind users without active subscription (daily at 10:00 Kyiv time)
    cron.schedule('0 10 * * *', async () => {
        console.log(`[Scheduler] Отправка напоминаний пользователям без подписки...`);
        const nowSec = Math.floor(Date.now() / 1000);
        const userIds = listKnownUserIds();
        let sent = 0;
        for (const uid of userIds) {
            const active = hasActiveSubscription(uid, config.telegramChannelId, nowSec);
            if (active)
                continue;
            const last = getLastReminderAt(uid);
            if (last && nowSec - last < 24 * 60 * 60)
                continue; // remind at most once per day
            try {
                await telegram.sendMessage(uid, 'Ваша подписка отсутствует или истекла. Чтобы продолжить доступ к каналу, оформите подписку в боте.');
                setReminderSentNow(uid, nowSec);
                sent++;
            }
            catch (err) {
                console.error(`[Scheduler] Ошибка напоминания userId=${uid}:`, err);
            }
        }
        console.log(`[Scheduler] Напоминания отправлены: ${sent}`);
    }, { timezone: CRON_TIMEZONE });
    // Poll pending payments every 2 minutes (no timezone needed, runs globally)
    cron.schedule('*/2 * * * *', async () => {
        const db = getDb();
        const pending = db.prepare(`SELECT invoiceId, telegramUserId, planCode FROM payments WHERE status IN ('created','processing','holded')`).all();
        for (const p of pending) {
            try {
                const status = await fetchInvoiceStatus(p.invoiceId);
                if (status.status === 'success') {
                    const nowSec = Math.floor(Date.now() / 1000);
                    // Атомарная проверка: если платёж уже обработан другим процессом, пропускаем
                    const updated = tryMarkPaymentSuccess(p.invoiceId, nowSec);
                    if (updated) {
                        const months = PLAN_DETAILS[p.planCode].months;
                        createOrExtendSubscription(p.telegramUserId, config.telegramChannelId, p.planCode, months, nowSec);
                        try {
                            await telegram.sendMessage(p.telegramUserId, 'Оплата получена! Перейдите в бота и получите ссылку на канал, если не получили.');
                        }
                        catch { }
                    }
                }
                else if (status.status === 'failure' || status.status === 'expired' || status.status === 'reversed') {
                    db.prepare(`UPDATE payments SET status=? WHERE invoiceId=?`).run(status.status, p.invoiceId);
                }
            }
            catch {
                // ignore transient errors
            }
        }
    });
}
// Функция для ручного запуска проверки истёкших подписок (для отладки/админ-команды)
export async function runExpiredSubscriptionsCheck(telegram) {
    console.log(`[Scheduler] РУЧНОЙ ЗАПУСК проверки истёкших подписок...`);
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = findExpiredActiveSubscriptions(nowSec);
    console.log(`[Scheduler] Найдено истёкших подписок: ${expired.length}`);
    const errors = [];
    let processed = 0;
    for (const sub of expired) {
        console.log(`[Scheduler] Обработка userId=${sub.telegramUserId}, chatId=${sub.chatId}, endAt=${sub.endAt} (${new Date(sub.endAt * 1000).toISOString()}), now=${nowSec}`);
        let removed = false;
        try {
            // Используем chatId из подписки, а не из конфига
            await removeUserFromChannel(telegram, sub.chatId, sub.telegramUserId);
            console.log(`[Scheduler] Удалён из канала ${sub.chatId}: ${sub.telegramUserId}`);
            removed = true;
        }
        catch (err) {
            const msg = `Ошибка удаления userId=${sub.telegramUserId}: ${err}`;
            console.error(`[Scheduler] ${msg}`);
            errors.push(msg);
        }
        if (removed) {
            deactivateSubscription(sub.id);
        }
        else {
            const msg = `Подписка НЕ деактивирована (удаление не удалось): subId=${sub.id} userId=${sub.telegramUserId}`;
            console.warn(`[Scheduler] ${msg}`);
            errors.push(msg);
        }
        // Чтобы не спамить даже при ручных запусках, тоже соблюдаем правило "1 уведомление на подписку".
        if (!wasExpiryReminderSent(sub.id, EXPIRY_NOTICE_KEY)) {
            try {
                const message = [
                    '😔 Подписка завершена',
                    '',
                    'Срок вашей подписки истёк. Доступ к каналу закрыт.',
                    '',
                    'Выберите тариф для продления:'
                ].join('\n');
                await telegram.sendMessage(sub.telegramUserId, message, {
                    parse_mode: 'HTML',
                    reply_markup: tariffsKeyboard.reply_markup
                });
                markExpiryReminderSent(sub.id, EXPIRY_NOTICE_KEY);
                console.log(`[Scheduler] Уведомление отправлено: ${sub.telegramUserId}`);
                processed++;
            }
            catch (err) {
                const msg = `Ошибка уведомления userId=${sub.telegramUserId}: ${err}`;
                console.error(`[Scheduler] ${msg}`);
                errors.push(msg);
            }
        }
    }
    console.log(`[Scheduler] Ручная проверка завершена. Обработано: ${processed}, ошибок: ${errors.length}`);
    return { processed, errors };
}
// Функция для просмотра истёкших подписок БЕЗ обработки (только диагностика)
export function getExpiredSubscriptionsInfo() {
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = findExpiredActiveSubscriptions(nowSec);
    return {
        count: expired.length,
        subscriptions: expired.map(s => ({
            id: s.id,
            telegramUserId: s.telegramUserId,
            endAt: s.endAt,
            endAtDate: new Date(s.endAt * 1000).toISOString()
        }))
    };
}
//# sourceMappingURL=scheduler.js.map