import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import type { PlanCode } from './types.js';

export type Subscription = {
  id: number;
  telegramUserId: number;
  chatId: string;
  planCode: PlanCode;
  startAt: number; // unix seconds
  endAt: number; // unix seconds
  active: number; // 0/1
};

export type Payment = {
  id: number;
  invoiceId: string;
  telegramUserId: number;
  planCode: PlanCode;
  amount: number; // minor units
  status: string;
  createdAt: number;
  paidAt?: number | null;
};

export type UserInfo = {
  telegramUserId: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  updatedAt: number;
};

let db: Database.Database;

export function initDb(): void {
  const dir = path.dirname(config.databasePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegramUserId INTEGER NOT NULL,
      chatId TEXT NOT NULL,
      planCode TEXT NOT NULL,
      startAt INTEGER NOT NULL,
      endAt INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoiceId TEXT NOT NULL UNIQUE,
      telegramUserId INTEGER NOT NULL,
      planCode TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      paidAt INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(telegramUserId);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_end ON subscriptions(endAt);

    CREATE TABLE IF NOT EXISTS reminders_non_subscribed (
      telegramUserId INTEGER PRIMARY KEY,
      lastSentAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      telegramUserId INTEGER PRIMARY KEY,
      username TEXT,
      firstName TEXT,
      lastName TEXT,
      phone TEXT,
      updatedAt INTEGER NOT NULL
    );

    -- Напоминания о скором истечении подписки
    CREATE TABLE IF NOT EXISTS expiry_reminders (
      subscriptionId INTEGER NOT NULL,
      daysBeforeExpiry INTEGER NOT NULL,
      sentAt INTEGER NOT NULL,
      PRIMARY KEY (subscriptionId, daysBeforeExpiry)
    );
  `);
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB is not initialized');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    console.log('[DB] Соединение закрыто');
  }
}

export function insertPayment(p: Omit<Payment, 'id'>): void {
  getDb().prepare(
    `INSERT INTO payments (invoiceId, telegramUserId, planCode, amount, status, createdAt, paidAt)
     VALUES (@invoiceId, @telegramUserId, @planCode, @amount, @status, @createdAt, @paidAt)`
  ).run(p);
}

export function updatePaymentStatus(invoiceId: string, status: string, paidAt?: number): void {
  getDb().prepare(
    `UPDATE payments SET status=@status, paidAt=@paidAt WHERE invoiceId=@invoiceId`
  ).run({ invoiceId, status, paidAt: paidAt ?? null });
}

export function createOrExtendSubscription(
  telegramUserId: number,
  chatId: string,
  planCode: PlanCode,
  months: number,
  nowSec: number
): Subscription {
  const dbConn = getDb();
  const existing: Subscription | undefined = dbConn
    .prepare<unknown[]>(
      `SELECT * FROM subscriptions WHERE telegramUserId=? AND chatId=? AND active=1 LIMIT 1`
    )
    .get(telegramUserId, chatId) as Subscription | undefined;

  const secondsToAdd = Math.floor(months * 30 * 24 * 60 * 60); // approx
  let startAt = nowSec;
  let endAt = nowSec + secondsToAdd;

  if (existing) {
    startAt = existing.startAt;
    endAt = Math.max(existing.endAt, nowSec) + secondsToAdd;
    dbConn.prepare(
      `UPDATE subscriptions SET endAt=@endAt, planCode=@planCode WHERE id=@id`
    ).run({ id: existing.id, endAt, planCode });
    return { ...existing, endAt, planCode };
  }

  const info = dbConn.prepare(
    `INSERT INTO subscriptions (telegramUserId, chatId, planCode, startAt, endAt, active)
     VALUES (@telegramUserId, @chatId, @planCode, @startAt, @endAt, 1)`
  ).run({ telegramUserId, chatId, planCode, startAt, endAt });

  const inserted = dbConn.prepare(
    `SELECT * FROM subscriptions WHERE id=?`
  ).get(info.lastInsertRowid) as Subscription;
  return inserted;
}

export function findExpiredActiveSubscriptions(nowSec: number): Subscription[] {
  const rows = getDb().prepare(
    `SELECT * FROM subscriptions WHERE active=1 AND endAt <= ?`
  ).all(nowSec) as Subscription[];
  return rows;
}

export function deactivateSubscription(id: number): void {
  getDb().prepare(`UPDATE subscriptions SET active=0 WHERE id=?`).run(id);
}

export function hasActiveSubscription(telegramUserId: number, chatId: string, nowSec: number): boolean {
  const row = getDb().prepare(
    `SELECT 1 FROM subscriptions WHERE telegramUserId=? AND chatId=? AND active=1 AND endAt > ? LIMIT 1`
  ).get(telegramUserId, chatId, nowSec) as { 1: number } | undefined;
  return !!row;
}

export function listKnownUserIds(): number[] {
  const rows = getDb().prepare(
    `SELECT DISTINCT telegramUserId AS uid FROM payments
     UNION
     SELECT DISTINCT telegramUserId AS uid FROM subscriptions`
  ).all() as { uid: number }[];
  return rows.map(r => r.uid);
}

export function getLastReminderAt(telegramUserId: number): number | null {
  const row = getDb().prepare(
    `SELECT lastSentAt as ts FROM reminders_non_subscribed WHERE telegramUserId=?`
  ).get(telegramUserId) as { ts: number } | undefined;
  return row ? row.ts : null;
}

export function setReminderSentNow(telegramUserId: number, nowSec: number): void {
  getDb().prepare(
    `INSERT INTO reminders_non_subscribed (telegramUserId, lastSentAt)
     VALUES (@telegramUserId, @nowSec)
     ON CONFLICT(telegramUserId) DO UPDATE SET lastSentAt=@nowSec`
  ).run({ telegramUserId, nowSec });
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key=?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare(
    `INSERT INTO settings (key, value) VALUES (@key, @value)
     ON CONFLICT(key) DO UPDATE SET value=@value`
  ).run({ key, value });
}

export function getLastPendingPayment(telegramUserId: number): { invoiceId: string; planCode: PlanCode } | null {
  const row = getDb().prepare(
    `SELECT invoiceId, planCode FROM payments
     WHERE telegramUserId=? AND status IN ('created','processing','holded')
     ORDER BY createdAt DESC LIMIT 1`
  ).get(telegramUserId) as { invoiceId: string; planCode: PlanCode } | undefined;
  return row ?? null;
}

export function markPaymentStatus(invoiceId: string, status: string, paidAt?: number): void {
  getDb().prepare(`UPDATE payments SET status=@status, paidAt=@paidAt WHERE invoiceId=@invoiceId`).run({
    invoiceId,
    status,
    paidAt: paidAt ?? null,
  });
}

// Атомарная проверка и обновление статуса платежа (защита от race condition)
// Возвращает true если статус был обновлён, false если платёж уже обработан
export function tryMarkPaymentSuccess(invoiceId: string, paidAt: number): boolean {
  const result = getDb().prepare(
    `UPDATE payments SET status='success', paidAt=@paidAt 
     WHERE invoiceId=@invoiceId AND status IN ('created','processing','holded')`
  ).run({ invoiceId, paidAt });
  return result.changes > 0;
}

// Получить все активные подписки (для рассылки)
export function getAllActiveSubscriptions(): Subscription[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = getDb().prepare(
    `SELECT * FROM subscriptions WHERE active=1 AND endAt > ?`
  ).all(nowSec) as Subscription[];
  return rows;
}

// Создать подписку на N дней (для тестов)
export function createSubscriptionForDays(
  telegramUserId: number,
  chatId: string,
  days: number
): Subscription {
  const dbConn = getDb();
  const nowSec = Math.floor(Date.now() / 1000);
  
  // Деактивируем старые подписки этого пользователя
  dbConn.prepare(
    `UPDATE subscriptions SET active=0 WHERE telegramUserId=? AND chatId=?`
  ).run(telegramUserId, chatId);
  
  const secondsToAdd = days * 24 * 60 * 60;
  const startAt = nowSec;
  const endAt = nowSec + secondsToAdd;
  const planCode = 'TEST' as PlanCode;

  const info = dbConn.prepare(
    `INSERT INTO subscriptions (telegramUserId, chatId, planCode, startAt, endAt, active)
     VALUES (@telegramUserId, @chatId, @planCode, @startAt, @endAt, 1)`
  ).run({ telegramUserId, chatId, planCode, startAt, endAt });

  const inserted = dbConn.prepare(
    `SELECT * FROM subscriptions WHERE id=?`
  ).get(info.lastInsertRowid) as Subscription;
  return inserted;
}

// Получить подписку пользователя (для отображения даты окончания)
export function getUserSubscription(telegramUserId: number, chatId: string): Subscription | null {
  const row = getDb().prepare(
    `SELECT * FROM subscriptions WHERE telegramUserId=? AND chatId=? AND active=1 ORDER BY endAt DESC LIMIT 1`
  ).get(telegramUserId, chatId) as Subscription | undefined;
  return row ?? null;
}

// Отозвать подписку пользователя
export function revokeUserSubscription(telegramUserId: number, chatId: string): boolean {
  const result = getDb().prepare(
    `UPDATE subscriptions SET active=0 WHERE telegramUserId=? AND chatId=? AND active=1`
  ).run(telegramUserId, chatId);
  return result.changes > 0;
}

// Сохранить/обновить информацию о пользователе
export function saveUserInfo(user: {
  telegramUserId: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
}): void {
  const nowSec = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    INSERT INTO users (telegramUserId, username, firstName, lastName, phone, updatedAt)
    VALUES (@telegramUserId, @username, @firstName, @lastName, @phone, @updatedAt)
    ON CONFLICT(telegramUserId) DO UPDATE SET
      username = COALESCE(@username, username),
      firstName = COALESCE(@firstName, firstName),
      lastName = COALESCE(@lastName, lastName),
      phone = COALESCE(@phone, phone),
      updatedAt = @updatedAt
  `).run({
    telegramUserId: user.telegramUserId,
    username: user.username ?? null,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    phone: user.phone ?? null,
    updatedAt: nowSec,
  });
}

