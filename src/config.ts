import dotenv from 'dotenv';

dotenv.config();

export type AppConfig = {
  telegramBotToken: string;
  telegramChannelId: string; // e.g. -1001234567890
  port: number;
  databasePath: string;
  monoPayToken: string; // X-Token
  publicBaseUrl?: string | undefined; // public URL of your server for webhooks (https)
  currencyCcy: number; // 980 = UAH
  testMode: boolean; // if true, enable test flows without real payments
  welcomePhotoUrl?: string | undefined; // photo URL or file_id for welcome message
  creatorLink?: string | undefined; // subtle attribution link
  welcomePhotoFile?: string | undefined; // local file path for welcome photo
  welcomePhotoFileId?: string | undefined; // telegram file_id for welcome photo
  adminUserId?: number | undefined; // telegram id of admin allowed to change settings
};

export const config: AppConfig = {
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
};

export function assertConfig(): void {
  const missing: string[] = [];
  if (!config.telegramBotToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.telegramChannelId) missing.push('TELEGRAM_CHANNEL_ID');
  if (!config.monoPayToken) missing.push('MONOPAY_TOKEN');
  if (missing.length) {
    throw new Error(`Missing required env variables: ${missing.join(', ')}`);
  }
}



