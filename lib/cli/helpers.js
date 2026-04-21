const { ask, parseIndexedSelection } = require('../utils');
const { listMintSummaries, listRuns } = require('../storage/runStore');

function formatMintChoices(mints) {
    return mints
        .map((mint, index) => `${index + 1}. ${mint.mintAddress} (${mint.runCount} runs, latest ${mint.latestStatus} at ${mint.latestRunAt})`)
        .join('\n');
}

function formatRunChoices(runs) {
    return runs
        .map((run, index) => `${index + 1}. ${run.runId} (${run.status}, ${run.createdAt}, ${run.walletCount} wallets)`)
        .join('\n');
}

async function chooseMintAddress() {
    const mints = await listMintSummaries();
    if (!mints.length) {
        throw new Error('No saved mint history was found.');
    }

    console.log('\nSaved mints:');
    console.log(formatMintChoices(mints));
    const input = await ask('\nChoose mint by number or paste the mint address: ');
    const selectedMint = parseIndexedSelection(input, mints, mint => mint.mintAddress);

    if (!selectedMint) {
        throw new Error('Invalid mint selection.');
    }

    return selectedMint.mintAddress;
}

async function chooseRun(mintAddress) {
    const runs = await listRuns(mintAddress);
    if (!runs.length) {
        throw new Error(`No saved runs found for mint ${mintAddress}.`);
    }

    console.log(`\nSaved runs for ${mintAddress}:`);
    console.log(formatRunChoices(runs));
    const input = await ask('\nChoose run by number or paste the run id: ');
    const selectedRun = parseIndexedSelection(input, runs, run => run.runId);

    if (!selectedRun) {
        throw new Error('Invalid run selection.');
    }

    return selectedRun.runId;
}

module.exports = {
    chooseMintAddress,
    chooseRun,
    formatMintChoices,
    formatRunChoices
};
