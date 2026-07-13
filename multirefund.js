const { retryRefundFailures } = require('./lib/services/refundService');
const { chooseMintAddress, chooseRun } = require('./lib/cli/helpers');
const { ask } = require('./lib/utils');

async function run() {
    console.log('--- Solana Saved-Run Refund Retry Tool ---');

    try {
        const mintAddress = await chooseMintAddress();
        const runId = await chooseRun(mintAddress);
        const override = await ask('RPC override (`default`, cluster name, or full URL): ');
        const connectionOptions = {};
        const trimmedOverride = override.trim();

        if (trimmedOverride && trimmedOverride.toLowerCase() !== 'default') {
            if (['devnet', 'mainnet'].includes(trimmedOverride)) {
                connectionOptions.cluster = trimmedOverride;
            } else {
                connectionOptions.rpcUrl = trimmedOverride;
            }
        }

        const delayInput = await ask('Delay in ms between batches (leave empty for run default/1500): ');
        const delayMs = delayInput.trim() !== '' && !Number.isNaN(Number(delayInput.trim())) ? Number(delayInput.trim()) : undefined;

        const runRecord = await retryRefundFailures({
            mintAddress,
            runId,
            connectionOptions,
            delayMs,
            onProgress: async progress => {
                if (progress.current === 1 || progress.current === progress.total || progress.current % 25 === 0) {
                    console.log(`Refund retry progress ${progress.current}/${progress.total}: ${progress.wallet.publicKey} (${progress.wallet.status})`);
                }
            }
        });

        console.log(`Refund retry finished for ${runRecord.runId}`);
        console.log(`Status: ${runRecord.status}`);
        console.log(`Failures: ${runRecord.failures.length}`);
    } catch (error) {
        console.error(`Fatal error: ${error.message}`);
    }
}

run();
