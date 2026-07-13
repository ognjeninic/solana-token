const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');
const dotenv = require('dotenv');
const { readRuntimeAuthorityOverrideSync } = require('./storage/authorityStore');

dotenv.config();

const CLUSTER_ALIASES = new Map([
    ['devnet', 'devnet'],
    ['mainnet', 'mainnet'],
    ['mainnet-beta', 'mainnet']
]);
const SUPPORTED_CLUSTERS = new Set(['devnet', 'mainnet']);

function normalizeText(value) {
    if (typeof value !== 'string') {
        return '';
    }

    return value.trim();
}

function parseCsv(value) {
    return normalizeText(value)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function normalizeCluster(value) {
    const requestedCluster = normalizeText(value) || 'devnet';
    const cluster = CLUSTER_ALIASES.get(requestedCluster);

    if (!cluster) {
        throw new Error(`Unsupported SOLANA_CLUSTER "${requestedCluster}". Use devnet or mainnet.`);
    }

    return cluster;
}

function parseAuthoritySecretKey(value) {
    const normalized = normalizeText(value);
    if (!normalized) {
        throw new Error('AUTHORITY_PRIVATE_KEY is required.');
    }

    try {
        const parsed = JSON.parse(normalized);
        if (Array.isArray(parsed)) {
            return Uint8Array.from(parsed);
        }
    } catch (error) {
        return bs58.decode(normalized);
    }

    throw new Error('AUTHORITY_PRIVATE_KEY must be base58 or a JSON array.');
}

function loadConfig(options = {}) {
    const requireTelegram = Boolean(options.requireTelegram);
    const runtimeAuthorityPrivateKey = readRuntimeAuthorityOverrideSync();
    const config = {
        telegramBotToken: normalizeText(process.env.TELEGRAM_BOT_TOKEN),
        authorityPrivateKey: runtimeAuthorityPrivateKey || normalizeText(process.env.AUTHORITY_PRIVATE_KEY),
        adminUserId: normalizeText(process.env.TELEGRAM_ADMIN_USER_ID),
        defaultRpcUrl: normalizeText(process.env.SOLANA_RPC_URL),
        mainnetRpcUrl: normalizeText(process.env.SOLANA_MAINNET_RPC_URL),
        devnetRpcUrl: normalizeText(process.env.SOLANA_DEVNET_RPC_URL),
        defaultCluster: normalizeCluster(process.env.SOLANA_CLUSTER),
        pinataJwt: normalizeText(process.env.PINATA_JWT),
        pinataGateway: normalizeText(process.env.PINATA_GATEWAY),
        allowedUserIds: parseCsv(process.env.TELEGRAM_ALLOWED_USER_IDS),
        allowedChatIds: parseCsv(process.env.TELEGRAM_ALLOWED_CHAT_IDS)
    };

    if (!config.authorityPrivateKey) {
        throw new Error('AUTHORITY_PRIVATE_KEY is required.');
    }

    if (requireTelegram) {
        if (!config.telegramBotToken) {
            throw new Error('TELEGRAM_BOT_TOKEN is required to start the Telegram bot.');
        }
    }

    return config;
}

function getAuthorityKeypair(config = loadConfig()) {
    return Keypair.fromSecretKey(parseAuthoritySecretKey(config.authorityPrivateKey));
}

module.exports = {
    getAuthorityKeypair,
    loadConfig,
    normalizeCluster,
    normalizeText,
    parseCsv,
    parseAuthoritySecretKey,
    SUPPORTED_CLUSTERS
};
