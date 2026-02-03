import { Telegram } from 'telegraf';
export declare function startScheduler(telegram: Telegram): void;
export declare function runPaymentsCheck(telegram: Telegram): Promise<{
    success: number;
    failed: number;
    pendingConfirm: number;
    confirmed: number;
    validationFailed: number;
}>;
export declare function runExpiredSubscriptionsCheck(telegram: Telegram): Promise<{
    processed: number;
    errors: string[];
}>;
export declare function getExpiredSubscriptionsInfo(): {
    count: number;
    subscriptions: Array<{
        id: number;
        telegramUserId: number;
        endAt: number;
        endAtDate: string;
    }>;
};
//# sourceMappingURL=scheduler.d.ts.map