// Получить информацию о пользователе
export function getUserInfo(telegramUserId: number): UserInfo | null {
  const row = getDb().prepare(
    `SELECT * FROM users WHERE telegramUserId = ?`
  ).get(telegramUserId) as UserInfo | undefined;
  return row ?? null;
}

// Расширенная информация о подписках с данными пользователей и платежей
export type ExtendedSubscriptionInfo = {
  id: number;
  telegramUserId: number;
  planCode: PlanCode;
  startAt: number;
  endAt: number;
  // User info
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  // Payment info
  paidAt?: number | null;
  amount?: number | null;
};

export function getExtendedActiveSubscriptions(): ExtendedSubscriptionInfo[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = getDb().prepare(`
    SELECT 
      s.id,
      s.telegramUserId,
      s.planCode,
      s.startAt,
      s.endAt,
      u.username,
      u.firstName,
      u.lastName,
      u.phone,
      p.paidAt,
      p.amount
    FROM subscriptions s
    LEFT JOIN users u ON s.telegramUserId = u.telegramUserId
    LEFT JOIN (
      SELECT telegramUserId, paidAt, amount, planCode,
             ROW_NUMBER() OVER (PARTITION BY telegramUserId ORDER BY paidAt DESC) as rn
      FROM payments WHERE status = 'success'
    ) p ON s.telegramUserId = p.telegramUserId AND p.rn = 1
    WHERE s.active = 1 AND s.endAt > ?
    ORDER BY s.endAt ASC
  `).all(nowSec) as ExtendedSubscriptionInfo[];
  return rows;
}

