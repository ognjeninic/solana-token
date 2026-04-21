const fs = require('fs');
const path = require('path');

const fsp = fs.promises;
const DATA_ROOT = path.join(process.cwd(), 'data', 'tokens');

function getTokenFilePath(mintAddress) {
    return path.join(DATA_ROOT, `${mintAddress}.json`);
}

async function ensureTokenDataRoot() {
    await fsp.mkdir(DATA_ROOT, { recursive: true });
}

function createTokenRecord({
    mintAddress,
    createdAt = new Date().toISOString(),
    network,
    rpcUrl,
    authorityPublicKey,
    tokenName = '',
    tokenSymbol = '',
    decimals = 6,
    initialMintAmount = '0',
    authorityTokenAccount = '',
    initialMintSignature = '',
    metadataUri = '',
    totalMintedToAuthority = '0',
    mintEvents = []
}) {
    return {
        mintAddress,
        createdAt,
        network,
        rpcUrl,
        authorityPublicKey,
        tokenName: String(tokenName || '').trim(),
        tokenSymbol: String(tokenSymbol || '').trim(),
        decimals: Number(decimals),
        initialMintAmount: String(initialMintAmount || '0'),
        authorityTokenAccount: String(authorityTokenAccount || '').trim(),
        initialMintSignature: String(initialMintSignature || '').trim(),
        metadataUri: String(metadataUri || '').trim(),
        totalMintedToAuthority: String(totalMintedToAuthority || '0'),
        mintEvents: Array.isArray(mintEvents) ? mintEvents : []
    };
}

function normalizeTokenRecord(tokenRecord, mintAddress) {
    return {
        ...tokenRecord,
        mintAddress: tokenRecord.mintAddress || mintAddress,
        createdAt: tokenRecord.createdAt || new Date().toISOString(),
        network: tokenRecord.network || 'devnet',
        rpcUrl: tokenRecord.rpcUrl || '',
        authorityPublicKey: tokenRecord.authorityPublicKey || '',
        tokenName: typeof tokenRecord.tokenName === 'string' ? tokenRecord.tokenName : '',
        tokenSymbol: typeof tokenRecord.tokenSymbol === 'string' ? tokenRecord.tokenSymbol : '',
        decimals: Number.isInteger(tokenRecord.decimals) ? tokenRecord.decimals : 6,
        initialMintAmount: typeof tokenRecord.initialMintAmount === 'string' ? tokenRecord.initialMintAmount : '0',
        authorityTokenAccount: typeof tokenRecord.authorityTokenAccount === 'string' ? tokenRecord.authorityTokenAccount : '',
        initialMintSignature: typeof tokenRecord.initialMintSignature === 'string' ? tokenRecord.initialMintSignature : '',
        metadataUri: typeof tokenRecord.metadataUri === 'string' ? tokenRecord.metadataUri : '',
        totalMintedToAuthority: typeof tokenRecord.totalMintedToAuthority === 'string'
            ? tokenRecord.totalMintedToAuthority
            : (typeof tokenRecord.initialMintAmount === 'string' ? tokenRecord.initialMintAmount : '0'),
        mintEvents: Array.isArray(tokenRecord.mintEvents)
            ? tokenRecord.mintEvents.map(event => ({
                type: event?.type === 'manual' ? 'manual' : 'initial',
                amount: typeof event?.amount === 'string' ? event.amount : '0',
                signature: typeof event?.signature === 'string' ? event.signature : '',
                createdAt: typeof event?.createdAt === 'string' ? event.createdAt : new Date().toISOString()
            }))
            : []
    };
}

async function saveToken(tokenRecord) {
    await ensureTokenDataRoot();
    const normalized = normalizeTokenRecord(tokenRecord, tokenRecord.mintAddress);
    const filePath = getTokenFilePath(normalized.mintAddress);
    await fsp.writeFile(filePath, JSON.stringify(normalized, null, 2));
    return filePath;
}

async function loadToken(mintAddress) {
    const filePath = getTokenFilePath(mintAddress);
    const fileContents = await fsp.readFile(filePath, 'utf8');
    return normalizeTokenRecord(JSON.parse(fileContents), mintAddress);
}

async function findToken(mintAddress) {
    try {
        return await loadToken(mintAddress);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }

        throw error;
    }
}

async function listTokens() {
    await ensureTokenDataRoot();

    try {
        const entries = await fsp.readdir(DATA_ROOT, { withFileTypes: true });
        const tokens = [];

        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) {
                continue;
            }

            const mintAddress = entry.name.replace(/\.json$/i, '');
            const fileContents = await fsp.readFile(path.join(DATA_ROOT, entry.name), 'utf8');
            tokens.push(normalizeTokenRecord(JSON.parse(fileContents), mintAddress));
        }

        return tokens.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }

        throw error;
    }
}

module.exports = {
    createTokenRecord,
    ensureTokenDataRoot,
    findToken,
    getTokenFilePath,
    listTokens,
    loadToken,
    saveToken
};
