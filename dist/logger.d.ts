import { Telegram } from 'telegraf';
export declare function initLogger(telegram: Telegram): void;
export declare function getRecentLogs(count?: number): string;
export declare function getRecentErrors(count?: number): string;
export declare function subscribeToLogs(userId: number): boolean;
export declare function unsubscribeFromLogs(userId: number): boolean;
export declare function isSubscribed(userId: number): boolean;
export declare function getLogStats(): {
    total: number;
    errors: number;
    warnings: number;
    subscribers: number;
};
//# sourceMappingURL=logger.d.ts.map