// Поиск пользователей по ID, username или части имени
// Ищет в таблице users И среди активных подписчиков
export function findUsersByQuery(query: string): number[] {
  const q = query.trim().toLowerCase();
  
  // Если это число - ищем по ID
  if (/^\d+$/.test(q)) {
    return [parseInt(q, 10)];
  }
  
  // Ищем по username или имени в таблице users
  const rows = getDb().prepare(`
    SELECT DISTINCT telegramUserId FROM users
    WHERE LOWER(username) LIKE ? 
       OR LOWER(firstName) LIKE ? 
       OR LOWER(lastName) LIKE ?
       OR CAST(telegramUserId AS TEXT) LIKE ?
  `).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`) as { telegramUserId: number }[];
  
  return rows.map(r => r.telegramUserId);
}

// Поиск подписчика по точному username (без @)
export function findSubscriberByUsername(username: string): number | null {
  const clean = username.replace('@', '').trim().toLowerCase();
  if (!clean) return null;
  
  const row = getDb().prepare(`
    SELECT telegramUserId FROM users WHERE LOWER(username) = ?
  `).get(clean) as { telegramUserId: number } | undefined;
  
  return row?.telegramUserId ?? null;
}

// Получить всех пользователей с активной подпиской (для рассылки)
export function getActiveSubscribersIds(): number[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = getDb().prepare(`
    SELECT DISTINCT telegramUserId FROM subscriptions
    WHERE active = 1 AND endAt > ?
  `).all(nowSec) as { telegramUserId: number }[];
  return rows.map(r => r.telegramUserId);
}

// Найти подписки, истекающие в определённый период (для напоминаний)
export function findExpiringSubscriptions(inDays: number): Subscription[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const targetStart = nowSec + (inDays * 24 * 60 * 60) - (12 * 60 * 60); // -12 часов
  const targetEnd = nowSec + (inDays * 24 * 60 * 60) + (12 * 60 * 60);   // +12 часов
  
  const rows = getDb().prepare(`
    SELECT * FROM subscriptions 
    WHERE active = 1 AND endAt >= ? AND endAt <= ?
  `).all(targetStart, targetEnd) as Subscription[];
  return rows;
}

// Таблица для отслеживания отправленных напоминаний о скором истечении
export function initExpiryRemindersTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS expiry_reminders (
      subscriptionId INTEGER NOT NULL,
      daysBeforeExpiry INTEGER NOT NULL,
      sentAt INTEGER NOT NULL,
      PRIMARY KEY (subscriptionId, daysBeforeExpiry)
    );
  `);
}

