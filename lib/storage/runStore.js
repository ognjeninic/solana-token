const fs = require('fs');
const path = require('path');

const fsp = fs.promises;
const DATA_ROOT = path.join(process.cwd(), 'data', 'mints');

function createRunId(date = new Date()) {
    return date.toISOString().replace(/[:-]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
}

function getMintDirectory(mintAddress) {
    return path.join(DATA_ROOT, mintAddress);
}

function getRunFilePath(mintAddress, runId) {
    return path.join(getMintDirectory(mintAddress), `${runId}.json`);
}

async function ensureDataRoot() {
    await fsp.mkdir(DATA_ROOT, { recursive: true });
}

async function ensureMintDirectory(mintAddress) {
    await ensureDataRoot();
    await fsp.mkdir(getMintDirectory(mintAddress), { recursive: true });
}

function createRunRecord({
    runId = createRunId(),
    mintAddress,
    createdAt = new Date().toISOString(),
    network,
    rpcUrl,
    authorityPublicKey,
    tokenName = '',
    tokenSymbol = '',
    totalAmount,
    walletCount,
    decimals,
    status = 'created',
    delayMs = 1500,
    wallets = [],
    failures = []
}) {
    return {
        runId,
        mintAddress,
        createdAt,
        network,
        rpcUrl,
        authorityPublicKey,
        tokenName,
        tokenSymbol,
        totalAmount: String(totalAmount),
        walletCount,
        decimals,
        status,
        delayMs: Number(delayMs !== undefined && delayMs !== null ? delayMs : 1500),
        wallets,
        failures
    };
}

function normalizeRunRecord(runRecord, mintAddress) {
    return {
        ...runRecord,
        mintAddress: runRecord.mintAddress || mintAddress,
        tokenName: typeof runRecord.tokenName === 'string' ? runRecord.tokenName : '',
        tokenSymbol: typeof runRecord.tokenSymbol === 'string' ? runRecord.tokenSymbol : '',
        delayMs: Number(runRecord.delayMs !== undefined && runRecord.delayMs !== null ? runRecord.delayMs : 1500),
        wallets: Array.isArray(runRecord.wallets) ? runRecord.wallets : [],
        failures: Array.isArray(runRecord.failures) ? runRecord.failures : []
    };
}

async function saveRun(runRecord) {
    await ensureMintDirectory(runRecord.mintAddress);
    const filePath = getRunFilePath(runRecord.mintAddress, runRecord.runId);
    await fsp.writeFile(filePath, JSON.stringify(runRecord, null, 2));
    return filePath;
}

async function loadRun(mintAddress, runId) {
    const normalizedRunId = String(runId).replace(/\.json$/i, '');
    const filePath = getRunFilePath(mintAddress, normalizedRunId);
    const fileContents = await fsp.readFile(filePath, 'utf8');
    return normalizeRunRecord(JSON.parse(fileContents), mintAddress);
}

async function listRuns(mintAddress) {
    const directory = getMintDirectory(mintAddress);

    try {
        const entries = await fsp.readdir(directory, { withFileTypes: true });
        const runs = [];

        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) {
                continue;
            }

            const run = normalizeRunRecord(
                JSON.parse(await fsp.readFile(path.join(directory, entry.name), 'utf8')),
                mintAddress
            );
            runs.push(run);
        }

        return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }

        throw error;
    }
}

async function listMintSummaries() {
    await ensureDataRoot();
    const entries = await fsp.readdir(DATA_ROOT, { withFileTypes: true });
    const summaries = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }

        const runs = await listRuns(entry.name);
        if (!runs.length) {
            continue;
        }

        summaries.push({
            mintAddress: entry.name,
            tokenName: runs[0].tokenName || '',
            tokenSymbol: runs[0].tokenSymbol || '',
            runCount: runs.length,
            latestRunAt: runs[0].createdAt,
            latestRunId: runs[0].runId,
            latestStatus: runs[0].status,
            latestNetwork: runs[0].network,
            latestRpcUrl: runs[0].rpcUrl
        });
    }

    return summaries.sort((left, right) => right.latestRunAt.localeCompare(left.latestRunAt));
}

async function backfillMintMetadata(mintAddress, metadata = {}) {
    const tokenName = typeof metadata.name === 'string' ? metadata.name.trim() : '';
    const tokenSymbol = typeof metadata.symbol === 'string' ? metadata.symbol.trim() : '';

    if (!tokenName && !tokenSymbol) {
        return false;
    }

    const runs = await listRuns(mintAddress);
    let updated = false;

    for (const run of runs) {
        const nextName = run.tokenName || tokenName;
        const nextSymbol = run.tokenSymbol || tokenSymbol;

        if (nextName !== run.tokenName || nextSymbol !== run.tokenSymbol) {
            run.tokenName = nextName;
            run.tokenSymbol = nextSymbol;
            await saveRun(run);
            updated = true;
        }
    }

    return updated;
}

module.exports = {
    backfillMintMetadata,
    createRunId,
    createRunRecord,
    ensureDataRoot,
    getMintDirectory,
    getRunFilePath,
    listMintSummaries,
    listRuns,
    loadRun,
    saveRun
};
