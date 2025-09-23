import cron from 'node-cron';
import { findExpiredActiveSubscriptions, deactivateSubscription, listKnownUserIds, hasActiveSubscription, getLastReminderAt, setReminderSentNow, getDb, createOrExtendSubscription } from './db.js';
import { config } from './config.js';
import { Telegram } from 'telegraf';
import { removeUserFromChannel } from './bot.js';
import { PLAN_DETAILS, type PlanCode } from './types.js';
import { fetchInvoiceStatus } from './monopay.js';

export function startScheduler(telegram: Telegram): void {
  // Run twice a day at 10:15 and 22:15
  cron.schedule('15 10,22 * * *', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = findExpiredActiveSubscriptions(nowSec);
    for (const sub of expired) {
      try {
        await removeUserFromChannel(telegram, config.telegramChannelId, sub.telegramUserId);
      } catch {
        // ignore
      }
      deactivateSubscription(sub.id);
      try {
        await telegram.sendMessage(sub.telegramUserId, 'Срок вашей подписки истёк. Доступ к каналу закрыт. Продлите подписку в боте, чтобы продолжить участие.');
      } catch {
        // ignore
      }
    }
  });

  // Remind users without active subscription (daily)
  cron.schedule('0 10 * * *', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const userIds = listKnownUserIds();
    for (const uid of userIds) {
      const active = hasActiveSubscription(uid, config.telegramChannelId, nowSec);
      if (active) continue;
      const last = getLastReminderAt(uid);
      if (last && nowSec - last < 24 * 60 * 60) continue; // remind at most once per day
      try {
        await telegram.sendMessage(uid, 'Ваша подписка отсутствует или истекла. Чтобы продолжить доступ к каналу, оформите подписку в боте.');
        setReminderSentNow(uid, nowSec);
      } catch {
        // ignore if user blocked bot
      }
    }
  });

  // Poll pending payments every 2 minutes
  cron.schedule('*/2 * * * *', async () => {
    const db = getDb();
    const pending = db.prepare(
      `SELECT invoiceId, telegramUserId, planCode FROM payments WHERE status IN ('created','processing','holded')`
    ).all() as { invoiceId: string; telegramUserId: number; planCode: PlanCode }[];

    for (const p of pending) {
      try {
        const status = await fetchInvoiceStatus(p.invoiceId);
        if (status.status === 'success') {
          const months = PLAN_DETAILS[p.planCode].months;
          const nowSec = Math.floor(Date.now() / 1000);
          createOrExtendSubscription(p.telegramUserId, config.telegramChannelId, p.planCode, months, nowSec);
          db.prepare(`UPDATE payments SET status='success', paidAt=? WHERE invoiceId=?`).run(nowSec, p.invoiceId);
          try {
            await telegram.sendMessage(p.telegramUserId, 'Оплата получена! Перейдите в бота и получите ссылку на канал, если не получили.');
          } catch {}
        } else if (status.status === 'failure' || status.status === 'expired' || status.status === 'reversed') {
          db.prepare(`UPDATE payments SET status=? WHERE invoiceId=?`).run(status.status, p.invoiceId);
        }
      } catch {
        // ignore transient errors
      }
    }
  });
}



