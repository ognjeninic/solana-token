const { executeMintRun } = require('./lib/services/mintService');
const { ask, createProgressReporter } = require('./lib/utils');

async function run() {
    console.log('--- Solana Telegram-Compatible Minter ---');

    try {
        const mintAddress = await ask('Mint address: ');
        const totalAmount = await ask('Total amount: ');
        const walletCount = await ask('Wallet count: ');
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

        const progressReporter = createProgressReporter(async progress => {
            console.log(`Mint progress ${progress.current}/${progress.total}: ${progress.wallet.publicKey} (${progress.wallet.status})`);
        }, Number(walletCount), 25);

        const runRecord = await executeMintRun({
            mintAddress,
            totalAmount,
            walletCount,
            connectionOptions,
            onProgress: progressReporter
        });

        console.log(`Mint run saved to data/mints/${runRecord.mintAddress}/${runRecord.runId}.json`);
        console.log(`Status: ${runRecord.status}`);
        console.log(`Failures: ${runRecord.failures.length}`);
    } catch (error) {
        console.error(`Fatal error: ${error.message}`);
    }
}

run();