export function wasExpiryReminderSent(subscriptionId: number, daysBeforeExpiry: number): boolean {
  const row = getDb().prepare(`
    SELECT 1 FROM expiry_reminders WHERE subscriptionId = ? AND daysBeforeExpiry = ?
  `).get(subscriptionId, daysBeforeExpiry);
  return !!row;
}

export function markExpiryReminderSent(subscriptionId: number, daysBeforeExpiry: number): void {
  const nowSec = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    INSERT OR REPLACE INTO expiry_reminders (subscriptionId, daysBeforeExpiry, sentAt)
    VALUES (?, ?, ?)
  `).run(subscriptionId, daysBeforeExpiry, nowSec);
}

// Получить всех пользователей с их статусом подписки (для экспорта)
export type UserExportData = {
  telegramUserId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  hasActiveSubscription: boolean;
  subscriptionEndAt: number | null;
  subscriptionPlanCode: string | null;
  purchasedPlanCode: string | null;
  totalPaid: number;
  lastPaymentAt: number | null;
  lastPaymentAmount: number | null;
};

export function getAllUsersForExport(): UserExportData[] {
  const nowSec = Math.floor(Date.now() / 1000);
  
  // Получаем всех пользователей из разных источников
  const rows = getDb().prepare(`
    SELECT 
      COALESCE(u.telegramUserId, s.telegramUserId, p.telegramUserId) as telegramUserId,
      u.username,
      u.firstName,
      u.lastName,
      u.phone,
      s.endAt as subscriptionEndAt,
      s.planCode as subscriptionPlanCode,
      s.active as hasActiveSub,
      p.totalPaid,
      p.lastPaymentAt,
      p.lastPlanCode as purchasedPlanCode,
      p.lastAmount as lastPaymentAmount
    FROM (
      SELECT DISTINCT telegramUserId FROM users
      UNION
      SELECT DISTINCT telegramUserId FROM subscriptions
      UNION  
      SELECT DISTINCT telegramUserId FROM payments WHERE status = 'success'
    ) all_users
    LEFT JOIN users u ON all_users.telegramUserId = u.telegramUserId
    LEFT JOIN (
      SELECT telegramUserId, endAt, planCode, active,
             ROW_NUMBER() OVER (PARTITION BY telegramUserId ORDER BY endAt DESC) as rn
      FROM subscriptions WHERE active = 1
    ) s ON all_users.telegramUserId = s.telegramUserId AND s.rn = 1
    LEFT JOIN (
      SELECT 
        telegramUserId, 
        SUM(amount) as totalPaid,
        MAX(paidAt) as lastPaymentAt,
        (SELECT planCode FROM payments p2 WHERE p2.telegramUserId = payments.telegramUserId AND p2.status = 'success' ORDER BY paidAt DESC LIMIT 1) as lastPlanCode,
        (SELECT amount FROM payments p3 WHERE p3.telegramUserId = payments.telegramUserId AND p3.status = 'success' ORDER BY paidAt DESC LIMIT 1) as lastAmount
      FROM payments 
      WHERE status = 'success'
      GROUP BY telegramUserId
    ) p ON all_users.telegramUserId = p.telegramUserId
    ORDER BY s.endAt DESC NULLS LAST, all_users.telegramUserId
  `).all() as Array<{
    telegramUserId: number;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    subscriptionEndAt: number | null;
    subscriptionPlanCode: string | null;
    hasActiveSub: number | null;
    totalPaid: number | null;
    lastPaymentAt: number | null;
    purchasedPlanCode: string | null;
    lastPaymentAmount: number | null;
  }>;

  return rows.map(row => ({
    telegramUserId: row.telegramUserId,
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    hasActiveSubscription: !!(row.hasActiveSub && row.subscriptionEndAt && row.subscriptionEndAt > nowSec),
    subscriptionEndAt: row.subscriptionEndAt,
    subscriptionPlanCode: row.subscriptionPlanCode,
    purchasedPlanCode: row.purchasedPlanCode,
    totalPaid: row.totalPaid || 0,
    lastPaymentAt: row.lastPaymentAt,
    lastPaymentAmount: row.lastPaymentAmount,
  }));
}
