const { retryMintFailures } = require('./lib/services/mintService');
const { chooseMintAddress, chooseRun } = require('./lib/cli/helpers');
const { ask } = require('./lib/utils');

async function run() {
    console.log('--- Solana Saved-Run Retry Tool ---');

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

        const runRecord = await retryMintFailures({
            mintAddress,
            runId,
            connectionOptions,
            onProgress: async progress => {
                if (progress.current === 1 || progress.current === progress.total || progress.current % 10 === 0) {
                    console.log(`Retry progress ${progress.current}/${progress.total}: ${progress.wallet.publicKey} (${progress.wallet.status})`);
                }
            }
        });

        console.log(`Retry finished for ${runRecord.runId}`);
        console.log(`Status: ${runRecord.status}`);
        console.log(`Failures: ${runRecord.failures.length}`);
    } catch (error) {
        console.error(`Fatal error: ${error.message}`);
    }
}

run();
