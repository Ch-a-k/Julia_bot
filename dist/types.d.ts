export type PlanCode = 'P1M' | 'P2M' | 'TEST';
export declare const PLAN_DETAILS: Record<PlanCode, {
    months: number;
    title: string;
}>;
export type InvoiceStatus = 'created' | 'processing' | 'holded' | 'success' | 'failure' | 'expired' | 'reversed';
export interface MonoPayWebhookPayload {
    invoiceId: string;
    status: InvoiceStatus;
    maskedPan?: string;
    amount?: number;
    ccy?: number;
    finalAmount?: number;
    reference?: string;
    createdDate?: number;
    modifiedDate?: number;
}
//# sourceMappingURL=types.d.ts.map