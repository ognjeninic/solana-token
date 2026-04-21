const readline = require('readline');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => {
        rl.close();
        resolve(answer);
    }));
}

function isPositiveInteger(value) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isInteger(parsed) && parsed > 0;
}

function parsePositiveInteger(value, label) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }

    return parsed;
}

function parsePositiveNumber(value, label) {
    const parsed = Number(String(value));
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive number.`);
    }

    return parsed;
}

function parseIntegerInRange(value, label, min, max) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${label} must be an integer between ${min} and ${max}.`);
    }

    return parsed;
}

function parseTokenAmountToRaw(value, decimals) {
    const normalized = String(value).trim();
    if (!/^\d+(\.\d+)?$/.test(normalized)) {
        throw new Error('Amount must be a positive decimal number.');
    }

    const [wholePart, fractionalPart = ''] = normalized.split('.');
    if (fractionalPart.length > decimals) {
        throw new Error(`Amount has too many decimal places for this mint. Max decimals: ${decimals}.`);
    }

    const whole = wholePart.replace(/^0+(?=\d)/, '') || '0';
    const fraction = fractionalPart.padEnd(decimals, '0');
    const rawString = `${whole}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
    const rawAmount = BigInt(rawString);

    if (rawAmount <= 0n) {
        throw new Error('Amount must be greater than zero.');
    }

    return rawAmount;
}

function formatRawAmount(rawAmount, decimals) {
    const value = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount);
    const negative = value < 0n;
    const normalized = negative ? -value : value;
    const divisor = 10n ** BigInt(decimals);
    const whole = normalized / divisor;
    const fraction = normalized % divisor;

    if (decimals === 0) {
        return `${negative ? '-' : ''}${whole.toString()}`;
    }

    const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole.toString()}${fractionText ? `.${fractionText}` : ''}`;
}

function formatAmountForDisplay(amount) {
    return String(amount).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function formatProgressBar(current, total, width = 10) {
    const safeTotal = Math.max(Number(total) || 0, 1);
    const safeCurrent = Math.max(0, Math.min(Number(current) || 0, safeTotal));
    const filled = Math.round((safeCurrent / safeTotal) * width);
    const empty = Math.max(0, width - filled);

    return `[${'#'.repeat(filled)}${'-'.repeat(empty)}]`;
}

function parseIndexedSelection(input, items, valueSelector) {
    const trimmed = String(input).trim();
    if (!trimmed) {
        return null;
    }

    if (/^\d+$/.test(trimmed)) {
        const index = Number.parseInt(trimmed, 10) - 1;
        return items[index] || null;
    }

    return items.find(item => valueSelector(item) === trimmed) || null;
}

function createProgressReporter(notify, total, chunkSize = 10) {
    let lastReported = 0;

    return async function report(progress) {
        if (!total) {
            return;
        }

        const shouldReport = progress.current === total || progress.current === 1 || progress.current - lastReported >= chunkSize;
        if (!shouldReport) {
            return;
        }

        lastReported = progress.current;
        await notify(progress);
    };
}

module.exports = {
    ask,
    createProgressReporter,
    formatAmountForDisplay,
    formatProgressBar,
    formatRawAmount,
    isPositiveInteger,
    parseIntegerInRange,
    parseIndexedSelection,
    parsePositiveInteger,
    parsePositiveNumber,
    parseTokenAmountToRaw,
    sleep
};
