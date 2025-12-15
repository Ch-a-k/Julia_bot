-- Миграция пользователей из старой базы
-- Запустить на сервере: sqlite3 data/bot.db < scripts/migrate-users.sql

-- Добавляем пользователей
INSERT OR REPLACE INTO users (telegramUserId, username, firstName, lastName, phone, updatedAt) VALUES 
(791347670, 'KosheliukOksana', 'Oksana', NULL, NULL, 1733425200),
(761479984, 'annaSmiianenko', 'Anna', 'Smiianenko', NULL, 1733425200),
(967834980, 'ZghoranetsT', 'Згоранець', 'Тетяна', NULL, 1733425200),
(579196155, 'soulcode_by_yuliia', 'Юльчик', NULL, NULL, 1733425200),
(394619840, 'elya_miniakhmetova_psy', 'Эля', 'Миниахметова', NULL, 1733425200),
(8123753756, NULL, NULL, NULL, NULL, 1733425200);

-- Добавляем подписки (chatId = -1002973843273)
INSERT OR IGNORE INTO subscriptions (telegramUserId, chatId, planCode, startAt, endAt, active) VALUES 
(791347670, '-1002973843273', 'P2M', 1733425200, 1738271221, 1),
(761479984, '-1002973843273', 'P2M', 1733425200, 1737879393, 1),
(967834980, '-1002973843273', 'P1M', 1733425200, 1735649542, 1),
(579196155, '-1002973843273', 'P1M', 1733425200, 1735583405, 1);

-- Пользователи с истёкшей подпиской (не добавляем, чтобы бот не удалял их)
-- (394619840, '-1002973843273', 'P1M', 1733425200, 1733342887, 1),  -- истекла 4 дек
-- (8123753756, '-1002973843273', 'P1M', 1733425200, 1729353841, 1), -- истекла 19 окт

SELECT 'Добавлено пользователей:' as info, COUNT(*) as count FROM users;
SELECT 'Добавлено подписок:' as info, COUNT(*) as count FROM subscriptions WHERE chatId='-1002973843273' AND active=1;








