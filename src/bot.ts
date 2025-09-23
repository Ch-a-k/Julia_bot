import { Telegraf, Markup, Context, Telegram } from 'telegraf';
import { config } from './config.js';
import { PLAN_DETAILS, type PlanCode } from './types.js';
import { createInvoice, fetchInvoiceStatus } from './monopay.js';
import { insertPayment, hasActiveSubscription, getLastPendingPayment, markPaymentStatus, createOrExtendSubscription, getSetting, setSetting } from './db.js';

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
    if (config.adminUserId && user.id === config.adminUserId) {
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
    const adminOk = !!config.adminUserId && ctx.from?.id === config.adminUserId;
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
    if (!(config.adminUserId && ctx.from?.id === config.adminUserId)) return;
    try {
      const link = await generateInviteLinkFor(ctx.from!.id);
      await ctx.reply(link ? `Ссылка: ${link}` : 'Не удалось создать ссылку.');
    } catch {
      await ctx.reply('Ошибка создания ссылки.');
    }
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



