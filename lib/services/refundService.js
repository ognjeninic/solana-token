const { Keypair, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');
const {
    getAccount,
    getAssociatedTokenAddress,
    getOrCreateAssociatedTokenAccount,
    createCloseAccountInstruction,
    createTransferInstruction
} = require('@solana/spl-token');
const bs58 = require('bs58').default || require('bs58');
const { getAuthorityKeypair, loadConfig } = require('../config');
const { loadRun, saveRun } = require('../storage/runStore');
const { createConnection, getMintContext } = require('./solana');
const { formatRawAmount, sleep } = require('../utils');

const COMPUTE_UNIT_PRICE = 15_000;
const RETRY_DELAY_MS = 1_500;

function createTempWallet(walletRecord) {
    if (Array.isArray(walletRecord.secretKey) && walletRecord.secretKey.length) {
        return Keypair.fromSecretKey(Uint8Array.from(walletRecord.secretKey));
    }

    if (walletRecord.privateKeyBase58) {
        return Keypair.fromSecretKey(bs58.decode(walletRecord.privateKeyBase58));
    }

    throw new Error(`Wallet ${walletRecord.publicKey} does not have a stored secret key.`);
}

function isMissingAccountError(error) {
    return ['could not find account', 'failed to find account', 'invalid account owner']
        .some(fragment => error.message.toLowerCase().includes(fragment));
}

async function executeRefundRun({ mintAddress, runId, connectionOptions = {}, onProgress }) {
    const config = loadConfig();
    const authority = getAuthorityKeypair(config);
    const runRecord = await loadRun(mintAddress, runId);
    const effectiveOptions = {
        rpcUrl: connectionOptions.rpcUrl || runRecord.rpcUrl,
        cluster: connectionOptions.cluster || runRecord.network
    };
    const { connection, rpcUrl, network } = createConnection(effectiveOptions, config);
    const { mintAddress: mintPublicKey, programId, mintInfo } = await getMintContext(connection, runRecord.mintAddress);
    const mainAta = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        mintPublicKey,
        authority.publicKey,
        false,
        'confirmed',
        undefined,
        programId
    );

    runRecord.rpcUrl = rpcUrl;
    runRecord.network = network;
    runRecord.decimals = mintInfo.decimals;
    runRecord.status = 'refunding';
    await saveRun(runRecord);

    let current = 0;

    for (const wallet of runRecord.wallets) {
        current += 1;

        try {
            const tempWallet = createTempWallet(wallet);
            const tempAta = await getAssociatedTokenAddress(
                mintPublicKey,
                tempWallet.publicKey,
                false,
                programId
            );
            const account = await getAccount(connection, tempAta, 'confirmed', programId);
            const instructions = [
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE })
            ];

            if (account.amount > 0n) {
                instructions.push(createTransferInstruction(
                    tempAta,
                    mainAta.address,
                    tempWallet.publicKey,
                    account.amount,
                    [],
                    programId
                ));
            }

            instructions.push(createCloseAccountInstruction(
                tempAta,
                authority.publicKey,
                tempWallet.publicKey,
                [],
                programId
            ));

            const transaction = new Transaction().add(...instructions);
            const signature = await connection.sendTransaction(transaction, [tempWallet]);
            await connection.confirmTransaction(signature, 'confirmed');

            wallet.status = 'refunded';
            wallet.refundedAmount = formatRawAmount(account.amount, mintInfo.decimals);
            wallet.lastRefundSignature = signature;
        } catch (error) {
            if (isMissingAccountError(error)) {
                if (wallet.status === 'minted') {
                    wallet.status = 'refund-skipped';
                }
            } else {
                wallet.status = 'refund-failed';
                runRecord.failures.push({
                    publicKey: wallet.publicKey,
                    amount: wallet.mintedAmount || wallet.plannedAmount,
                    error: error.message,
                    stage: 'refund',
                    timestamp: new Date().toISOString()
                });
            }
        }

        await saveRun(runRecord);
        if (onProgress) {
            await onProgress({
                current,
                total: runRecord.wallets.length,
                wallet,
                stage: 'refund'
            });
        }

        await sleep(RETRY_DELAY_MS);
    }

    const hasRefundFailures = runRecord.wallets.some(wallet => wallet.status === 'refund-failed');
    runRecord.status = hasRefundFailures ? 'refund_partial' : 'refunded';
    await saveRun(runRecord);

    return runRecord;
}

module.exports = {
    executeRefundRun
};
