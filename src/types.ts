export type PlanCode = 'P1M' | 'P2M';

export const PLAN_DETAILS: Record<PlanCode, { months: number; title: string }>
  = {
    P1M: { months: 1, title: 'Подписка на 1 месяц' },
    P2M: { months: 2, title: 'Подписка на 2 месяца' },
  };

export type InvoiceStatus =
  | 'created'
  | 'processing'
  | 'holded'
  | 'success'
  | 'failure'
  | 'expired'
  | 'reversed';

export interface MonoPayWebhookPayload {
  invoiceId: string;
  status: InvoiceStatus;
  maskedPan?: string;
  amount?: number;
  ccy?: number;
  finalAmount?: number;
  reference?: string; // our order id
  createdDate?: number;
  modifiedDate?: number;
}



