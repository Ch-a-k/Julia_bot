import { Telegraf, Context, Telegram } from 'telegraf';
export type BotContext = Context & {
    state: {
        botUsername?: string;
    };
};
export declare function createBot(): Telegraf<BotContext>;
export declare function removeUserFromChannel(telegram: Telegram, chatId: string, userId: number): Promise<void>;
//# sourceMappingURL=bot.d.ts.map