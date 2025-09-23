import { createBot } from './bot.js';
import { startScheduler } from './scheduler.js';
import { assertConfig, config } from './config.js';
import { initDb } from './db.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  assertConfig();
  initDb();
  const bot = createBot();
  await bot.launch();
  startScheduler(bot.telegram);
  startServer(bot);

  // eslint-disable-next-line no-console
  console.log(`Bot started. Listening on ${config.port}`);

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});


