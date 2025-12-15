type CreateInvoiceParams = {
    amountMinor: number;
    ccy?: number;
    reference: string;
    description: string;
    redirectUrl: string;
    webhookUrl?: string;
};
type CreateInvoiceResponse = {
    invoiceId: string;
    pageUrl: string;
};
export declare function createInvoice(params: CreateInvoiceParams): Promise<CreateInvoiceResponse>;
export declare function verifyWebhookSignature(): boolean;
export type InvoiceStatusResponse = {
    invoiceId: string;
    amount: number;
    ccy: number;
    status: string;
    reference?: string;
};
export declare function fetchInvoiceStatus(invoiceId: string): Promise<InvoiceStatusResponse>;
export {};
//# sourceMappingURL=monopay.d.ts.map