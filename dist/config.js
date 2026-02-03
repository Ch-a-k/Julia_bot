import dotenv from 'dotenv';
dotenv.config();
// Парсинг списка админов из .env (поддержка через запятую)
function parseAdminIds(envValue) {
    if (!envValue)
        return [];
    return envValue
        .split(',')
        .map(id => parseInt(id.trim(), 10))
        .filter(id => !isNaN(id) && id > 0);
}
export const config = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChannelId: process.env.TELEGRAM_CHANNEL_ID || '',
    port: Number(process.env.PORT || 3000),
    databasePath: process.env.DATABASE_PATH || './data/bot.db',
    monoPayToken: process.env.MONOPAY_TOKEN || '',
    publicBaseUrl: process.env.PUBLIC_BASE_URL || undefined,
    currencyCcy: Number(process.env.CCY || 980),
    // Force test mode off as requested
    testMode: false,
    welcomePhotoUrl: process.env.WELCOME_PHOTO_URL || undefined,
    creatorLink: process.env.CREATOR_LINK || undefined,
    welcomePhotoFile: process.env.WELCOME_PHOTO_FILE || undefined,
    welcomePhotoFileId: process.env.WELCOME_PHOTO_FILE_ID || undefined,
    adminUserId: process.env.ADMIN_USER_ID ? Number(process.env.ADMIN_USER_ID) : undefined,
    // Поддержка нескольких админов: ADMIN_USER_IDS=123456,789012,345678
    adminUserIds: parseAdminIds(process.env.ADMIN_USER_IDS || process.env.ADMIN_USER_ID),
};
// Проверка, является ли пользователь админом
export function isAdmin(userId) {
    if (!userId)
        return false;
    // Проверяем новый список
    if (config.adminUserIds.length > 0) {
        return config.adminUserIds.includes(userId);
    }
    // Fallback на старый формат
    return config.adminUserId === userId;
}
export function assertConfig() {
    const missing = [];
    if (!config.telegramBotToken)
        missing.push('TELEGRAM_BOT_TOKEN');
    if (!config.telegramChannelId)
        missing.push('TELEGRAM_CHANNEL_ID');
    if (!config.monoPayToken)
        missing.push('MONOPAY_TOKEN');
    if (missing.length) {
        throw new Error(`Missing required env variables: ${missing.join(', ')}`);
    }
    // Предупреждение о пустом списке админов
    if (config.adminUserIds.length === 0) {
        console.warn('[Config] ⚠️  ВНИМАНИЕ: Не указаны ID администраторов (ADMIN_USER_IDS). Админ-команды будут недоступны.');
    }
}
//# sourceMappingURL=config.js.map