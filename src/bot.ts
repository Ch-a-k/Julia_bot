import { Telegraf, Markup, Context, Telegram } from 'telegraf';
import { config, isAdmin } from './config.js';
import { PLAN_DETAILS, type PlanCode } from './types.js';
import { createInvoice, fetchInvoiceStatus } from './monopay.js';
import { insertPayment, hasActiveSubscription, getLastPendingPayment, markPaymentStatus, createOrExtendSubscription, getSetting, setSetting, getAllActiveSubscriptions, createSubscriptionForDays, getUserSubscription, saveUserInfo, getExtendedActiveSubscriptions, findUsersByQuery, getActiveSubscribersIds, getUserInfo, getAllUsersForExport, type ExtendedSubscriptionInfo } from './db.js';
import { runExpiredSubscriptionsCheck, getExpiredSubscriptionsInfo } from './scheduler.js';

// Форматирование даты на русском
function formatDateRu(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 
                  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

// Форматирование даты и времени
function formatDateTimeRu(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 
                  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const hours = date.getHours().toString().padStart(2, '0');
  const mins = date.getMinutes().toString().padStart(2, '0');
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()} ${hours}:${mins}`;
}

// Состояние для broadcast (хранится в памяти, сбрасывается при перезапуске)
const broadcastState: Map<number, {
  message: string;
  recipients: number[];
  recipientsType: 'all' | 'selected';
  step: 'message' | 'recipients' | 'preview' | 'confirm';
}> = new Map();

export type BotContext = Context & {
  state: {
    botUsername?: string;
  };
};

export function createBot(): Telegraf<BotContext> {
  const bot = new Telegraf<BotContext>(config.telegramBotToken);

  async function isUserSubscribed(userId: number): Promise<boolean> {
    try {
      const member = await bot.telegram.getChatMember(config.telegramChannelId, userId);
      const status = (member as any).status as string;
      return status !== 'left' && status !== 'kicked';
    } catch {
      return false;
    }
  }

  async function generateInviteLinkFor(userId: number): Promise<string | undefined> {
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      const expireIn = 24 * 60 * 60;
      const invite = await bot.telegram.createChatInviteLink(config.telegramChannelId, {
        expire_date: nowSec + expireIn,
        member_limit: 1,
        creates_join_request: false,
        name: `access-${userId}-${Date.now()}`,
      } as any);
      return (invite as any).invite_link || (invite as any).inviteLink;
    } catch {
      try {
        return await bot.telegram.exportChatInviteLink(config.telegramChannelId);
      } catch {
        return undefined;
      }
    }
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
      } else {
        await ctx.reply(fullText, { parse_mode: 'HTML', reply_markup: mainMenuInline().reply_markup });
      }
    } catch (e) {
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
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: mainMenuInline().reply_markup } as any);
  });

  bot.action('menu:subscribe', async (ctx) => {
    const text = 'Выберите тариф подписки:';
    const isPhoto = (ctx.callbackQuery as any)?.message?.photo;
    const opts = { reply_markup: tariffsKeyboard.reply_markup } as any;
    if (isPhoto) {
      await ctx.editMessageCaption(text, opts);
    } else {
      await ctx.editMessageText(text, opts);
    }
  });

  bot.action('menu:check', async (ctx) => {
    const user = ctx.from;
    if (!user) return;
    const nowSec = Math.floor(Date.now() / 1000);
    // Admin always gets an invite link
    if (isAdmin(user.id)) {
      const link = await generateInviteLinkFor(user.id);
      const kb = Markup.inlineKeyboard([
        link ? [Markup.button.url('Перейти в канал', link)] : [],
        [Markup.button.callback('◀︎ Назад в меню', 'menu:info')],
      ].filter(r => r.length > 0));
      const text = link ? 'Админ-доступ: нажмите, чтобы перейти в канал.' : 'Не удалось создать ссылку. Проверьте права бота.';
      const isPhoto = (ctx.callbackQuery as any)?.message?.photo;
      const opts = { reply_markup: kb.reply_markup } as any;
      if (isPhoto) await ctx.editMessageCaption(text, opts); else await ctx.editMessageText(text, opts);
      return;
    }
    const active = hasActiveSubscription(user.id, config.telegramChannelId, nowSec);
    const isPhoto = (ctx.callbackQuery as any)?.message?.photo;
    if (active) {
      const link = await generateInviteLinkFor(user.id);
      const kb = Markup.inlineKeyboard([
        link ? [Markup.button.url('Перейти в канал', link)] : [],
        [Markup.button.callback('◀︎ Назад в меню', 'menu:info')],
      ].filter(r => r.length > 0));
      const text = link ? 'У вас активная подписка. Нажмите, чтобы перейти в канал.' : 'У вас активная подписка, но не удалось создать ссылку. Свяжитесь с поддержкой.';
      const opts = { reply_markup: kb.reply_markup } as any;
      if (isPhoto) await ctx.editMessageCaption(text, opts); else await ctx.editMessageText(text, opts);
    } else {
      const pending = getLastPendingPayment(user.id);
      if (pending) {
        try {
          const status = await fetchInvoiceStatus(pending.invoiceId);
          if (status.status === 'success') {
            const months = PLAN_DETAILS[pending.planCode].months;
            createOrExtendSubscription(user.id, config.telegramChannelId, pending.planCode, months, nowSec);
            markPaymentStatus(pending.invoiceId, 'success', nowSec);
            const link = await generateInviteLinkFor(user.id);
            const kb = Markup.inlineKeyboard([
              link ? [Markup.button.url('Перейти в канал', link)] : [],
              [Markup.button.callback('◀︎ Назад в меню', 'menu:info')],
            ].filter(r => r.length > 0));
            const text = link ? 'Оплата найдена. Нажмите, чтобы перейти в канал.' : 'Оплата найдена, но не удалось создать ссылку. Свяжитесь с поддержкой.';
            const opts = { reply_markup: kb.reply_markup } as any;
            if (isPhoto) await ctx.editMessageCaption(text, opts); else await ctx.editMessageText(text, opts);
            return;
          }
        } catch {}
      }
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback('Оформить подписку', 'menu:subscribe')],
        [Markup.button.callback('◀︎ Назад в меню', 'menu:info')],
      ]);
      const text = 'Доступ отсутствует. Оформите подписку.';
      const opts = { reply_markup: kb.reply_markup } as any;
      if (isPhoto) await ctx.editMessageCaption(text, opts); else await ctx.editMessageText(text, opts);
    }
  });

  // Fallback: ignore random messages to avoid history spam
  bot.on('message', async (_ctx, next) => {
    return next();
  });

  // Admin-only: save photo file_id to settings (send a photo with caption "save")
  bot.on('photo', async (ctx) => {
    const adminOk = isAdmin(ctx.from?.id);
    if (!adminOk) return; // ignore non-admin
    const photos = ctx.message.photo;
    if (!photos || photos.length === 0) return;
    const best = photos[photos.length - 1];
    if (!best) return;
    const fileId = (best as any).file_id as string | undefined;
    if (!fileId) return;
    setSetting('WELCOME_PHOTO_FILE_ID', fileId);
    await ctx.reply('Сохранено фото приветствия (file_id).');
  });

  // Helper: show own user id
  bot.command('whoami', async (ctx) => {
    await ctx.reply(`Ваш Telegram ID: ${ctx.from?.id ?? 'неизвестен'}`);
  });

  // Admin-only: generate one-time invite link on demand
  bot.command('invitelink', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    try {
      const link = await generateInviteLinkFor(ctx.from!.id);
      await ctx.reply(link ? `Ссылка: ${link}` : 'Не удалось создать ссылку.');
    } catch {
      await ctx.reply('Ошибка создания ссылки.');
    }
  });

  // Admin-only: check expired subscriptions (diagnostic, no action)
  bot.command('checkexpired', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    try {
      const info = getExpiredSubscriptionsInfo();
      if (info.count === 0) {
        await ctx.reply('✅ Нет истёкших подписок для обработки.');
      } else {
        const lines = info.subscriptions.map(s => 
          `• ID: ${s.id}, User: ${s.telegramUserId}, Истекла: ${s.endAtDate}`
        );
        await ctx.reply(`⚠️ Найдено ${info.count} истёкших подписок:\n\n${lines.join('\n')}\n\nДля обработки: /processexpired`);
      }
    } catch (err) {
      await ctx.reply(`Ошибка: ${err}`);
    }
  });

  // Admin-only: manually process expired subscriptions
  bot.command('processexpired', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    try {
      await ctx.reply('🔄 Запускаю обработку истёкших подписок...');
      const result = await runExpiredSubscriptionsCheck(ctx.telegram);
      if (result.processed === 0 && result.errors.length === 0) {
        await ctx.reply('✅ Нет истёкших подписок для обработки.');
      } else {
        let msg = `✅ Обработано: ${result.processed}`;
        if (result.errors.length > 0) {
          msg += `\n\n⚠️ Ошибки (${result.errors.length}):\n${result.errors.slice(0, 5).join('\n')}`;
          if (result.errors.length > 5) {
            msg += `\n...и ещё ${result.errors.length - 5}`;
          }
        }
        await ctx.reply(msg);
      }
    } catch (err) {
      await ctx.reply(`Ошибка: ${err}`);
    }
  });

  // Admin-only: start broadcast wizard
  bot.command('broadcast', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    
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

    await ctx.reply(
      '📤 <b>Рассылка сообщений</b>\n\n' +
      'Выберите, кому отправить сообщение:',
      { parse_mode: 'HTML', reply_markup: kb.reply_markup }
    );
  });

  // Broadcast: выбрать всех
  bot.action('bc:all', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    
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

    await ctx.editMessageText(
      `📤 <b>Рассылка для ${allSubscribers.length} подписчиков</b>\n\n` +
      'Теперь отправьте текст сообщения.\n\n' +
      '<i>Можно использовать HTML-форматирование:</i>\n' +
      '• <code>&lt;b&gt;жирный&lt;/b&gt;</code>\n' +
      '• <code>&lt;i&gt;курсив&lt;/i&gt;</code>\n' +
      '• <code>{date}</code> — дата окончания подписки\n\n' +
      'Или отправьте /broadcast_cancel для отмены.',
      { parse_mode: 'HTML' }
    );
    await ctx.answerCbQuery();
  });

  // Broadcast: выбрать конкретных
  bot.action('bc:select', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    
    const state = broadcastState.get(ctx.from.id);
    if (!state) {
      await ctx.answerCbQuery('Сессия истекла. Начните заново: /broadcast');
      return;
    }

    state.recipientsType = 'selected';
    state.step = 'recipients';
    broadcastState.set(ctx.from.id, state);

    await ctx.editMessageText(
      '👥 <b>Выбор получателей</b>\n\n' +
      'Отправьте ID или @username через запятую:\n\n' +
      '<code>123456789, @username, 987654321</code>\n\n' +
      'Или отправьте /broadcast_cancel для отмены.',
      { parse_mode: 'HTML' }
    );
    await ctx.answerCbQuery();
  });

  // Broadcast: подтверждение отправки
  bot.action('bc:confirm', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    
    const state = broadcastState.get(ctx.from.id);
    if (!state || !state.message || state.recipients.length === 0) {
      await ctx.answerCbQuery('Сессия истекла. Начните заново: /broadcast');
      return;
    }

    await ctx.editMessageText('⏳ Отправка...');
    await ctx.answerCbQuery();

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const userId of state.recipients) {
      try {
        // Получаем подписку пользователя для подстановки даты
        const sub = getUserSubscription(userId, config.telegramChannelId);
        let personalizedMessage = state.message;
        
        if (sub) {
          const endDate = formatDateRu(sub.endAt);
          personalizedMessage = personalizedMessage.replace(/\{date\}/g, endDate);
        } else {
          personalizedMessage = personalizedMessage.replace(/\{date\}/g, '—');
        }

        await ctx.telegram.sendMessage(userId, personalizedMessage, { parse_mode: 'HTML' });
        sent++;
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (err) {
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
    if (!isAdmin(ctx.from?.id)) return;
    broadcastState.delete(ctx.from.id);
    await ctx.editMessageText('❌ Рассылка отменена.');
    await ctx.answerCbQuery();
  });

  // Broadcast: команда отмены
  bot.command('broadcast_cancel', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    broadcastState.delete(ctx.from.id);
    await ctx.reply('❌ Рассылка отменена.');
  });

  // Обработка текстовых сообщений для broadcast
  bot.on('text', async (ctx, next) => {
    if (!(config.adminUserId && ctx.from?.id === config.adminUserId)) {
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
      const foundIds: number[] = [];
      const notFound: string[] = [];

      for (const q of queries) {
        const cleanQ = q.replace('@', '').trim();
        if (!cleanQ) continue;
        
        const ids = findUsersByQuery(cleanQ);
        if (ids.length > 0) {
          foundIds.push(...ids);
        } else {
          notFound.push(q);
        }
      }

      const uniqueIds = [...new Set(foundIds)];

      if (uniqueIds.length === 0) {
        await ctx.reply(
          '❌ Не найдено ни одного пользователя.\n\n' +
          'Попробуйте снова или /broadcast_cancel для отмены.'
        );
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

      await ctx.reply(
        `📋 <b>ПРЕДПРОСМОТР</b>\n` +
        `Получателей: ${state.recipients.length}\n\n` +
        `────────────────\n\n` +
        `${previewText}\n\n` +
        `────────────────\n\n` +
        `⚠️ Проверьте сообщение и нажмите "Отправить"`,
        { parse_mode: 'HTML', reply_markup: kb.reply_markup }
      );
      return;
    }

    return next();
  });

  // Broadcast: изменить текст
  bot.action('bc:edit', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    
    const state = broadcastState.get(ctx.from.id);
    if (!state) {
      await ctx.answerCbQuery('Сессия истекла. Начните заново: /broadcast');
      return;
    }

    state.step = 'message';
    state.message = '';
    broadcastState.set(ctx.from.id, state);

    await ctx.editMessageText(
      '✏️ Отправьте новый текст сообщения:',
      { parse_mode: 'HTML' }
    );
    await ctx.answerCbQuery();
  });

  // Admin-only: list all active subscriptions with extended info
  bot.command('listsubs', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    
    const subscriptions = getExtendedActiveSubscriptions();
    if (subscriptions.length === 0) {
      await ctx.reply('📭 Нет активных подписок.');
      return;
    }

    // Формируем сообщения для каждого подписчика
    const formatSub = (sub: ExtendedSubscriptionInfo, idx: number): string => {
      const lines: string[] = [];
      lines.push(`<b>${idx}.</b>`);
      
      // Имя и никнейм
      const nameParts: string[] = [];
      if (sub.firstName) nameParts.push(sub.firstName);
      if (sub.lastName) nameParts.push(sub.lastName);
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
      const planNames: Record<string, string> = {
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
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  });

  // Admin-only: grant test subscription for N days
  // Usage: /grantsub USER_ID DAYS
  bot.command('grantsub', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
      await ctx.reply(
        '📝 Использование: /grantsub USER_ID DAYS\n\n' +
        'Примеры:\n' +
        '• /grantsub 123456789 1 — подписка на 1 день\n' +
        '• /grantsub 123456789 7 — подписка на неделю\n' +
        '• /grantsub 123456789 30 — подписка на месяц\n\n' +
        '💡 Узнать свой ID: /whoami'
      );
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
      
      await ctx.reply(
        `✅ Подписка создана!\n\n` +
        `👤 User ID: ${userId}\n` +
        `📅 Срок: ${days} дн.\n` +
        `🔚 Действует до: ${endDate}`
      );

      // Уведомляем пользователя
      try {
        const link = await generateInviteLinkFor(userId);
        const userMessage = link 
          ? `🎁 Вам предоставлен доступ к каналу на ${days} дн.!\n\nВаша ссылка для входа: ${link}`
          : `🎁 Вам предоставлен доступ к каналу на ${days} дн.! Перейдите в бота, чтобы получить ссылку.`;
        await ctx.telegram.sendMessage(userId, userMessage);
        await ctx.reply('📨 Пользователь уведомлён.');
      } catch {
        await ctx.reply('⚠️ Не удалось уведомить пользователя (возможно, он не начинал диалог с ботом).');
      }
    } catch (err) {
      await ctx.reply(`❌ Ошибка: ${err}`);
    }
  });

  // Admin-only: revoke subscription
  // Usage: /revokesub USER_ID
  bot.command('revokesub', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) {
      await ctx.reply(
        '📝 Использование: /revokesub USER_ID\n\n' +
        'Пример: /revokesub 123456789\n\n' +
        '⚠️ Подписка будет деактивирована, пользователь удалён из канала.'
      );
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
      } catch {
        await ctx.reply(`✅ Подписка отозвана, но не удалось удалить из канала (возможно, уже не в канале).`);
      }

      // Уведомляем пользователя
      try {
        await ctx.telegram.sendMessage(userId, 'Ваша подписка была отозвана. Доступ к каналу закрыт.');
      } catch {
        // Пользователь мог заблокировать бота
      }
    } catch (err) {
      await ctx.reply(`❌ Ошибка: ${err}`);
    }
  });

  // Admin-only: export users to CSV
  bot.command('export', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    
    try {
      await ctx.reply('⏳ Формирую файл экспорта...');
      
      const users = getAllUsersForExport();
      
      if (users.length === 0) {
        await ctx.reply('📭 Нет данных для экспорта.');
        return;
      }

      // Формируем CSV
      const formatDate = (ts: number | null) => {
        if (!ts) return '';
        const d = new Date(ts * 1000);
        return `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
      };

      const planNames: Record<string, string> = {
        'P1M': '1 месяц (700 грн)',
        'P2M': '2 месяца (1200 грн)',
        'TEST': 'Тестовая'
      };

      const csvRows: string[] = [];
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
        'Всего оплачено (грн)'
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
          u.totalPaid ? (u.totalPaid / 100).toFixed(0) : '0'
        ].join(';'));
      }

      const csvContent = csvRows.join('\n');
      const buffer = Buffer.from('\uFEFF' + csvContent, 'utf-8'); // BOM для Excel

      const activeCount = users.filter(u => u.hasActiveSubscription).length;
      const inactiveCount = users.length - activeCount;

      await ctx.replyWithDocument(
        { source: buffer, filename: `users_export_${new Date().toISOString().slice(0, 10)}.csv` },
        { 
          caption: `📊 Экспорт пользователей\n\n` +
                   `👥 Всего: ${users.length}\n` +
                   `✅ С подпиской: ${activeCount}\n` +
                   `❌ Без подписки: ${inactiveCount}`
        }
      );
    } catch (err) {
      await ctx.reply(`❌ Ошибка экспорта: ${err}`);
    }
  });

  // Admin-only: show help for admin commands
  bot.command('adminhelp', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    
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
      '',
      '━━━━ <b>📤 Рассылка</b> ━━━━',
      '',
      '/broadcast — <i>рассылка с предпросмотром</i>',
      '',
      '━━━━ <b>⚙️ Прочее</b> ━━━━',
      '',
      '/invitelink — <i>Одноразовая ссылка на канал</i>',
      '/whoami — <i>узнать ID</i>',
    ].join('\n');
    
    await ctx.reply(help, { parse_mode: 'HTML' });
  });

  // Helper: send file_id for any photo sent to the bot (to configure welcome photo reliably)
  bot.on('photo', async (ctx) => {
    try {
      const photos = ctx.message.photo;
      if (!photos || photos.length === 0) return;
      const best = photos[photos.length - 1];
      if (!best) return;
      await ctx.reply(`file_id: ${(best as any).file_id}`);
    } catch {}
  });

  bot.action(/buy:(P1M|P2M)/, async (ctx) => {
    const plan = (ctx.match as RegExpExecArray)[1] as PlanCode;
    const user = ctx.from;
    if (!user) return;

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
        const expireIn = 24 * 60 * 60;
        const invite = await ctx.telegram.createChatInviteLink(config.telegramChannelId, {
          expire_date: nowSec + expireIn,
          member_limit: 1,
          creates_join_request: false,
          name: `test-${user.id}-${plan}-${Date.now()}`,
        } as any);
        const inviteLink = (invite as any).invite_link || (invite as any).inviteLink;
        await ctx.reply(`ТЕСТОВЫЙ РЕЖИМ: доступ на ${months} мес. Ваша ссылка: ${inviteLink}`);
      } catch {
        try {
          const fallbackLink = await ctx.telegram.exportChatInviteLink(config.telegramChannelId);
          await ctx.reply(`ТЕСТОВЫЙ РЕЖИМ: доступ на ${months} мес. Ссылка: ${fallbackLink}`);
        } catch {
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
      const isPhoto = (ctx.callbackQuery as any)?.message?.photo;
      const text = `${planTitle}. Нажмите, чтобы перейти к оплате.`;
      const opts = { reply_markup: payBtn.reply_markup } as any;
      if (isPhoto) await ctx.editMessageCaption(text, opts); else await ctx.editMessageText(text, opts);
    } catch (e) {
      await ctx.reply('Не удалось создать счёт. Попробуйте позже.');
    }
  });

  return bot;
}

export async function removeUserFromChannel(telegram: Telegram, chatId: string, userId: number): Promise<void> {
  try {
    await telegram.banChatMember(chatId, userId);
    await telegram.unbanChatMember(chatId, userId); // allow rejoin later
  } catch {
    // ignore errors
  }
}



