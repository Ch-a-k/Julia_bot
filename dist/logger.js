import { Telegram } from 'telegraf';
// Буфер для хранения последних логов в памяти
const LOG_BUFFER_SIZE = 500;
const logBuffer = [];
// Подписчики на логи в реальном времени
const logSubscribers = new Set();
let telegramInstance = null;
// Инициализация системы логирования
export function initLogger(telegram) {
    telegramInstance = telegram;
    // Перехватываем стандартные методы консоли
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    console.log = function (...args) {
        const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' ');
        addLogEntry('INFO', message);
        originalLog.apply(console, args);
    };
    console.error = function (...args) {
        const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' ');
        addLogEntry('ERROR', message);
        originalError.apply(console, args);
    };
    console.warn = function (...args) {
        const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' ');
        addLogEntry('WARN', message);
        originalWarn.apply(console, args);
    };
    console.log('[Logger] Система логирования инициализирована');
}
// Добавление записи в буфер
function addLogEntry(level, message) {
    const entry = {
        timestamp: Date.now(),
        level,
        message: message.slice(0, 500) // Ограничиваем длину
    };
    logBuffer.push(entry);
    // Поддерживаем размер буфера
    if (logBuffer.length > LOG_BUFFER_SIZE) {
        logBuffer.shift();
    }
    // Отправляем подписчикам в реальном времени (только тем, кто подписался через /logstream)
    if (logSubscribers.size > 0) {
        const time = new Date(entry.timestamp);
        const timeStr = time.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        const emoji = level === 'ERROR' ? '🔴' : level === 'WARN' ? '⚠️' : '📝';
        void broadcastToSubscribers(`${timeStr} ${emoji} ${message}`);
    }
}
// Отправка логов подписчикам (только тем, кто явно подписался)
async function broadcastToSubscribers(message) {
    if (!telegramInstance || logSubscribers.size === 0)
        return;
    // Отправляем каждому подписчику отдельно
    for (const userId of logSubscribers) {
        try {
            await telegramInstance.sendMessage(userId, `<code>${message}</code>`, {
                parse_mode: 'HTML',
                disable_notification: true
            });
        }
        catch (err) {
            // Если не удалось отправить (пользователь заблокировал бота) - отписываем
            console.warn(`[Logger] Не удалось отправить лог userId=${userId}, отписываем`);
            logSubscribers.delete(userId);
        }
    }
}
// Получение последних N логов
export function getRecentLogs(count = 50) {
    const logs = logBuffer.slice(-count);
    if (logs.length === 0) {
        return '📭 Логи пусты';
    }
    const lines = logs.map(entry => {
        const time = new Date(entry.timestamp);
        const timeStr = time.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        const emoji = entry.level === 'ERROR' ? '🔴' : entry.level === 'WARN' ? '⚠️' : '📝';
        return `${timeStr} ${emoji} ${entry.message}`;
    });
    return lines.join('\n');
}
// Получение только ошибок
export function getRecentErrors(count = 20) {
    const errors = logBuffer
        .filter(entry => entry.level === 'ERROR')
        .slice(-count);
    if (errors.length === 0) {
        return '✅ Ошибок не найдено';
    }
    const lines = errors.map(entry => {
        const time = new Date(entry.timestamp);
        const timeStr = time.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        return `${timeStr} 🔴 ${entry.message}`;
    });
    return lines.join('\n');
}
// Подписка на логи
export function subscribeToLogs(userId) {
    logSubscribers.add(userId);
    return true;
}
// Отписка от логов
export function unsubscribeFromLogs(userId) {
    return logSubscribers.delete(userId);
}
// Проверка подписки
export function isSubscribed(userId) {
    return logSubscribers.has(userId);
}
// Получение статистики
export function getLogStats() {
    return {
        total: logBuffer.length,
        errors: logBuffer.filter(e => e.level === 'ERROR').length,
        warnings: logBuffer.filter(e => e.level === 'WARN').length,
        subscribers: logSubscribers.size
    };
}
//# sourceMappingURL=logger.js.map