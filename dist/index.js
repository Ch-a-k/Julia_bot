import { createBot } from './bot.js';
import { startScheduler } from './scheduler.js';
import { assertConfig, config } from './config.js';
import { initDb } from './db.js';
import { startServer } from './server.js';
async function main() {
    assertConfig();
    initDb();
    const bot = createBot();
    await bot.launch();
    startScheduler(bot.telegram);
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