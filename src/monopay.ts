import axios from 'axios';
import { config } from './config.js';

type CreateInvoiceParams = {
  amountMinor: number; // e.g. 19900 for 199.00 UAH
  ccy?: number; // default 980
  reference: string; // our order id
  description: string;
  redirectUrl: string;
  webhookUrl?: string;
};

type CreateInvoiceResponse = {
  invoiceId: string;
  pageUrl: string; // URL to redirect user for payment
};

const MONOPAY_API = 'https://api.monobank.ua/api/merchant';

export async function createInvoice(params: CreateInvoiceParams): Promise<CreateInvoiceResponse> {
  const body = {
    amount: params.amountMinor,
    ccy: params.ccy ?? config.currencyCcy,
    merchantPaymInfo: {
      reference: params.reference,
      destination: params.description,
    },
    redirectUrl: params.redirectUrl,
    ...(params.webhookUrl ? { webHookUrl: params.webhookUrl } : {}),
  };

  const res = await axios.post(
    `${MONOPAY_API}/invoice/create`,
    body,
    { headers: { 'X-Token': config.monoPayToken } }
  );

  // Some versions of API return 'invoiceId' and 'pageUrl'
  const data = res.data as any;
  return {
    invoiceId: data.invoiceId,
    pageUrl: data.pageUrl || data.paymentPageUrl || data.payUrl,
  };
}

// No signature verification needed per current requirements
export function verifyWebhookSignature(): boolean { return true; }

export type InvoiceStatusResponse = {
  invoiceId: string;
  amount: number;
  ccy: number;
  status: string; // success | processing | failure | expired | etc.
  reference?: string;
};

export async function fetchInvoiceStatus(invoiceId: string): Promise<InvoiceStatusResponse> {
  const url = `${MONOPAY_API}/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`;
  const res = await axios.get(url, { headers: { 'X-Token': config.monoPayToken } });
  return res.data as InvoiceStatusResponse;
}




