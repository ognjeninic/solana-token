const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
const QRCode = require('qrcode');

const { getAuthorityKeypair, loadConfig } = require('../config');
const { createConnection } = require('./solana');

function getAuthorityPublicKey(config = loadConfig()) {
    return getAuthorityKeypair(config).publicKey;
}

function formatSolAmount(lamports) {
    const value = typeof lamports === 'bigint' ? lamports : BigInt(lamports || 0);
    const whole = value / BigInt(LAMPORTS_PER_SOL);
    const fraction = value % BigInt(LAMPORTS_PER_SOL);
    const fractionText = fraction.toString().padStart(9, '0').replace(/0+$/, '');
    return `${whole.toString()}${fractionText ? `.${fractionText}` : ''}`;
}

async function fetchAuthoritySolBalance({ network, rpcUrl } = {}) {
    const config = loadConfig();
    const authority = getAuthorityKeypair(config);
    const { connection, rpcUrl: resolvedRpcUrl, network: resolvedNetwork } = createConnection({
        cluster: network,
        rpcUrl
    }, config);
    const lamports = await connection.getBalance(authority.publicKey, 'confirmed');

    return {
        address: authority.publicKey.toBase58(),
        network: resolvedNetwork,
        rpcUrl: resolvedRpcUrl,
        lamports,
        balance: formatSolAmount(lamports)
    };
}

async function fetchAuthoritySolBalances() {
    const [mainnet, devnet] = await Promise.all([
        fetchAuthoritySolBalance({ network: 'mainnet' }),
        fetchAuthoritySolBalance({ network: 'devnet' })
    ]);

    return {
        address: mainnet.address,
        mainnet,
        devnet
    };
}

async function createAuthorityFundingQrPng() {
    return QRCode.toBuffer(getAuthorityPublicKey().toBase58(), {
        type: 'png',
        width: 512,
        margin: 1
    });
}

module.exports = {
    createAuthorityFundingQrPng,
    fetchAuthoritySolBalance,
    fetchAuthoritySolBalances,
    formatSolAmount,
    getAuthorityPublicKey
};
