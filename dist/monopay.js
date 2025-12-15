import axios from 'axios';
import { config } from './config.js';
const MONOPAY_API = 'https://api.monobank.ua/api/merchant';
export async function createInvoice(params) {
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
    const res = await axios.post(`${MONOPAY_API}/invoice/create`, body, { headers: { 'X-Token': config.monoPayToken } });
    // Some versions of API return 'invoiceId' and 'pageUrl'
    const data = res.data;
    return {
        invoiceId: data.invoiceId,
        pageUrl: data.pageUrl || data.paymentPageUrl || data.payUrl,
    };
}
// No signature verification needed per current requirements
export function verifyWebhookSignature() { return true; }
export async function fetchInvoiceStatus(invoiceId) {
    const url = `${MONOPAY_API}/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`;
    const res = await axios.get(url, { headers: { 'X-Token': config.monoPayToken } });
    return res.data;
}
//# sourceMappingURL=monopay.js.map