export type AppConfig = {
    telegramBotToken: string;
    telegramChannelId: string;
    port: number;
    databasePath: string;
    monoPayToken: string;
    publicBaseUrl?: string | undefined;
    currencyCcy: number;
    testMode: boolean;
    welcomePhotoUrl?: string | undefined;
    creatorLink?: string | undefined;
    welcomePhotoFile?: string | undefined;
    welcomePhotoFileId?: string | undefined;
    adminUserId?: number | undefined;
    adminUserIds: number[];
};
export declare const config: AppConfig;
export declare function isAdmin(userId: number | undefined): boolean;
export declare function assertConfig(): void;
//# sourceMappingURL=config.d.ts.map