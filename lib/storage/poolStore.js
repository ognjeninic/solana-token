const fs = require('fs');
const path = require('path');

const fsp = fs.promises;
const DATA_ROOT = path.join(process.cwd(), 'data', 'pools');

function getPoolDirectory(network) {
    return path.join(DATA_ROOT, String(network || 'devnet'));
}

function getPoolFilePath(network, poolAddress) {
    return path.join(getPoolDirectory(network), `${poolAddress}.json`);
}

async function ensurePoolDirectory(network) {
    await fsp.mkdir(getPoolDirectory(network), { recursive: true });
}

function createPoolRecord({
    poolAddress,
    network,
    baseMint,
    quoteMint,
    tokenName = '',
    tokenSymbol = '',
    solAmount,
    tokenAmount,
    configAddress = '',
    collectFeeMode = 0,
    tradeFeeRate = '0',
    createdAt = new Date().toISOString(),
    createSignature = '',
    positionAddress = '',
    positionNftMint = '',
    meteoraUrl = ''
}) {
    return {
        poolAddress,
        network,
        baseMint,
        quoteMint,
        tokenName: String(tokenName || '').trim(),
        tokenSymbol: String(tokenSymbol || '').trim(),
        solAmount: String(solAmount),
        tokenAmount: String(tokenAmount),
        configAddress: String(configAddress || '').trim(),
        collectFeeMode: Number(collectFeeMode || 0),
        tradeFeeRate: String(tradeFeeRate || '0').trim(),
        createdAt,
        createSignature: String(createSignature || '').trim(),
        positionAddress: String(positionAddress || '').trim(),
        positionNftMint: String(positionNftMint || '').trim(),
        meteoraUrl: String(meteoraUrl || '').trim()
    };
}

async function savePool(poolRecord) {
    await ensurePoolDirectory(poolRecord.network);
    const filePath = getPoolFilePath(poolRecord.network, poolRecord.poolAddress);
    await fsp.writeFile(filePath, JSON.stringify(poolRecord, null, 2));
    return filePath;
}

module.exports = {
    createPoolRecord,
    ensurePoolDirectory,
    getPoolDirectory,
    getPoolFilePath,
    savePool
};
