import { createBot } from './bot.js';
import { startScheduler } from './scheduler.js';
import { assertConfig, config } from './config.js';
import { initDb } from './db.js';
import { startServer } from './server.js';
async function main() {
    // eslint-disable-next-line no-console
    console.log('[Boot] Starting…');
    assertConfig();
    // eslint-disable-next-line no-console
    console.log('[Boot] Config OK');
    initDb();
    // eslint-disable-next-line no-console
    console.log('[Boot] DB initialized');
    const bot = createBot();
    // eslint-disable-next-line no-console
    console.log('[Boot] Launching bot (polling)…');
    // Важно: Telegraf по умолчанию стартует polling с allowed_updates: []
    // что на стороне Telegram означает "всё, кроме chat_member..." — из-за этого
    // не приходят события вступления/выхода, и бот не может кикать неоплативших при входе.
    //
    // Также ставим таймаут, чтобы контейнер не "висел молча" при проблемах связи с Telegram.
    const launchPromise = bot.launch({
        allowedUpdates: ['message', 'callback_query', 'chat_member', 'my_chat_member'],
    });
    await Promise.race([
        launchPromise,
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Bot launch timeout (no response from Telegram API within 30s)')), 30_000)),
    ]);
    // eslint-disable-next-line no-console
    console.log('[Boot] Bot launched');
    startScheduler(bot.telegram);
    // eslint-disable-next-line no-console
    console.log('[Boot] Scheduler started');
    startServer();
    // eslint-disable-next-line no-console
    console.log(`Bot started. Listening on ${config.port}`);
    // Graceful shutdown
    const shutdown = async (signal) => {
        console.log(`\n[${signal}] Завершение работы...`);
        bot.stop(signal);
        const { closeDb } = await import('./db.js');
        closeDb();
        console.log('База данных закрыта. До свидания!');
        process.exit(0);
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
}
main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=index.js.map