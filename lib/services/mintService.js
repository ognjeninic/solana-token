const { Keypair, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, createMintToInstruction } = require('@solana/spl-token');
const bs58 = require('bs58').default || require('bs58');
const { getAuthorityKeypair, loadConfig } = require('../config');
const { createRunRecord, loadRun, saveRun } = require('../storage/runStore');
const { findToken } = require('../storage/tokenStore');
const { createConnection, fetchTokenMetadata, getMintContext } = require('./solana');
const { formatRawAmount, parsePositiveInteger, parseTokenAmountToRaw, sleep } = require('../utils');

const GAS_TOP_UP_LAMPORTS = 1_000_000;
const COMPUTE_UNIT_PRICE = 15_000;
const RETRY_DELAY_MS = 1_500;

function getRandomOffset(maxOffset) {
    if (maxOffset <= 0n) {
        return 0n;
    }

    const safeUpperBound = maxOffset > BigInt(Number.MAX_SAFE_INTEGER)
        ? Number.MAX_SAFE_INTEGER
        : Number(maxOffset);

    return BigInt(Math.floor(Math.random() * (safeUpperBound + 1)));
}

function splitRawTotal(rawTotal, walletCount) {
    const allocations = Array.from({ length: walletCount }, () => 0n);
    const bigWalletCount = BigInt(walletCount);
    const average = rawTotal / bigWalletCount;
    const remainder = rawTotal % bigWalletCount;

    for (let index = 0; index < walletCount; index += 1) {
        allocations[index] = average + (BigInt(index) < remainder ? 1n : 0n);
    }

    for (let index = 0; index + 1 < walletCount; index += 2) {
        const smallerAllocation = allocations[index + 1];
        const maxOffset = (smallerAllocation * 15n) / 100n;
        const offset = getRandomOffset(maxOffset);
        allocations[index] += offset;
        allocations[index + 1] -= offset;
    }

    return allocations;
}

function createWalletRecords(totalAmount, walletCount, decimals) {
    const rawTotal = parseTokenAmountToRaw(totalAmount, decimals);
    const allocations = splitRawTotal(rawTotal, walletCount);

    return allocations.map(rawAmount => {
        const keypair = Keypair.generate();
        return {
            publicKey: keypair.publicKey.toBase58(),
            privateKeyBase58: bs58.encode(keypair.secretKey),
            secretKey: Array.from(keypair.secretKey),
            plannedAmount: formatRawAmount(rawAmount, decimals),
            plannedRawAmount: rawAmount.toString(),
            mintedAmount: '0',
            mintedRawAmount: '0',
            status: 'pending'
        };
    });
}

async function mintWalletBatch({
    connection,
    mintAddress,
    programId,
    authority,
    runRecord,
    wallets,
    stage,
    onProgress
}) {
    let current = 0;

    for (const wallet of wallets) {
        current += 1;

        try {
            const recipientPublicKey = new PublicKey(wallet.publicKey);
            const ata = await getOrCreateAssociatedTokenAccount(
                connection,
                authority,
                mintAddress,
                recipientPublicKey,
                false,
                'confirmed',
                undefined,
                programId
            );

            const rawAmount = BigInt(wallet.plannedRawAmount);
            const transaction = new Transaction().add(
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE }),
                SystemProgram.transfer({
                    fromPubkey: authority.publicKey,
                    toPubkey: recipientPublicKey,
                    lamports: GAS_TOP_UP_LAMPORTS
                }),
                createMintToInstruction(
                    mintAddress,
                    ata.address,
                    authority.publicKey,
                    rawAmount,
                    [],
                    programId
                )
            );

            const signature = await connection.sendTransaction(transaction, [authority]);
            await connection.confirmTransaction(signature, 'confirmed');

            wallet.mintedAmount = wallet.plannedAmount;
            wallet.mintedRawAmount = wallet.plannedRawAmount;
            wallet.status = 'minted';
            wallet.lastMintSignature = signature;
        } catch (error) {
            wallet.mintedAmount = '0';
            wallet.mintedRawAmount = '0';
            wallet.status = stage === 'mint-retry' ? 'mint-retry-failed' : 'mint-failed';
            runRecord.failures.push({
                publicKey: wallet.publicKey,
                amount: wallet.plannedAmount,
                error: error.message,
                stage,
                timestamp: new Date().toISOString()
            });
        }

        await saveRun(runRecord);
        if (onProgress) {
            await onProgress({
                current,
                total: wallets.length,
                wallet,
                stage
            });
        }

        await sleep(RETRY_DELAY_MS);
    }

    const failedStatuses = new Set(['mint-failed', 'mint-retry-failed']);
    const hasFailures = runRecord.wallets.some(wallet => failedStatuses.has(wallet.status));
    runRecord.status = hasFailures ? 'minted_with_failures' : 'minted';
    await saveRun(runRecord);

    return runRecord;
}

