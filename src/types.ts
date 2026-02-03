export type PlanCode = 'P1M' | 'P2M' | 'TEST';

export const PLAN_DETAILS: Record<PlanCode, { months: number; title: string }>
  = {
    P1M: { months: 1, title: 'Подписка на 1 месяц' },
    P2M: { months: 2, title: 'Подписка на 2 месяца' },
    TEST: { months: 1, title: 'Тестовая подписка' }, // 1 месяц для ручной выдачи
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

// Telegram API Types
export type ChatMemberStatus = 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';

export interface TelegramChatMember {
  user: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
  };
  status: ChatMemberStatus;
  can_restrict_members?: boolean;
  can_invite_users?: boolean;
  canRestrictMembers?: boolean;
  canInviteUsers?: boolean;
}

export interface TelegramChatInviteLink {
  invite_link?: string;
  inviteLink?: string;
  expire_date?: number;
  member_limit?: number;
  creates_join_request?: boolean;
  name?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessage {
  photo?: TelegramPhotoSize[];
  caption?: string;
  text?: string;
}



