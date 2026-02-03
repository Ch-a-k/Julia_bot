import { Telegraf, Markup, Context, Telegram } from 'telegraf';
import { config, isAdmin } from './config.js';
import { PLAN_DETAILS } from './types.js';
import { createInvoice, fetchInvoiceStatus } from './monopay.js';
import { insertPayment, hasActiveSubscription, getLastPendingPayment, createOrExtendSubscription, getSetting, setSetting, createSubscriptionForDays, getUserSubscription, saveUserInfo, getExtendedActiveSubscriptions, findUsersByQuery, getActiveSubscribersIds, getUserInfo, getAllUsersForExport, tryMarkPaymentSuccess, hasSuccessfulPayment, hasValidatedPayment, createPaymentValidation, getPendingPaymentValidationForUser, markPaymentValidationConfirmed, recordUserChannelJoin, getRecentPayments } from './db.js';
import { runExpiredSubscriptionsCheck, getExpiredSubscriptionsInfo, runPaymentsCheck } from './scheduler.js';
import { PAYMENT_VALIDATION_TIMEOUT_SEC, INVITE_LINK_EXPIRE_SEC, BROADCAST_DELAY_MS } from './constants.js';
import { getRecentLogs, getRecentErrors, subscribeToLogs, unsubscribeFromLogs, isSubscribed, getLogStats } from './logger.js';
// Форматирование даты на русском
function formatDateRu(timestamp) {
    const date = new Date(timestamp * 1000);
    const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
        'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}
// Форматирование даты и времени
function formatDateTimeRu(timestamp) {
    const date = new Date(timestamp * 1000);
    const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн',
        'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    const hours = date.getHours().toString().padStart(2, '0');
    const mins = date.getMinutes().toString().padStart(2, '0');
    return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()} ${hours}:${mins}`;
}
// Состояние для broadcast (хранится в памяти, сбрасывается при перезапуске)
const broadcastState = new Map();
export async function generateInviteLink(telegram, userId) {
    const nowSec = Math.floor(Date.now() / 1000);
    try {
        const invite = await telegram.createChatInviteLink(config.telegramChannelId, {
            expire_date: nowSec + INVITE_LINK_EXPIRE_SEC,
            member_limit: 1,
            creates_join_request: false,
            name: `access-${userId}-${Date.now()}`,
        });
        return invite.invite_link || invite.inviteLink;
    }
    catch (err) {
        console.error('[InviteLink] Ошибка создания персональной ссылки:', err);
        try {
            return await telegram.exportChatInviteLink(config.telegramChannelId);
        }
        catch (err2) {
            console.error('[InviteLink] Ошибка экспорта общей ссылки:', err2);
            return undefined;
        }
    }
}
export function createBot() {
    const bot = new Telegraf(config.telegramBotToken);
    async function isUserSubscribed(userId) {
        try {
            const member = await bot.telegram.getChatMember(config.telegramChannelId, userId);
            return member.status !== 'left' && member.status !== 'kicked';
        }
        catch {
            return false;
        }
    }
    async function generateInviteLinkFor(userId) {
        return generateInviteLink(bot.telegram, userId);
    }
    const welcomeText = [
        'Телеграм-канал «Психосоматика. Живая правда с Юлией Самошиной»',
        '',
        'Здесь дважды в месяц проходят терапевтические встречи, в которых мы вместе проживаем важные процессы и ищем опору в настоящем.',
        '',
        'Я делюсь своим опытом, практиками и осознаниями, которые помогают глубже соприкасаться с собой и возвращаться к внутреннему равновесию.',
        '',
        'Это пространство открыто для диалога: здесь можно делиться своим опытом, задавать вопросы и получать поддержку.',
        '',
        'Мы будем исследовать психосоматику в её современном прочтении — опираясь как на личные наблюдения и практику, так и на различные источники, включая ГНМ (Германскую Новую Медицину) и другие подходы.',
        '',
        'Моя цель — создать качественное пространство, в котором каждый сможет глубже понять себя, найти собственные ответы, открыть новые смыслы и почувствовать, что он не один на своём пути.'
    ].join('\n');
    const tariffsKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Подписка 1 месяц — 700₴', 'buy:P1M')],
        [Markup.button.callback('Подписка 2 месяца — 1200₴', 'buy:P2M')],
    ]);
    // Экспортируемая функция для создания клавиатуры тарифов (для scheduler)
    bot.getTariffsKeyboard = () => tariffsKeyboard;
    const mainMenuInline = () => Markup.inlineKeyboard([
        [Markup.button.callback('Оформить подписку', 'menu:subscribe')],
        [Markup.button.callback('Проверить доступ', 'menu:check')],
    ]);
    bot.start(async (ctx) => {
        // Ignore /start from group/supergroup chats
        if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
            return;
        }
        // Сохраняем информацию о пользователе
        if (ctx.from) {
            saveUserInfo({
                telegramUserId: ctx.from.id,
                username: ctx.from.username ?? null,
                firstName: ctx.from.first_name ?? null,
                lastName: ctx.from.last_name ?? null,
            });
        }
        try {
            const attributionSpoiler = config.creatorLink ? `\n\n<tg-spoiler>Создано: ${config.creatorLink}</tg-spoiler>` : '';
            const fullText = `${welcomeText}${attributionSpoiler}`;
            const storedFileId = getSetting('WELCOME_PHOTO_FILE_ID');
            if (storedFileId) {
                // 1) Фото без кнопок
                await ctx.replyWithPhoto(storedFileId, { caption: '' });
                // 2) Описание с кнопками (кнопки под описанием)
                await ctx.reply(fullText, { parse_mode: 'HTML', reply_markup: mainMenuInline().reply_markup });
            }
            else {
                await ctx.reply(fullText, { parse_mode: 'HTML', reply_markup: mainMenuInline().reply_markup });
            }
        }
        catch (e) {
            // eslint-disable-next-line no-console
            console.error('Failed to send welcome photo:', e);
            const attributionSpoiler = config.creatorLink ? `\n\n<tg-spoiler>Создано: ${config.creatorLink}</tg-spoiler>` : '';
            const text = `${welcomeText}${attributionSpoiler}`;
            await ctx.reply(text, { parse_mode: 'HTML', reply_markup: mainMenuInline().reply_markup });
        }
    });
    // Command for users in the channel but without subscription: remind to pay
    bot.command('pay', async (ctx) => {
        await ctx.reply('Чтобы продолжить доступ к каналу, оформите подписку:', tariffsKeyboard);
    });
    // Menu actions via inline buttons (to allow message editing)
    bot.action('menu:info', async (ctx) => {
        const attributionSpoiler = config.creatorLink ? `\n\n<tg-spoiler>Создано: ${config.creatorLink}</tg-spoiler>` : '';
        const text = `${welcomeText}${attributionSpoiler}`;
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: mainMenuInline().reply_markup });
    });
    bot.action('menu:subscribe', async (ctx) => {
        const text = 'Выберите тариф подписки:';
        const message = ctx.callbackQuery?.message;
        const isPhoto = Array.isArray(message?.photo) && message.photo.length > 0;
        const opts = { reply_markup: tariffsKeyboard.reply_markup };
        if (isPhoto) {
            await ctx.editMessageCaption(text, opts);
        }
        else {
            await ctx.editMessageText(text, opts);
        }
    });
    bot.action('menu:check', async (ctx) => {
        const user = ctx.from;
        if (!user)
            return;
        const nowSec = Math.floor(Date.now() / 1000);
        // Admin always gets an invite link
        if (isAdmin(user.id)) {
            const link = await generateInviteLinkFor(user.id);
            const kb = Markup.inlineKeyboard([
                link ? [Markup.button.url('Перейти в канал', link)] : [],
                [Markup.button.callback('◀︎ Назад в меню', 'menu:info')],
            ].filter(r => r.length > 0));
            const text = link ? 'Админ-доступ: нажмите, чтобы перейти в канал.' : 'Не удалось создать ссылку. Проверьте права бота.';
            const message = ctx.callbackQuery?.message;
            const isPhoto = Array.isArray(message?.photo) && message.photo.length > 0;
            const opts = { reply_markup: kb.reply_markup };
            if (isPhoto)
                await ctx.editMessageCaption(text, opts);
            else
                await ctx.editMessageText(text, opts);
            return;
        }
        // Доступ даём только при активной подписке + наличии успешной оплаты.
        // Это закрывает кейс "в subscriptions есть запись (например, тест/ручная), но в payments нет".
        const active = hasActiveSubscription(user.id, config.telegramChannelId, nowSec) && hasValidatedPayment(user.id);
        const message = ctx.callbackQuery?.message;
        const isPhoto = Array.isArray(message?.photo) && message.photo.length > 0;
        if (active) {
            const link = await generateInviteLinkFor(user.id);
            const kb = Markup.inlineKeyboard([
                link ? [Markup.button.url('Перейти в канал', link)] : [],
                [Markup.button.callback('◀︎ Назад в меню', 'menu:info')],
            ].filter(r => r.length > 0));
            const text = link ? 'У вас активная подписка. Нажмите, чтобы перейти в канал.' : 'У вас активная подписка, но не удалось создать ссылку. Свяжитесь с поддержкой.';
            const opts = { reply_markup: kb.reply_markup };
            if (isPhoto)
                await ctx.editMessageCaption(text, opts);
            else
                await ctx.editMessageText(text, opts);
        }
        else {
            const pendingValidation = getPendingPaymentValidationForUser(user.id, nowSec);
            if (pendingValidation) {
                const isInChannel = await isUserSubscribed(user.id);
                if (isInChannel) {
                    const updated = markPaymentValidationConfirmed(pendingValidation.invoiceId, nowSec, nowSec);
                    if (updated) {
                        const months = PLAN_DETAILS[pendingValidation.planCode].months;
                        createOrExtendSubscription(user.id, config.telegramChannelId, pendingValidation.planCode, months, nowSec);
                    }
                    const link = await generateInviteLinkFor(user.id);
                    const kb = Markup.inlineKeyboard([
                        link ? [Markup.button.url('Перейти в канал', link)] : [],
                        [Markup.button.callback('◀︎ Назад в меню', 'menu:info')],
                    ].filter(r => r.length > 0));
                    const text = link ? 'Оплата подтверждена. Нажмите, чтобы перейти в канал.' : 'Оплата подтверждена, но не удалось создать ссылку. Свяжитесь с поддержкой.';
                    const opts = { reply_markup: kb.reply_markup };
                    if (isPhoto)
                        await ctx.editMessageCaption(text, opts);
                    else
                        await ctx.editMessageText(text, opts);
                    return;
                }
                const link = await generateInviteLinkFor(user.id);
                const kb = Markup.inlineKeyboard([
                    link ? [Markup.button.url('Перейти в канал', link)] : [],
                    [Markup.button.callback('◀︎ Назад в меню', 'menu:info')],
                ].filter(r => r.length > 0));
                const text = link
                    ? 'Оплата в обработке. Перейдите по ссылке в течение 10 минут для подтверждения.'
                    : 'Оплата в обработке. Перейдите в бота и получите ссылку. На подтверждение есть 10 минут.';
                const opts = { reply_markup: kb.reply_markup };
                if (isPhoto)
                    await ctx.editMessageCaption(text, opts);
                else
                    await ctx.editMessageText(text, opts);
                return;
            }
            const pending = getLastPendingPayment(user.id);
            if (pending) {
                try {
                    const status = await fetchInvoiceStatus(pending.invoiceId);
                    if (status.status === 'success') {
                        // Атомарная проверка: если платёж уже обработан, пропускаем
                        const updated = tryMarkPaymentSuccess(pending.invoiceId, nowSec);
                        if (updated) {
                            const isInChannel = await isUserSubscribed(user.id);
                            if (isInChannel) {
                                const months = PLAN_DETAILS[pending.planCode].months;
                                createOrExtendSubscription(user.id, config.telegramChannelId, pending.planCode, months, nowSec);
                                createPaymentValidation({
                                    invoiceId: pending.invoiceId,
                                    telegramUserId: user.id,
                                    planCode: pending.planCode,
                                    paidAt: nowSec,
                                    deadlineAt: nowSec,
                                    status: 'confirmed',
                                    confirmedAt: nowSec,
                                    joinAt: nowSec,
                                });
                            }
                            else {
                                createPaymentValidation({
                                    invoiceId: pending.invoiceId,
                                    telegramUserId: user.id,
                                    planCode: pending.planCode,
                                    paidAt: nowSec,
                                    deadlineAt: nowSec + PAYMENT_VALIDATION_TIMEOUT_SEC,
                                    status: 'pending',
                                    confirmedAt: null,
                                    joinAt: null,
                                });
                            }
                        }
                        else {
                            const isInChannel = await isUserSubscribed(user.id);
                            createPaymentValidation({
                                invoiceId: pending.invoiceId,
                                telegramUserId: user.id,
                                planCode: pending.planCode,
                                paidAt: nowSec,
                                deadlineAt: isInChannel ? nowSec : nowSec + PAYMENT_VALIDATION_TIMEOUT_SEC,
                                status: isInChannel ? 'confirmed' : 'pending',
                                confirmedAt: isInChannel ? nowSec : null,
                                joinAt: isInChannel ? nowSec : null,
                            });
                        }
                        const link = await generateInviteLinkFor(user.id);
                        const kb = Markup.inlineKeyboard([
                            link ? [Markup.button.url('Перейти в канал', link)] : [],
                            [Markup.button.callback('◀︎ Назад в меню', 'menu:info')],
                        ].filter(r => r.length > 0));
                        const text = link
                            ? 'Оплата найдена. Нажмите, чтобы перейти в канал (на подтверждение есть 10 минут).'
                            : 'Оплата найдена, но не удалось создать ссылку. Свяжитесь с поддержкой.';
                        const opts = { reply_markup: kb.reply_markup };
                        if (isPhoto)
                            await ctx.editMessageCaption(text, opts);
                        else
                            await ctx.editMessageText(text, opts);
                        return;
                    }
                }
                catch (err) {
                    console.error('[CheckAccess] Ошибка проверки статуса pending платежа:', err);
                }
            }
            const kb = Markup.inlineKeyboard([
                [Markup.button.callback('Оформить подписку', 'menu:subscribe')],
                [Markup.button.callback('◀︎ Назад в меню', 'menu:info')],
            ]);
            const text = 'Доступ отсутствует. Оформите подписку.';
            const opts = { reply_markup: kb.reply_markup };
            if (isPhoto)
                await ctx.editMessageCaption(text, opts);
            else
                await ctx.editMessageText(text, opts);
        }
    });
    // Fallback: ignore random messages to avoid history spam
    bot.on('message', async (_ctx, next) => {
        return next();
    });
    // Обработчик фото: для админа — сохраняет как приветственное, для всех — показывает file_id
    bot.on('photo', async (ctx) => {
        const photos = ctx.message.photo;
        if (!photos || photos.length === 0)
            return;
        const best = photos[photos.length - 1];
        if (!best)
            return;
        const fileId = best.file_id;
        if (!fileId)
            return;
        if (isAdmin(ctx.from?.id)) {
            // Админ: сохраняем как приветственное фото
            setSetting('WELCOME_PHOTO_FILE_ID', fileId);
            await ctx.reply(`✅ Сохранено как приветственное фото.\n\nfile_id: <code>${fileId}</code>`, { parse_mode: 'HTML' });
        }
        else {
            // Обычный пользователь: просто показываем file_id (для отладки)
            await ctx.reply(`file_id: ${fileId}`);
        }
    });
    // Helper: show own user id
    bot.command('whoami', async (ctx) => {
        await ctx.reply(`Ваш Telegram ID: ${ctx.from?.id ?? 'неизвестен'}`);
    });
    // Admin-only: generate one-time invite link on demand
    bot.command('invitelink', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        try {
            const link = await generateInviteLinkFor(ctx.from.id);
            await ctx.reply(link ? `Ссылка: ${link}` : 'Не удалось создать ссылку.');
        }
        catch (err) {
            console.error('[InviteLink] Ошибка команды invitelink:', err);
            await ctx.reply('Ошибка создания ссылки.');
        }
    });
    // Admin-only: check expired subscriptions (diagnostic, no action)
    bot.command('checkexpired', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        try {
            const info = getExpiredSubscriptionsInfo();
            if (info.count === 0) {
                await ctx.reply('✅ Нет истёкших подписок для обработки.');
            }
            else {
                const lines = info.subscriptions.map(s => `• ID: ${s.id}, User: ${s.telegramUserId}, Истекла: ${s.endAtDate}`);
                await ctx.reply(`⚠️ Найдено ${info.count} истёкших подписок:\n\n${lines.join('\n')}\n\nДля обработки: /processexpired`);
            }
        }
        catch (err) {
            await ctx.reply(`Ошибка: ${err}`);
        }
    });
    // Admin-only: manually process expired subscriptions
    bot.command('processexpired', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        try {
            await ctx.reply('🔄 Запускаю обработку истёкших подписок...');
            const result = await runExpiredSubscriptionsCheck(ctx.telegram);
            if (result.processed === 0 && result.errors.length === 0) {
                await ctx.reply('✅ Нет истёкших подписок для обработки.');
            }
            else {
                let msg = `✅ Обработано: ${result.processed}`;
                if (result.errors.length > 0) {
                    msg += `\n\n⚠️ Ошибки (${result.errors.length}):\n${result.errors.slice(0, 5).join('\n')}`;
                    if (result.errors.length > 5) {
                        msg += `\n...и ещё ${result.errors.length - 5}`;
                    }
                }
                await ctx.reply(msg);
            }
        }
        catch (err) {
            await ctx.reply(`Ошибка: ${err}`);
        }
    });
    // Admin-only: start broadcast wizard
    bot.command('broadcast', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const allSubscribers = getActiveSubscribersIds();
        if (allSubscribers.length === 0) {
            await ctx.reply('📭 Нет активных подписок для рассылки.');
            return;
        }
        // Инициализируем состояние
        broadcastState.set(ctx.from.id, {
            message: '',
            recipients: [],
            recipientsType: 'all',
            step: 'recipients'
        });
        const kb = Markup.inlineKeyboard([
            [Markup.button.callback(`📢 Всем подписчикам (${allSubscribers.length})`, 'bc:all')],
            [Markup.button.callback('👥 Выбрать конкретных', 'bc:select')],
            [Markup.button.callback('❌ Отмена', 'bc:cancel')],
        ]);
        await ctx.reply('📤 <b>Рассылка сообщений</b>\n\n' +
            'Выберите, кому отправить сообщение:', { parse_mode: 'HTML', reply_markup: kb.reply_markup });
    });
    // Broadcast: выбрать всех
    bot.action('bc:all', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const state = broadcastState.get(ctx.from.id);
        if (!state) {
            await ctx.answerCbQuery('Сессия истекла. Начните заново: /broadcast');
            return;
        }
        const allSubscribers = getActiveSubscribersIds();
        state.recipients = allSubscribers;
        state.recipientsType = 'all';
        state.step = 'message';
        broadcastState.set(ctx.from.id, state);
        await ctx.editMessageText(`📤 <b>Рассылка для ${allSubscribers.length} подписчиков</b>\n\n` +
            'Теперь отправьте текст сообщения.\n\n' +
            '<i>Можно использовать HTML-форматирование:</i>\n' +
            '• <code>&lt;b&gt;жирный&lt;/b&gt;</code>\n' +
            '• <code>&lt;i&gt;курсив&lt;/i&gt;</code>\n' +
            '• <code>{date}</code> — дата окончания подписки\n\n' +
            'Или отправьте /broadcast_cancel для отмены.', { parse_mode: 'HTML' });
        await ctx.answerCbQuery();
    });
    // Broadcast: выбрать конкретных
    bot.action('bc:select', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const state = broadcastState.get(ctx.from.id);
        if (!state) {
            await ctx.answerCbQuery('Сессия истекла. Начните заново: /broadcast');
            return;
        }
        state.recipientsType = 'selected';
        state.step = 'recipients';
        broadcastState.set(ctx.from.id, state);
        await ctx.editMessageText('👥 <b>Выбор получателей</b>\n\n' +
            'Отправьте ID или @username через запятую:\n\n' +
            '<code>123456789, @username, 987654321</code>\n\n' +
            'Или отправьте /broadcast_cancel для отмены.', { parse_mode: 'HTML' });
        await ctx.answerCbQuery();
    });
    // Broadcast: подтверждение отправки
    bot.action('bc:confirm', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const state = broadcastState.get(ctx.from.id);
        if (!state || !state.message || state.recipients.length === 0) {
            await ctx.answerCbQuery('Сессия истекла. Начните заново: /broadcast');
            return;
        }
        await ctx.editMessageText('⏳ Отправка...');
        await ctx.answerCbQuery();
        let sent = 0;
        let failed = 0;
        const errors = [];
        for (const userId of state.recipients) {
            try {
                // Получаем подписку пользователя для подстановки даты
                const sub = getUserSubscription(userId, config.telegramChannelId);
                let personalizedMessage = state.message;
                if (sub) {
                    const endDate = formatDateRu(sub.endAt);
                    personalizedMessage = personalizedMessage.replace(/\{date\}/g, endDate);
                }
                else {
                    personalizedMessage = personalizedMessage.replace(/\{date\}/g, '—');
                }
                await ctx.telegram.sendMessage(userId, personalizedMessage, { parse_mode: 'HTML' });
                sent++;
                await new Promise(resolve => setTimeout(resolve, BROADCAST_DELAY_MS));
            }
            catch (err) {
                failed++;
                const userInfo = getUserInfo(userId);
                const userLabel = userInfo?.username ? `@${userInfo.username}` : `ID:${userId}`;
                errors.push(`${userLabel}: ${String(err).slice(0, 50)}`);
            }
        }
        broadcastState.delete(ctx.from.id);
        let report = `✅ <b>Рассылка завершена!</b>\n\n📬 Отправлено: ${sent}\n❌ Ошибок: ${failed}`;
        if (errors.length > 0) {
            report += `\n\n⚠️ Ошибки:\n${errors.slice(0, 5).join('\n')}`;
            if (errors.length > 5) {
                report += `\n<i>...и ещё ${errors.length - 5}</i>`;
            }
        }
        await ctx.editMessageText(report, { parse_mode: 'HTML' });
    });
    // Broadcast: отмена
    bot.action('bc:cancel', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        broadcastState.delete(ctx.from.id);
        await ctx.editMessageText('❌ Рассылка отменена.');
        await ctx.answerCbQuery();
    });
    // Broadcast: команда отмены
    bot.command('broadcast_cancel', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        broadcastState.delete(ctx.from.id);
        await ctx.reply('❌ Рассылка отменена.');
    });
    // Обработка текстовых сообщений для broadcast
    bot.on('text', async (ctx, next) => {
        if (!isAdmin(ctx.from?.id)) {
            return next();
        }
        const state = broadcastState.get(ctx.from.id);
        if (!state) {
            return next();
        }
        const text = ctx.message.text;
        // Шаг: выбор конкретных получателей
        if (state.step === 'recipients' && state.recipientsType === 'selected') {
            const queries = text.split(/[,\s]+/).filter(q => q.trim());
            const foundIds = [];
            const notFound = [];
            for (const q of queries) {
                const cleanQ = q.replace('@', '').trim();
                if (!cleanQ)
                    continue;
                const ids = findUsersByQuery(cleanQ);
                if (ids.length > 0) {
                    foundIds.push(...ids);
                }
                else {
                    notFound.push(q);
                }
            }
            const uniqueIds = [...new Set(foundIds)];
            if (uniqueIds.length === 0) {
                await ctx.reply('❌ Не найдено ни одного пользователя.\n\n' +
                    'Попробуйте снова или /broadcast_cancel для отмены.');
                return;
            }
            state.recipients = uniqueIds;
            state.step = 'message';
            broadcastState.set(ctx.from.id, state);
            let msg = `✅ Найдено получателей: ${uniqueIds.length}\n\n`;
            if (notFound.length > 0) {
                msg += `⚠️ Не найдены: ${notFound.join(', ')}\n\n`;
            }
            msg += 'Теперь отправьте текст сообщения.\n\n' +
                '<i>Используйте {date} для подстановки даты окончания подписки.</i>';
            await ctx.reply(msg, { parse_mode: 'HTML' });
            return;
        }
        // Шаг: ввод сообщения
        if (state.step === 'message') {
            state.message = text;
            state.step = 'preview';
            broadcastState.set(ctx.from.id, state);
            // Показываем предпросмотр
            const previewText = text.replace(/\{date\}/g, '<i>[дата подписки]</i>');
            const kb = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Отправить', 'bc:confirm')],
                [Markup.button.callback('✏️ Изменить текст', 'bc:edit')],
                [Markup.button.callback('❌ Отмена', 'bc:cancel')],
            ]);
            await ctx.reply(`📋 <b>ПРЕДПРОСМОТР</b>\n` +
                `Получателей: ${state.recipients.length}\n\n` +
                `────────────────\n\n` +
                `${previewText}\n\n` +
                `────────────────\n\n` +
                `⚠️ Проверьте сообщение и нажмите "Отправить"`, { parse_mode: 'HTML', reply_markup: kb.reply_markup });
            return;
        }
        return next();
    });
    // Broadcast: изменить текст
    bot.action('bc:edit', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const state = broadcastState.get(ctx.from.id);
        if (!state) {
            await ctx.answerCbQuery('Сессия истекла. Начните заново: /broadcast');
            return;
        }
        state.step = 'message';
        state.message = '';
        broadcastState.set(ctx.from.id, state);
        await ctx.editMessageText('✏️ Отправьте новый текст сообщения:', { parse_mode: 'HTML' });
        await ctx.answerCbQuery();
    });
    // Admin-only: list all active subscriptions with extended info
    bot.command('listsubs', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const subscriptions = getExtendedActiveSubscriptions();
        if (subscriptions.length === 0) {
            await ctx.reply('📭 Нет активных подписок.');
            return;
        }
        // Формируем сообщения для каждого подписчика
        const formatSub = (sub, idx) => {
            const lines = [];
            lines.push(`<b>${idx}.</b>`);
            // Имя и никнейм
            const nameParts = [];
            if (sub.firstName)
                nameParts.push(sub.firstName);
            if (sub.lastName)
                nameParts.push(sub.lastName);
            const fullName = nameParts.length > 0 ? nameParts.join(' ') : '—';
            lines.push(`👤 ${fullName}`);
            if (sub.username) {
                lines.push(`📱 @${sub.username}`);
            }
            lines.push(`🆔 <code>${sub.telegramUserId}</code>`);
            if (sub.phone) {
                lines.push(`📞 ${sub.phone}`);
            }
            // Тариф
            const planNames = {
                'P1M': '1 месяц',
                'P2M': '2 месяца',
                'TEST': 'Тест'
            };
            lines.push(`📦 ${planNames[sub.planCode] || sub.planCode}`);
            // Дата оплаты
            if (sub.paidAt) {
                lines.push(`💳 Оплата: ${formatDateTimeRu(sub.paidAt)}`);
            }
            // Сумма
            if (sub.amount) {
                lines.push(`💰 ${(sub.amount / 100).toFixed(0)}₴`);
            }
            // Дата окончания
            lines.push(`⏰ До: <b>${formatDateTimeRu(sub.endAt)}</b>`);
            return lines.join('\n');
        };
        // Отправляем заголовок
        await ctx.reply(`📋 <b>Активные подписки: ${subscriptions.length}</b>`, { parse_mode: 'HTML' });
        // Разбиваем на части (по 5 подписчиков на сообщение для читаемости)
        const chunkSize = 5;
        for (let i = 0; i < subscriptions.length; i += chunkSize) {
            const chunk = subscriptions.slice(i, i + chunkSize);
            const text = chunk.map((sub, idx) => formatSub(sub, i + idx + 1)).join('\n\n────────────────\n\n');
            await ctx.reply(text, { parse_mode: 'HTML' });
            // Небольшая задержка между сообщениями
            if (i + chunkSize < subscriptions.length) {
                await new Promise(resolve => setTimeout(resolve, BROADCAST_DELAY_MS));
            }
        }
    });
    // Admin-only: list recent payments (analytics)
    bot.command('payments', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const args = ctx.message.text.split(' ').slice(1);
        const limit = Math.min(Math.max(parseInt(args[0] || '10', 10) || 10, 1), 50);
        const payments = getRecentPayments(limit);
        if (payments.length === 0) {
            await ctx.reply('📭 Нет платежей.');
            return;
        }
        const formatPay = (p, idx) => {
            const lines = [];
            const nameParts = [];
            if (p.firstName)
                nameParts.push(p.firstName);
            if (p.lastName)
                nameParts.push(p.lastName);
            const fullName = nameParts.length > 0 ? nameParts.join(' ') : '—';
            const paidAt = p.paidAt ? formatDateTimeRu(p.paidAt) : '—';
            const createdAt = formatDateTimeRu(p.createdAt);
            const validationStatus = p.validationStatus || '—';
            const validationAt = p.validationConfirmedAt ? formatDateTimeRu(p.validationConfirmedAt) : '—';
            lines.push(`<b>${idx}.</b>`);
            lines.push(`👤 ${fullName}`);
            if (p.username)
                lines.push(`📱 @${p.username}`);
            lines.push(`🆔 <code>${p.telegramUserId}</code>`);
            lines.push(`📦 ${p.planCode}`);
            lines.push(`💰 ${(p.amount / 100).toFixed(0)}₴`);
            lines.push(`🧾 Статус: ${p.status}`);
            lines.push(`🕒 Создан: ${createdAt}`);
            lines.push(`✅ Оплачен: ${paidAt}`);
            lines.push(`🔎 Валидация: ${validationStatus} (${validationAt})`);
            return lines.join('\n');
        };
        await ctx.reply(`📈 <b>Последние платежи: ${payments.length}</b>`, { parse_mode: 'HTML' });
        const chunkSize = 5;
        for (let i = 0; i < payments.length; i += chunkSize) {
            const chunk = payments.slice(i, i + chunkSize);
            const text = chunk.map((p, idx) => formatPay(p, i + idx + 1)).join('\n\n────────────────\n\n');
            await ctx.reply(text, { parse_mode: 'HTML' });
            if (i + chunkSize < payments.length) {
                await new Promise(resolve => setTimeout(resolve, BROADCAST_DELAY_MS));
            }
        }
    });
    // Admin-only: grant test subscription for N days
    // Usage: /grantsub USER_ID DAYS
    bot.command('grantsub', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const args = ctx.message.text.split(' ').slice(1);
        if (args.length < 2) {
            await ctx.reply('📝 Использование: /grantsub USER_ID DAYS\n\n' +
                'Примеры:\n' +
                '• /grantsub 123456789 1 — подписка на 1 день\n' +
                '• /grantsub 123456789 7 — подписка на неделю\n' +
                '• /grantsub 123456789 30 — подписка на месяц\n\n' +
                '💡 Узнать свой ID: /whoami');
            return;
        }
        const userId = parseInt(args[0] || '', 10);
        const days = parseInt(args[1] || '', 10);
        if (isNaN(userId) || isNaN(days) || days <= 0) {
            await ctx.reply('❌ Неверные параметры. USER_ID и DAYS должны быть числами, DAYS > 0.');
            return;
        }
        try {
            const subscription = createSubscriptionForDays(userId, config.telegramChannelId, days);
            const endDate = formatDateRu(subscription.endAt);
            // Чтобы такие пользователи не считались "неоплатившими" по новой логике,
            // фиксируем "подарочную" успешную оплату (amount=0) если у пользователя нет success оплат.
            try {
                if (!hasSuccessfulPayment(userId)) {
                    const nowSec = Math.floor(Date.now() / 1000);
                    insertPayment({
                        invoiceId: `manual_grant_${userId}_${nowSec}`,
                        telegramUserId: userId,
                        planCode: 'TEST',
                        amount: 0,
                        status: 'success',
                        createdAt: nowSec,
                        paidAt: nowSec,
                    });
                }
            }
            catch (err) {
                // не делаем фатальным — подписка уже создана
                console.warn('[GrantSub] Не удалось записать "подарочную" оплату:', err);
            }
            await ctx.reply(`✅ Подписка создана!\n\n` +
                `👤 User ID: ${userId}\n` +
                `📅 Срок: ${days} дн.\n` +
                `🔚 Действует до: ${endDate}`);
            // Уведомляем пользователя
            try {
                const link = await generateInviteLinkFor(userId);
                const userMessage = link
                    ? `🎁 Вам предоставлен доступ к каналу на ${days} дн.!\n\nВаша ссылка для входа: ${link}`
                    : `🎁 Вам предоставлен доступ к каналу на ${days} дн.! Перейдите в бота, чтобы получить ссылку.`;
                await ctx.telegram.sendMessage(userId, userMessage);
                await ctx.reply('📨 Пользователь уведомлён.');
            }
            catch (err) {
                console.error('[GrantSub] Ошибка уведомления пользователя:', err);
                await ctx.reply('⚠️ Не удалось уведомить пользователя (возможно, он не начинал диалог с ботом).');
            }
        }
        catch (err) {
            await ctx.reply(`❌ Ошибка: ${err}`);
        }
    });
    // Admin-only: revoke subscription
    // Usage: /revokesub USER_ID
    bot.command('revokesub', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const args = ctx.message.text.split(' ').slice(1);
        if (args.length < 1) {
            await ctx.reply('📝 Использование: /revokesub USER_ID\n\n' +
                'Пример: /revokesub 123456789\n\n' +
                '⚠️ Подписка будет деактивирована, пользователь удалён из канала.');
            return;
        }
        const userId = parseInt(args[0] || '', 10);
        if (isNaN(userId)) {
            await ctx.reply('❌ Неверный USER_ID. Должно быть число.');
            return;
        }
        try {
            const { revokeUserSubscription } = await import('./db.js');
            const revoked = revokeUserSubscription(userId, config.telegramChannelId);
            if (!revoked) {
                await ctx.reply(`⚠️ У пользователя ${userId} нет активной подписки.`);
                return;
            }
            // Удаляем из канала
            try {
                await removeUserFromChannel(ctx.telegram, config.telegramChannelId, userId);
                await ctx.reply(`✅ Подписка пользователя ${userId} отозвана, доступ к каналу закрыт.`);
            }
            catch (err) {
                console.error('[RevokeSub] Ошибка удаления из канала:', err);
                await ctx.reply(`✅ Подписка отозвана, но не удалось удалить из канала (возможно, уже не в канале).`);
            }
            // Уведомляем пользователя
            try {
                await ctx.telegram.sendMessage(userId, 'Ваша подписка была отозвана. Доступ к каналу закрыт.');
            }
            catch (err) {
                console.error('[RevokeSub] Ошибка уведомления пользователя:', err);
            }
        }
        catch (err) {
            await ctx.reply(`❌ Ошибка: ${err}`);
        }
    });
    // Admin-only: export users to CSV
    bot.command('export', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        try {
            await ctx.reply('⏳ Формирую файл экспорта...');
            const users = getAllUsersForExport();
            if (users.length === 0) {
                await ctx.reply('📭 Нет данных для экспорта.');
                return;
            }
            // Формируем CSV
            const formatDate = (ts) => {
                if (!ts)
                    return '';
                const d = new Date(ts * 1000);
                return `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
            };
            const planNames = {
                'P1M': '1 месяц (700 грн)',
                'P2M': '2 месяца (1200 грн)',
                'TEST': 'Тестовая'
            };
            const csvRows = [];
            // Заголовок
            csvRows.push([
                'Telegram ID',
                'Username',
                'Имя',
                'Фамилия',
                'Телефон',
                'Активная подписка',
                'Подписка до',
                'Купленный тариф',
                'Последняя оплата (грн)',
                'Дата оплаты',
                'Всего оплачено (грн)',
                'Статус валидации',
                'Дата валидации'
            ].join(';'));
            // Данные
            for (const u of users) {
                csvRows.push([
                    u.telegramUserId,
                    u.username ? `@${u.username}` : '',
                    u.firstName || '',
                    u.lastName || '',
                    u.phone || '',
                    u.hasActiveSubscription ? 'Да' : 'Нет',
                    formatDate(u.subscriptionEndAt),
                    u.purchasedPlanCode ? (planNames[u.purchasedPlanCode] || u.purchasedPlanCode) : '',
                    u.lastPaymentAmount ? (u.lastPaymentAmount / 100).toFixed(0) : '',
                    formatDate(u.lastPaymentAt),
                    u.totalPaid ? (u.totalPaid / 100).toFixed(0) : '0',
                    u.lastPaymentValidationStatus || '',
                    formatDate(u.lastPaymentValidationAt)
                ].join(';'));
            }
            const csvContent = csvRows.join('\n');
            const buffer = Buffer.from('\uFEFF' + csvContent, 'utf-8'); // BOM для Excel
            const activeCount = users.filter(u => u.hasActiveSubscription).length;
            const inactiveCount = users.length - activeCount;
            await ctx.replyWithDocument({ source: buffer, filename: `users_export_${new Date().toISOString().slice(0, 10)}.csv` }, {
                caption: `📊 Экспорт пользователей\n\n` +
                    `👥 Всего: ${users.length}\n` +
                    `✅ С подпиской: ${activeCount}\n` +
                    `❌ Без подписки: ${inactiveCount}`
            });
        }
        catch (err) {
            await ctx.reply(`❌ Ошибка экспорта: ${err}`);
        }
    });
    // Admin-only: show help for admin commands
    bot.command('adminhelp', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const help = [
            '🔧 <b>АДМИН-КОМАНДЫ</b>',
            '',
            '━━━━ <b>📋 Подписки</b> ━━━━',
            '',
            '/listsubs — <i>список активных подписчиков</i>',
            '/checkexpired — <i>истёкшие подписки</i>',
            '/processexpired — <i>удалить из канала</i>',
            '/grantsub ID ДНИ — <i>выдать подписку</i>',
            '/revokesub ID — <i>забрать подписку</i>',
            '/export — <i>скачать CSV всех пользователей</i>',
            '/payments [N] — <i>последние платежи и валидация</i>',
            '/checkpayments — <i>принудительная проверка оплат</i>',
            '',
            '━━━━ <b>📤 Рассылка</b> ━━━━',
            '',
            '/broadcast — <i>рассылка с предпросмотром</i>',
            '',
            '━━━━ <b>📊 Логи и мониторинг</b> ━━━━',
            '',
            '/logs [N] — <i>последние N логов (по умолчанию 50)</i>',
            '/errors [N] — <i>последние N ошибок (по умолчанию 20)</i>',
            '/logstream — <i>подписаться на логи в реальном времени</i>',
            '/stopstream — <i>отписаться от логов</i>',
            '/logstats — <i>статистика логов</i>',
            '',
            '━━━━ <b>⚙️ Прочее</b> ━━━━',
            '',
            '/invitelink — <i>Одноразовая ссылка на канал</i>',
            '/diag — <i>диагностика бота и подписок</i>',
            '/whoami — <i>узнать ID</i>',
        ].join('\n');
        await ctx.reply(help, { parse_mode: 'HTML' });
    });
    // Admin-only: получить последние логи
    bot.command('logs', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const args = ctx.message.text.split(' ').slice(1);
        const count = Math.min(Math.max(parseInt(args[0] || '50', 10) || 50, 1), 100);
        try {
            const logs = getRecentLogs(count);
            // Разбиваем на части если слишком длинное
            const maxLength = 4000;
            if (logs.length <= maxLength) {
                await ctx.reply(`📋 <b>Последние ${count} логов:</b>\n\n<code>${logs}</code>`, { parse_mode: 'HTML' });
            }
            else {
                // Отправляем по частям
                const chunks = logs.match(new RegExp(`.{1,${maxLength}}`, 'g')) || [];
                await ctx.reply(`📋 <b>Последние ${count} логов (часть 1/${chunks.length}):</b>`, { parse_mode: 'HTML' });
                for (let i = 0; i < chunks.length; i++) {
                    await ctx.reply(`<code>${chunks[i]}</code>`, { parse_mode: 'HTML' });
                    if (i < chunks.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                }
            }
        }
        catch (err) {
            await ctx.reply(`❌ Ошибка получения логов: ${err}`);
        }
    });
    // Admin-only: получить только ошибки
    bot.command('errors', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const args = ctx.message.text.split(' ').slice(1);
        const count = Math.min(Math.max(parseInt(args[0] || '20', 10) || 20, 1), 50);
        try {
            const errors = getRecentErrors(count);
            await ctx.reply(`🔴 <b>Последние ${count} ошибок:</b>\n\n<code>${errors}</code>`, { parse_mode: 'HTML' });
        }
        catch (err) {
            await ctx.reply(`❌ Ошибка получения ошибок: ${err}`);
        }
    });
    // Admin-only: подписаться на логи в реальном времени
    bot.command('logstream', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const userId = ctx.from.id;
        if (isSubscribed(userId)) {
            await ctx.reply('ℹ️ Вы уже подписаны на логи в реальном времени.\n\nДля отписки используйте /stopstream');
            return;
        }
        subscribeToLogs(userId);
        await ctx.reply('✅ <b>Подписка на логи активирована!</b>\n\n' +
            'Теперь <b>только вы</b> будете получать все логи бота в реальном времени:\n' +
            '📝 INFO — обычные сообщения\n' +
            '⚠️ WARN — предупреждения\n' +
            '🔴 ERROR — ошибки\n\n' +
            '💡 <i>Каждый админ может подписаться независимо</i>\n\n' +
            'Для отключения используйте /stopstream', { parse_mode: 'HTML' });
    });
    // Admin-only: отписаться от логов
    bot.command('stopstream', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const userId = ctx.from.id;
        if (!isSubscribed(userId)) {
            await ctx.reply('ℹ️ Вы не подписаны на логи.');
            return;
        }
        unsubscribeFromLogs(userId);
        await ctx.reply('✅ Подписка на логи отключена.');
    });
    // Admin-only: статистика логов
    bot.command('logstats', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const stats = getLogStats();
        const text = [
            '📊 <b>Статистика логов</b>',
            '',
            `📝 Всего записей в буфере: <b>${stats.total}</b>`,
            `🔴 Ошибок: <b>${stats.errors}</b>`,
            `⚠️ Предупреждений: <b>${stats.warnings}</b>`,
            `👥 Подписчиков на stream: <b>${stats.subscribers}</b>`,
            '',
            '<i>Буфер хранит последние 500 записей</i>',
        ].join('\n');
        await ctx.reply(text, { parse_mode: 'HTML' });
    });
    // Admin-only: force payments check (button)
    bot.command('checkpayments', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        const kb = Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Проверить оплаты сейчас', 'admin:checkpayments')],
        ]);
        await ctx.reply('Нажмите кнопку для принудительной проверки оплат и валидации:', { reply_markup: kb.reply_markup });
    });
    bot.action('admin:checkpayments', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        await ctx.editMessageText('⏳ Проверяю оплаты и валидацию...');
        const result = await runPaymentsCheck(ctx.telegram);
        const text = [
            '✅ Проверка завершена',
            `Успешных оплат: ${result.success}`,
            `Ошибочных/истёкших: ${result.failed}`,
            `Ожидают подтверждения: ${result.pendingConfirm}`,
            `Подтверждено: ${result.confirmed}`,
            `Не подтверждено: ${result.validationFailed}`,
        ].join('\n');
        await ctx.reply(text);
    });
    // Admin-only: diagnostics (bot permissions + subscriptions counters)
    bot.command('diag', async (ctx) => {
        if (!isAdmin(ctx.from?.id))
            return;
        try {
            const me = await ctx.telegram.getMe();
            const botId = me.id;
            const now = new Date();
            const nowSec = Math.floor(now.getTime() / 1000);
            const myMember = await ctx.telegram.getChatMember(config.telegramChannelId, botId);
            const status = myMember.status;
            const canRestrict = myMember.can_restrict_members ?? myMember.canRestrictMembers;
            const canInvite = myMember.can_invite_users ?? myMember.canInviteUsers;
            const { findExpiredActiveSubscriptions, findExpiringSubscriptions } = await import('./db.js');
            const expired = findExpiredActiveSubscriptions(nowSec);
            const expiring24h = findExpiringSubscriptions(1);
            const lines = [];
            lines.push('🛠 <b>DIAG</b>');
            lines.push(`🕒 now: <code>${now.toISOString()}</code>`);
            try {
                const kyiv = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Kyiv', dateStyle: 'full', timeStyle: 'medium' }).format(now);
                lines.push(`🇺🇦 Kyiv: <code>${kyiv}</code>`);
            }
            catch {
                // ignore
            }
            lines.push(`📌 chatId (config): <code>${config.telegramChannelId}</code>`);
            lines.push(`🤖 bot status in chat: <code>${status}</code>`);
            lines.push(`🔒 can_restrict_members: <code>${String(!!canRestrict)}</code>`);
            lines.push(`🔗 can_invite_users: <code>${String(!!canInvite)}</code>`);
            lines.push('');
            // Важно: в HTML parse_mode нельзя использовать символ "<" в тексте без экранирования.
            // Используем знак "≤", чтобы Telegram не пытался парсить это как HTML-тег.
            lines.push(`⛔️ expired(active=1,endAt≤now): <b>${expired.length}</b>`);
            lines.push(`⏰ expiring(next 24h): <b>${expiring24h.length}</b>`);
            if (expired.length > 0) {
                const sample = expired.slice(0, 5).map(s => `• subId=${s.id} user=${s.telegramUserId} endAt=${s.endAt}`).join('\n');
                lines.push('');
                lines.push('<b>Пример истёкших:</b>');
                lines.push(sample);
            }
            await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
        }
        catch (err) {
            await ctx.reply(`DIAG error: ${String(err).slice(0, 3500)}`);
        }
    });
    bot.action(/buy:(P1M|P2M)/, async (ctx) => {
        const plan = ctx.match[1];
        const user = ctx.from;
        if (!user)
            return;
        const planTitle = PLAN_DETAILS[plan].title;
        const amountMinor = plan === 'P1M' ? 70000 : 120000; // 700.00₴ и 1200.00₴
        const reference = `tg_${user.id}_${plan}_${Date.now()}`;
        const me = await ctx.telegram.getMe();
        const botUsername = me.username || '';
        const redirectUrl = `https://t.me/${botUsername}`;
        // Do not pass webhookUrl when using polling
        if (config.testMode) {
            const nowSec = Math.floor(Date.now() / 1000);
            const months = PLAN_DETAILS[plan].months;
            // generate invite link immediately without payment
            try {
                const invite = await ctx.telegram.createChatInviteLink(config.telegramChannelId, {
                    expire_date: nowSec + INVITE_LINK_EXPIRE_SEC,
                    member_limit: 1,
                    creates_join_request: false,
                    name: `test-${user.id}-${plan}-${Date.now()}`,
                });
                const inviteLink = invite.invite_link || invite.inviteLink;
                await ctx.reply(`ТЕСТОВЫЙ РЕЖИМ: доступ на ${months} мес. Ваша ссылка: ${inviteLink}`);
            }
            catch (err) {
                console.error('[TestMode] Ошибка создания персональной ссылки:', err);
                try {
                    const fallbackLink = await ctx.telegram.exportChatInviteLink(config.telegramChannelId);
                    await ctx.reply(`ТЕСТОВЫЙ РЕЖИМ: доступ на ${months} мес. Ссылка: ${fallbackLink}`);
                }
                catch (err2) {
                    console.error('[TestMode] Ошибка экспорта общей ссылки:', err2);
                    await ctx.reply('ТЕСТОВЫЙ РЕЖИМ: не удалось создать ссылку приглашения. Убедитесь, что бот — администратор канала с правом пригласить по ссылке, и что указан корректный TELEGRAM_CHANNEL_ID (например, -100... или @username).');
                }
            }
            return;
        }
        try {
            const invoice = await createInvoice({
                amountMinor,
                reference,
                description: planTitle,
                redirectUrl,
            });
            insertPayment({
                invoiceId: invoice.invoiceId,
                telegramUserId: user.id,
                planCode: plan,
                amount: amountMinor,
                status: 'created',
                createdAt: Math.floor(Date.now() / 1000),
                paidAt: null,
            });
            const payBtn = Markup.inlineKeyboard([
                [Markup.button.url('Перейти к оплате', invoice.pageUrl)],
                [Markup.button.callback('◀︎ Назад в меню', 'menu:info')],
            ]);
            const message = ctx.callbackQuery?.message;
            const isPhoto = Array.isArray(message?.photo) && message.photo.length > 0;
            const text = `${planTitle}. Нажмите, чтобы перейти к оплате.`;
            const opts = { reply_markup: payBtn.reply_markup };
            if (isPhoto)
                await ctx.editMessageCaption(text, opts);
            else
                await ctx.editMessageText(text, opts);
        }
        catch (err) {
            console.error('[Buy] Ошибка создания счёта MonoPay:', err);
            await ctx.reply('Не удалось создать счёт. Попробуйте позже.');
        }
    });
    // === ПРОВЕРКА ПРИ ВСТУПЛЕНИИ В КАНАЛ ===
    // Когда кто-то вступает в канал, проверяем есть ли у него подписка
    bot.on('chat_member', async (ctx) => {
        try {
            const update = ctx.chatMember;
            if (!update)
                return;
            const chatId = update.chat.id.toString();
            if (chatId !== config.telegramChannelId)
                return;
            const userId = update.new_chat_member.user.id;
            const newStatus = update.new_chat_member.status;
            const oldStatus = update.old_chat_member.status;
            // Проверяем только вступления (был left/kicked, стал member/restricted)
            const wasOut = oldStatus === 'left' || oldStatus === 'kicked';
            const isIn = newStatus === 'member' || newStatus === 'restricted' || newStatus === 'administrator' || newStatus === 'creator';
            if (!wasOut || !isIn)
                return;
            // Пропускаем админов
            if (isAdmin(userId))
                return;
            console.log(`[ChatMember] Пользователь ${userId} вступил в канал ${chatId}`);
            const nowSec = Math.floor(Date.now() / 1000);
            recordUserChannelJoin(userId, chatId, nowSec);
            const pendingValidation = getPendingPaymentValidationForUser(userId, nowSec);
            if (pendingValidation) {
                const updated = markPaymentValidationConfirmed(pendingValidation.invoiceId, nowSec, nowSec);
                if (updated) {
                    const months = PLAN_DETAILS[pendingValidation.planCode].months;
                    createOrExtendSubscription(userId, chatId, pendingValidation.planCode, months, nowSec);
                }
            }
            // Проверяем подписку
            const hasAccess = hasActiveSubscription(userId, chatId, nowSec) && hasValidatedPayment(userId);
            if (!hasAccess) {
                console.log(`[ChatMember] У пользователя ${userId} нет активной подписки — удаляем`);
                // Удаляем из канала
                await removeUserFromChannel(ctx.telegram, chatId, userId);
                // Отправляем сообщение с кнопками тарифов
                try {
                    const message = [
                        '🔒 Доступ закрыт',
                        '',
                        'Для доступа к каналу необходима активная подписка.',
                        '',
                        'Выберите тариф:'
                    ].join('\n');
                    await ctx.telegram.sendMessage(userId, message, {
                        parse_mode: 'HTML',
                        reply_markup: tariffsKeyboard.reply_markup
                    });
                }
                catch (err) {
                    console.error(`[ChatMember] Не удалось отправить сообщение userId=${userId}:`, err);
                }
            }
        }
        catch (err) {
            console.error('[ChatMember] Ошибка обработки события:', err);
        }
    });
    return bot;
}
export async function removeUserFromChannel(telegram, chatId, userId) {
    try {
        // Бан + разбан = "кик" с возможностью войти снова позже.
        // Важно НЕ глотать ошибки: иначе кажется, что удалили, хотя Telegram мог вернуть 403/400.
        await telegram.banChatMember(chatId, userId);
    }
    catch (err) {
        const e = err;
        const code = e?.response?.error_code;
        const desc = e?.response?.description ?? String(err);
        const descStr = typeof desc === 'string' ? desc : String(desc);
        const upper = descStr.toUpperCase();
        // Если пользователь уже не участник — считаем, что удалять не нужно.
        const userNotParticipant = upper.includes('USER_NOT_PARTICIPANT') ||
            upper.includes('USER IS NOT A MEMBER') ||
            upper.includes('USER_NOT_FOUND') ||
            upper.includes('PARTICIPANT_ID_INVALID') ||
            upper.includes('MEMBER NOT FOUND');
        if (userNotParticipant) {
            console.log(`[Kick] userId=${userId} уже не участник чата ${chatId}`);
            return;
        }
        // Более понятная подсказка по правам (частая причина 403/400 в каналах)
        if (upper.includes('CHAT_ADMIN_REQUIRED') ||
            upper.includes('NOT ENOUGH RIGHTS') ||
            upper.includes('BOT IS NOT A MEMBER') ||
            upper.includes('NEED ADMIN RIGHTS')) {
            console.error(`[Kick] Похоже, у бота нет прав на удаление участников. ` +
                `Проверьте: бот — администратор канала и включено право "Блокировать пользователей / Ban users".`);
        }
        console.error(`[Kick] Ошибка banChatMember chatId=${chatId} userId=${userId} code=${code} desc=${descStr}`);
        throw err;
    }
    try {
        // allow rejoin later
        await telegram.unbanChatMember(chatId, userId, { only_if_banned: true });
    }
    catch (err) {
        // Разбан может не требоваться/не поддерживаться — не делаем это фатальным, но логируем.
        const e = err;
        const code = e?.response?.error_code;
        const desc = e?.response?.description ?? String(err);
        console.warn(`[Kick] Предупреждение unbanChatMember chatId=${chatId} userId=${userId} code=${code} desc=${desc}`);
    }
}
//# sourceMappingURL=bot.js.map