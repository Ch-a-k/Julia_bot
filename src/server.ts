import express from 'express';
import { Telegraf } from 'telegraf';
import { config } from './config.js';
import { updatePaymentStatus, createOrExtendSubscription, getDb } from './db.js';
import { PLAN_DETAILS, type MonoPayWebhookPayload, type PlanCode } from './types.js';
// Webhook no longer required; polling is used instead

export function startServer(bot: Telegraf): void {
  const app = express();

  app.get('/health', (_req, res) => res.send('ok'));

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on :${config.port}`);
  });
}