async function executeMintRun({
    mintAddress,
    totalAmount,
    walletCount,
    tokenName = '',
    tokenSymbol = '',
    connectionOptions = {},
    onProgress
}) {
    const config = loadConfig();
    const authority = getAuthorityKeypair(config);
    const normalizedWalletCount = parsePositiveInteger(walletCount, 'Wallet count');
    const { connection, rpcUrl, network } = createConnection(connectionOptions, config);
    const { mintAddress: mintPublicKey, programId, mintInfo } = await getMintContext(connection, mintAddress);
    const tokenMetadata = await fetchTokenMetadata(connection, mintPublicKey);
    const storedToken = await findToken(mintPublicKey.toBase58());
    const wallets = createWalletRecords(totalAmount, normalizedWalletCount, mintInfo.decimals);
    const runRecord = createRunRecord({
        mintAddress: mintPublicKey.toBase58(),
        network,
        rpcUrl,
        authorityPublicKey: authority.publicKey.toBase58(),
        tokenName: String(tokenName || '').trim() || tokenMetadata?.name || storedToken?.tokenName || '',
        tokenSymbol: String(tokenSymbol || '').trim() || tokenMetadata?.symbol || storedToken?.tokenSymbol || '',
        totalAmount,
        walletCount: normalizedWalletCount,
        decimals: mintInfo.decimals,
        status: 'minting',
        wallets
    });

    await saveRun(runRecord);
    await mintWalletBatch({
        authority,
        connection,
        mintAddress: mintPublicKey,
        programId,
        runRecord,
        wallets: runRecord.wallets,
        stage: 'mint',
        onProgress
    });

    return runRecord;
}

async function retryMintFailures({ mintAddress, runId, connectionOptions = {}, onProgress }) {
    const config = loadConfig();
    const authority = getAuthorityKeypair(config);
    const runRecord = await loadRun(mintAddress, runId);
    const effectiveOptions = {
        rpcUrl: connectionOptions.rpcUrl || runRecord.rpcUrl,
        cluster: connectionOptions.cluster || runRecord.network
    };
    const { connection, rpcUrl, network } = createConnection(effectiveOptions, config);
    const { mintAddress: mintPublicKey, programId, mintInfo } = await getMintContext(connection, runRecord.mintAddress);
    const wallets = runRecord.wallets.filter(wallet => ['pending', 'mint-failed', 'mint-retry-failed'].includes(wallet.status));

    if (!wallets.length) {
        return runRecord;
    }

    runRecord.rpcUrl = rpcUrl;
    runRecord.network = network;
    runRecord.decimals = mintInfo.decimals;
    runRecord.status = 'mint-retrying';
    await saveRun(runRecord);

    await mintWalletBatch({
        authority,
        connection,
        mintAddress: mintPublicKey,
        programId,
        runRecord,
        wallets,
        stage: 'mint-retry',
        onProgress
    });

    return runRecord;
}

module.exports = {
    createWalletRecords,
    executeMintRun,
    mintWalletBatch,
    retryMintFailures,
    splitRawTotal
};
