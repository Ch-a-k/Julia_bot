import { createBot } from './bot.js';
import { startScheduler } from './scheduler.js';
import { assertConfig, config } from './config.js';
import { initDb } from './db.js';
import { startServer } from './server.js';
import { initLogger } from './logger.js';
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
    console.log('[Boot] Starting bot (polling)…');
    // Важно: Telegraf по умолчанию стартует polling с allowed_updates: []
    // что на стороне Telegram означает "всё, кроме chat_member..." — из-за этого
    // не приходят события вступления/выхода, и бот не может кикать неоплативших при входе.
    //
    // В режиме polling `bot.launch()` не завершается (это бесконечный цикл получения апдейтов),
    // поэтому НЕ await'им его. Ошибки ловим через catch.
    bot
        .launch({
        allowedUpdates: ['message', 'callback_query', 'chat_member', 'my_chat_member'],
    })
        .catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[Boot] Bot polling crashed:', e);
        process.exit(1);
    });
    // eslint-disable-next-line no-console
    console.log('[Boot] Polling started');
    // Инициализируем систему логирования (после запуска бота)
    initLogger(bot.telegram);
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