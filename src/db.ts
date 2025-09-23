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
  `);
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB is not initialized');
  return db;
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



