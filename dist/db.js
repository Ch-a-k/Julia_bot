import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { ONE_MONTH_APPROX_SEC, ONE_DAY_SEC } from './constants.js';
let db;
export function initDb() {
    const dir = path.dirname(config.databasePath);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
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

    CREATE TABLE IF NOT EXISTS payment_validations (
      invoiceId TEXT PRIMARY KEY,
      telegramUserId INTEGER NOT NULL,
      planCode TEXT NOT NULL,
      paidAt INTEGER NOT NULL,
      deadlineAt INTEGER NOT NULL,
      status TEXT NOT NULL,
      confirmedAt INTEGER,
      joinAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS user_channel_joins (
      telegramUserId INTEGER NOT NULL,
      chatId TEXT NOT NULL,
      lastJoinAt INTEGER NOT NULL,
      PRIMARY KEY (telegramUserId, chatId)
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
    // Мягкая миграция: добавляем счётчик напоминаний, если старый инстанс уже создан.
    try {
        db.exec(`ALTER TABLE reminders_non_subscribed ADD COLUMN sendCount INTEGER NOT NULL DEFAULT 0`);
    }
    catch {
        // column already exists
    }
}
export function getDb() {
    if (!db)
        throw new Error('DB is not initialized');
    return db;
}
export function closeDb() {
    if (db) {
        db.close();
        console.log('[DB] Соединение закрыто');
    }
}
export function insertPayment(p) {
    getDb().prepare(`INSERT INTO payments (invoiceId, telegramUserId, planCode, amount, status, createdAt, paidAt)
     VALUES (@invoiceId, @telegramUserId, @planCode, @amount, @status, @createdAt, @paidAt)`).run(p);
}
export function hasSuccessfulPayment(telegramUserId) {
    const row = getDb().prepare(`SELECT 1 FROM payments WHERE telegramUserId=? AND status='success' LIMIT 1`).get(telegramUserId);
    return !!row;
}
export function hasValidatedPayment(telegramUserId) {
    const dbConn = getDb();
    // 1. Проверяем наличие confirmed валидации
    const confirmed = dbConn.prepare(`SELECT 1 FROM payment_validations WHERE telegramUserId=? AND status='confirmed' LIMIT 1`).get(telegramUserId);
    if (confirmed)
        return true;
    // 2. Проверяем наличие активной pending валидации
    const nowSec = Math.floor(Date.now() / 1000);
    const pending = dbConn.prepare(`SELECT deadlineAt FROM payment_validations WHERE telegramUserId=? AND status='pending' ORDER BY paidAt DESC LIMIT 1`).get(telegramUserId);
    if (pending && pending.deadlineAt >= nowSec)
        return true;
    // 3. Если нет active/confirmed валидаций, но есть успешная оплата - разрешаем доступ
    // Это позволяет работать:
    // - ручным подпискам через /grantsub (с фиктивной оплатой)
    // - старым оплатам до введения системы валидации
    // - случаям, когда валидация истекла, но есть подтвержденная оплата
    return hasSuccessfulPayment(telegramUserId);
}
// Пользователи, по которым у нас есть хоть какие-то данные (старт/подписки/оплаты),
// но при этом НЕТ ни одной успешной оплаты.
export function listUserIdsWithoutSuccessfulPayment() {
    const rows = getDb().prepare(`
    SELECT DISTINCT uid FROM (
      SELECT telegramUserId AS uid FROM users
      UNION
      SELECT telegramUserId AS uid FROM subscriptions
      UNION
      SELECT telegramUserId AS uid FROM payments
    ) all_ids
    WHERE NOT EXISTS (
      SELECT 1 FROM payments p WHERE p.telegramUserId = all_ids.uid AND p.status = 'success'
    )
  `).all();
    return rows.map(r => r.uid);
}
export function listUserIdsWithoutValidatedPayment() {
    const rows = getDb().prepare(`
    SELECT DISTINCT uid FROM (
      SELECT telegramUserId AS uid FROM users
      UNION
      SELECT telegramUserId AS uid FROM subscriptions
      UNION
      SELECT telegramUserId AS uid FROM payments
    ) all_ids
  `).all();
    return rows.map(r => r.uid).filter(uid => !hasValidatedPayment(uid));
}
export function updatePaymentStatus(invoiceId, status, paidAt) {
    getDb().prepare(`UPDATE payments SET status=@status, paidAt=@paidAt WHERE invoiceId=@invoiceId`).run({ invoiceId, status, paidAt: paidAt ?? null });
}
export function createOrExtendSubscription(telegramUserId, chatId, planCode, months, nowSec) {
    const dbConn = getDb();
    const existing = dbConn
        .prepare(`SELECT * FROM subscriptions WHERE telegramUserId=? AND chatId=? AND active=1 LIMIT 1`)
        .get(telegramUserId, chatId);
    const secondsToAdd = Math.floor(months * ONE_MONTH_APPROX_SEC);
    let startAt = nowSec;
    let endAt = nowSec + secondsToAdd;
    if (existing) {
        startAt = existing.startAt;
        endAt = Math.max(existing.endAt, nowSec) + secondsToAdd;
        dbConn.prepare(`UPDATE subscriptions SET endAt=@endAt, planCode=@planCode WHERE id=@id`).run({ id: existing.id, endAt, planCode });
        return { ...existing, endAt, planCode };
    }
    const info = dbConn.prepare(`INSERT INTO subscriptions (telegramUserId, chatId, planCode, startAt, endAt, active)
     VALUES (@telegramUserId, @chatId, @planCode, @startAt, @endAt, 1)`).run({ telegramUserId, chatId, planCode, startAt, endAt });
    const inserted = dbConn.prepare(`SELECT * FROM subscriptions WHERE id=?`).get(info.lastInsertRowid);
    return inserted;
}
export function findExpiredActiveSubscriptions(nowSec) {
    const rows = getDb().prepare(`SELECT * FROM subscriptions WHERE active=1 AND endAt <= ?`).all(nowSec);
    return rows;
}
export function deactivateSubscription(id) {
    getDb().prepare(`UPDATE subscriptions SET active=0 WHERE id=?`).run(id);
}
export function hasActiveSubscription(telegramUserId, chatId, nowSec) {
    const row = getDb().prepare(`SELECT 1 FROM subscriptions WHERE telegramUserId=? AND chatId=? AND active=1 AND endAt > ? LIMIT 1`).get(telegramUserId, chatId, nowSec);
    return !!row;
}
export function listKnownUserIds() {
    const rows = getDb().prepare(`SELECT DISTINCT telegramUserId AS uid FROM payments
     UNION
     SELECT DISTINCT telegramUserId AS uid FROM subscriptions`).all();
    return rows.map(r => r.uid);
}
export function getReminderInfo(telegramUserId) {
    const row = getDb().prepare(`SELECT lastSentAt as ts, sendCount as cnt FROM reminders_non_subscribed WHERE telegramUserId=?`).get(telegramUserId);
    return {
        lastSentAt: row?.ts ?? null,
        sendCount: row?.cnt ?? 0,
    };
}
export function setReminderSentNow(telegramUserId, nowSec) {
    getDb().prepare(`INSERT INTO reminders_non_subscribed (telegramUserId, lastSentAt, sendCount)
     VALUES (@telegramUserId, @nowSec, 1)
     ON CONFLICT(telegramUserId) DO UPDATE SET lastSentAt=@nowSec, sendCount=sendCount+1`).run({ telegramUserId, nowSec });
}
export function getSetting(key) {
    const row = getDb().prepare(`SELECT value FROM settings WHERE key=?`).get(key);
    return row?.value ?? null;
}
export function setSetting(key, value) {
    getDb().prepare(`INSERT INTO settings (key, value) VALUES (@key, @value)
     ON CONFLICT(key) DO UPDATE SET value=@value`).run({ key, value });
}
export function getLastPendingPayment(telegramUserId) {
    const row = getDb().prepare(`SELECT invoiceId, planCode FROM payments
     WHERE telegramUserId=? AND status IN ('created','processing','holded')
     ORDER BY createdAt DESC LIMIT 1`).get(telegramUserId);
    return row ?? null;
}
export function markPaymentStatus(invoiceId, status, paidAt) {
    getDb().prepare(`UPDATE payments SET status=@status, paidAt=@paidAt WHERE invoiceId=@invoiceId`).run({
        invoiceId,
        status,
        paidAt: paidAt ?? null,
    });
}
// Атомарная проверка и обновление статуса платежа (защита от race condition)
// Возвращает true если статус был обновлён, false если платёж уже обработан
export function tryMarkPaymentSuccess(invoiceId, paidAt) {
    const result = getDb().prepare(`UPDATE payments SET status='success', paidAt=@paidAt 
     WHERE invoiceId=@invoiceId AND status IN ('created','processing','holded')`).run({ invoiceId, paidAt });
    return result.changes > 0;
}
export function createPaymentValidation(p) {
    getDb().prepare(`
    INSERT OR IGNORE INTO payment_validations
    (invoiceId, telegramUserId, planCode, paidAt, deadlineAt, status, confirmedAt, joinAt)
    VALUES (@invoiceId, @telegramUserId, @planCode, @paidAt, @deadlineAt, @status, @confirmedAt, @joinAt)
  `).run({
        invoiceId: p.invoiceId,
        telegramUserId: p.telegramUserId,
        planCode: p.planCode,
        paidAt: p.paidAt,
        deadlineAt: p.deadlineAt,
        status: p.status,
        confirmedAt: p.confirmedAt ?? null,
        joinAt: p.joinAt ?? null,
    });
}
export function getPendingPaymentValidationForUser(telegramUserId, nowSec) {
    const row = getDb().prepare(`
    SELECT * FROM payment_validations
    WHERE telegramUserId=? AND status='pending' AND deadlineAt >= ?
    ORDER BY paidAt DESC LIMIT 1
  `).get(telegramUserId, nowSec);
    return row ?? null;
}
export function listPendingPaymentValidations() {
    const rows = getDb().prepare(`SELECT * FROM payment_validations WHERE status='pending' ORDER BY paidAt ASC`).all();
    return rows;
}
export function markPaymentValidationConfirmed(invoiceId, joinAt, confirmedAt) {
    const result = getDb().prepare(`
    UPDATE payment_validations
    SET status='confirmed', confirmedAt=@confirmedAt, joinAt=@joinAt
    WHERE invoiceId=@invoiceId AND status='pending'
  `).run({ invoiceId, confirmedAt, joinAt });
    return result.changes > 0;
}
export function markPaymentValidationFailed(invoiceId, failedAt) {
    const result = getDb().prepare(`
    UPDATE payment_validations
    SET status='failed', confirmedAt=@failedAt
    WHERE invoiceId=@invoiceId AND status='pending'
  `).run({ invoiceId, failedAt });
    return result.changes > 0;
}
export function recordUserChannelJoin(telegramUserId, chatId, joinAt) {
    getDb().prepare(`
    INSERT INTO user_channel_joins (telegramUserId, chatId, lastJoinAt)
    VALUES (@telegramUserId, @chatId, @joinAt)
    ON CONFLICT(telegramUserId, chatId) DO UPDATE SET lastJoinAt=@joinAt
  `).run({ telegramUserId, chatId, joinAt });
}
export function getLastUserChannelJoin(telegramUserId, chatId) {
    const row = getDb().prepare(`SELECT lastJoinAt as ts FROM user_channel_joins WHERE telegramUserId=? AND chatId=?`).get(telegramUserId, chatId);
    return row?.ts ?? null;
}
export function getRecentPayments(limit) {
    const rows = getDb().prepare(`
    SELECT 
      p.id,
      p.invoiceId,
      p.telegramUserId,
      p.planCode,
      p.amount,
      p.status,
      p.createdAt,
      p.paidAt,
      u.username,
      u.firstName,
      u.lastName,
      v.status as validationStatus,
      v.confirmedAt as validationConfirmedAt,
      v.joinAt as validationJoinAt,
      v.deadlineAt as validationDeadlineAt
    FROM payments p
    LEFT JOIN users u ON p.telegramUserId = u.telegramUserId
    LEFT JOIN payment_validations v ON p.invoiceId = v.invoiceId
    ORDER BY p.createdAt DESC
    LIMIT ?
  `).all(limit);
    return rows;
}
// Получить все активные подписки (для рассылки)
export function getAllActiveSubscriptions() {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = getDb().prepare(`SELECT * FROM subscriptions WHERE active=1 AND endAt > ?`).all(nowSec);
    return rows;
}
// Создать подписку на N дней (для тестов)
export function createSubscriptionForDays(telegramUserId, chatId, days) {
    const dbConn = getDb();
    const nowSec = Math.floor(Date.now() / 1000);
    // Деактивируем старые подписки этого пользователя
    dbConn.prepare(`UPDATE subscriptions SET active=0 WHERE telegramUserId=? AND chatId=?`).run(telegramUserId, chatId);
    const secondsToAdd = days * ONE_DAY_SEC;
    const startAt = nowSec;
    const endAt = nowSec + secondsToAdd;
    const planCode = 'TEST';
    const info = dbConn.prepare(`INSERT INTO subscriptions (telegramUserId, chatId, planCode, startAt, endAt, active)
     VALUES (@telegramUserId, @chatId, @planCode, @startAt, @endAt, 1)`).run({ telegramUserId, chatId, planCode, startAt, endAt });
    const inserted = dbConn.prepare(`SELECT * FROM subscriptions WHERE id=?`).get(info.lastInsertRowid);
    return inserted;
}
// Получить подписку пользователя (для отображения даты окончания)
export function getUserSubscription(telegramUserId, chatId) {
    const row = getDb().prepare(`SELECT * FROM subscriptions WHERE telegramUserId=? AND chatId=? AND active=1 ORDER BY endAt DESC LIMIT 1`).get(telegramUserId, chatId);
    return row ?? null;
}
// Отозвать подписку пользователя
export function revokeUserSubscription(telegramUserId, chatId) {
    const result = getDb().prepare(`UPDATE subscriptions SET active=0 WHERE telegramUserId=? AND chatId=? AND active=1`).run(telegramUserId, chatId);
    return result.changes > 0;
}
// Сохранить/обновить информацию о пользователе
export function saveUserInfo(user) {
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
export function getUserInfo(telegramUserId) {
    const row = getDb().prepare(`SELECT * FROM users WHERE telegramUserId = ?`).get(telegramUserId);
    return row ?? null;
}
export function getExtendedActiveSubscriptions() {
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
  `).all(nowSec);
    return rows;
}
// Поиск пользователей по ID, username или части имени
// Ищет в таблице users И среди активных подписчиков
export function findUsersByQuery(query) {
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
  `).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    return rows.map(r => r.telegramUserId);
}
// Поиск подписчика по точному username (без @)
export function findSubscriberByUsername(username) {
    const clean = username.replace('@', '').trim().toLowerCase();
    if (!clean)
        return null;
    const row = getDb().prepare(`
    SELECT telegramUserId FROM users WHERE LOWER(username) = ?
  `).get(clean);
    return row?.telegramUserId ?? null;
}
// Получить всех пользователей с активной подпиской (для рассылки)
export function getActiveSubscribersIds() {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = getDb().prepare(`
    SELECT DISTINCT telegramUserId FROM subscriptions
    WHERE active = 1 AND endAt > ?
  `).all(nowSec);
    return rows.map(r => r.telegramUserId);
}
// Найти подписки, истекающие в определённый период (для напоминаний)
export function findExpiringSubscriptions(inDays) {
    const nowSec = Math.floor(Date.now() / 1000);
    // Старое окно (+/-12ч вокруг now+Nд) пропускало часть подписок (например, "завтра в 02:00").
    // Для inDays=1 хотим напомнить всем, у кого окончание в ближайшие 24 часа.
    // Для остальных оставляем прежнюю логику как более "точную" вокруг цели.
    let targetStart;
    let targetEnd;
    if (inDays === 1) {
        targetStart = nowSec;
        targetEnd = nowSec + ONE_DAY_SEC;
    }
    else {
        const halfDay = ONE_DAY_SEC / 2;
        targetStart = nowSec + (inDays * ONE_DAY_SEC) - halfDay; // -12 часов
        targetEnd = nowSec + (inDays * ONE_DAY_SEC) + halfDay; // +12 часов
    }
    const rows = getDb().prepare(`
    SELECT * FROM subscriptions 
    WHERE active = 1 AND endAt >= ? AND endAt <= ?
  `).all(targetStart, targetEnd);
    return rows;
}
// Таблица для отслеживания отправленных напоминаний о скором истечении
export function initExpiryRemindersTable() {
    getDb().exec(`
    CREATE TABLE IF NOT EXISTS expiry_reminders (
      subscriptionId INTEGER NOT NULL,
      daysBeforeExpiry INTEGER NOT NULL,
      sentAt INTEGER NOT NULL,
      PRIMARY KEY (subscriptionId, daysBeforeExpiry)
    );
  `);
}
export function wasExpiryReminderSent(subscriptionId, daysBeforeExpiry) {
    const row = getDb().prepare(`
    SELECT 1 FROM expiry_reminders WHERE subscriptionId = ? AND daysBeforeExpiry = ?
  `).get(subscriptionId, daysBeforeExpiry);
    return !!row;
}
export function markExpiryReminderSent(subscriptionId, daysBeforeExpiry) {
    const nowSec = Math.floor(Date.now() / 1000);
    getDb().prepare(`
    INSERT OR REPLACE INTO expiry_reminders (subscriptionId, daysBeforeExpiry, sentAt)
    VALUES (?, ?, ?)
  `).run(subscriptionId, daysBeforeExpiry, nowSec);
}
export function getAllUsersForExport() {
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
      p.lastAmount as lastPaymentAmount,
      p.lastValidationStatus,
      p.lastValidationAt
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
        (SELECT amount FROM payments p3 WHERE p3.telegramUserId = payments.telegramUserId AND p3.status = 'success' ORDER BY paidAt DESC LIMIT 1) as lastAmount,
        (SELECT status FROM payment_validations v WHERE v.telegramUserId = payments.telegramUserId ORDER BY paidAt DESC LIMIT 1) as lastValidationStatus,
        (SELECT confirmedAt FROM payment_validations v2 WHERE v2.telegramUserId = payments.telegramUserId ORDER BY paidAt DESC LIMIT 1) as lastValidationAt
      FROM payments 
      WHERE status = 'success'
      GROUP BY telegramUserId
    ) p ON all_users.telegramUserId = p.telegramUserId
    ORDER BY s.endAt IS NULL, s.endAt DESC, all_users.telegramUserId
  `).all();
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
        lastPaymentValidationStatus: row.lastValidationStatus ?? null,
        lastPaymentValidationAt: row.lastValidationAt ?? null,
    }));
}
//# sourceMappingURL=db.js.map