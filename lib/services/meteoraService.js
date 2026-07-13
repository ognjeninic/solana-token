const { Keypair, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const BN = require('bn.js');
const { CpAmm, derivePoolAddress, derivePositionAddress } = require('@meteora-ag/cp-amm-sdk');

const { getAuthorityKeypair, loadConfig } = require('../config');
const { createConnection, fetchTokenMetadata } = require('./solana');
const { createPoolRecord, savePool } = require('../storage/poolStore');
const { listTokens } = require('../storage/tokenStore');
const { formatRawAmount, parseTokenAmountToRaw } = require('../utils');
const { fetchAuthoritySolBalance } = require('./walletService');

const SOL_FEE_BUFFER_LAMPORTS = 10_000_000n;
const FULL_RANGE_MIN_SQRT_PRICE = '0';
const FULL_RANGE_MAX_SQRT_PRICE = '340282366920938463463374607431768211455';

function formatHeldTokenBalance(rawAmount, decimals, uiAmountString) {
    if (typeof uiAmountString === 'string' && uiAmountString.trim()) {
        return uiAmountString;
    }

    return formatRawAmount(BigInt(rawAmount || '0'), decimals);
}

function getCollectFeeModeLabel(collectFeeMode) {
    if (collectFeeMode === 2) {
        return 'Compounding';
    }

    if (collectFeeMode === 1) {
        return 'OnlyB';
    }

    return 'BothToken';
}

async function listHeldTokens({ network, rpcUrl } = {}) {
    const config = loadConfig();
    const authority = getAuthorityKeypair(config);
    const { connection, rpcUrl: resolvedRpcUrl, network: resolvedNetwork } = createConnection({
        cluster: network,
        rpcUrl
    }, config);
    const storedTokens = await listTokens();
    const storedTokenMap = new Map(storedTokens.map(token => [token.mintAddress, token]));
    const aggregated = new Map();

    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        const response = await connection.getParsedTokenAccountsByOwner(
            authority.publicKey,
            { programId },
            'confirmed'
        );

        for (const accountInfo of response.value) {
            const parsedInfo = accountInfo.account.data?.parsed?.info;
            const tokenAmount = parsedInfo?.tokenAmount;
            const mintAddress = parsedInfo?.mint;

            if (!mintAddress || !tokenAmount || tokenAmount.amount === '0') {
                continue;
            }

            if (mintAddress === NATIVE_MINT.toBase58()) {
                continue;
            }

            const existing = aggregated.get(mintAddress);
            if (existing) {
                existing.rawAmount = (BigInt(existing.rawAmount) + BigInt(tokenAmount.amount)).toString();
                existing.balance = formatHeldTokenBalance(existing.rawAmount, existing.decimals);
                existing.tokenAccounts.push(accountInfo.pubkey.toBase58());
                continue;
            }

            const storedToken = storedTokenMap.get(mintAddress);
            let tokenName = storedToken?.tokenName || '';
            let tokenSymbol = storedToken?.tokenSymbol || '';

            if ((!tokenName && !tokenSymbol) && programId.equals(TOKEN_PROGRAM_ID)) {
                const metadata = await fetchTokenMetadata(connection, mintAddress);
                tokenName = metadata?.name || '';
                tokenSymbol = metadata?.symbol || '';
            }

            const mintPublicKey = new PublicKey(mintAddress);
            const derivedAta = getAssociatedTokenAddressSync(
                mintPublicKey,
                authority.publicKey,
                false,
                programId
            );

            aggregated.set(mintAddress, {
                mintAddress,
                tokenName,
                tokenSymbol,
                decimals: tokenAmount.decimals,
                rawAmount: tokenAmount.amount,
                balance: formatHeldTokenBalance(tokenAmount.amount, tokenAmount.decimals, tokenAmount.uiAmountString),
                tokenAccount: accountInfo.pubkey.toBase58(),
                associatedTokenAccount: derivedAta.toBase58(),
                tokenAccounts: [accountInfo.pubkey.toBase58()],
                programId: programId.toBase58(),
                network: resolvedNetwork,
                rpcUrl: resolvedRpcUrl,
                isCreatedToken: Boolean(storedToken)
            });
        }
    }

    return [...aggregated.values()].sort((left, right) => {
        if (left.isCreatedToken !== right.isCreatedToken) {
            return left.isCreatedToken ? -1 : 1;
        }

        const leftLabel = `${left.tokenSymbol} ${left.tokenName} ${left.mintAddress}`.trim().toLowerCase();
        const rightLabel = `${right.tokenSymbol} ${right.tokenName} ${right.mintAddress}`.trim().toLowerCase();
        return leftLabel.localeCompare(rightLabel);
    });
}

function isFullRangeConfig(config) {
    if (!config || !config.account) return false;
    const minStr = config.account.sqrtMinPrice?.toString() || '';
    const maxStr = config.account.sqrtMaxPrice?.toString() || '';
    return minStr === FULL_RANGE_MIN_SQRT_PRICE && maxStr === FULL_RANGE_MAX_SQRT_PRICE;
}

async function chooseDefaultDammConfig(cpAmm) {
    const configs = await cpAmm.getStaticConfigs();
    if (!configs || !configs.length) {
        throw new Error('No public DAMM v2 config accounts exist on this network cluster.');
    }

    const sorted = [...configs].sort((left, right) => {
        const leftFee = BigInt(left.account?.tradeFeeRate?.toString() || '0');
        const rightFee = BigInt(right.account?.tradeFeeRate?.toString() || '0');
        if (leftFee < rightFee) return -1;
        if (leftFee > rightFee) return 1;
        if (left.account?.collectFeeMode === 2 && right.account?.collectFeeMode !== 2) return -1;
        if (left.account?.collectFeeMode !== 2 && right.account?.collectFeeMode === 2) return 1;
        return left.publicKey.toBase58().localeCompare(right.publicKey.toBase58());
    });

    const lowestFeeFullRange = sorted.find(config => isFullRangeConfig(config));
    if (lowestFeeFullRange) {
        return lowestFeeFullRange;
    }

    const widestConfigs = [...sorted];
    if (widestConfigs.length > 0) {
        widestConfigs.sort((left, right) => {
            const leftSpread = BigInt(left.account?.sqrtMaxPrice?.toString() || '0') - BigInt(left.account?.sqrtMinPrice?.toString() || '0');
            const rightSpread = BigInt(right.account?.sqrtMaxPrice?.toString() || '0') - BigInt(right.account?.sqrtMinPrice?.toString() || '0');
            if (rightSpread > leftSpread) return 1;
            if (rightSpread < leftSpread) return -1;
            const leftFee = BigInt(left.account?.tradeFeeRate?.toString() || '0');
            const rightFee = BigInt(right.account?.tradeFeeRate?.toString() || '0');
            if (leftFee < rightFee) return -1;
            if (leftFee > rightFee) return 1;
            return 0;
        });
        return widestConfigs[0];
    }

    throw new Error('No suitable full-range or wide DAMM v2 config could be found on this network cluster.');
}

async function createDammPool({
    network,
    rpcUrl,
    tokenMintAddress,
    solAmount,
    tokenAmount
}) {
    const config = loadConfig();
    const authority = getAuthorityKeypair(config);
    const heldTokens = await listHeldTokens({ network, rpcUrl });
    const selectedToken = heldTokens.find(token => token.mintAddress === tokenMintAddress);

    if (!selectedToken) {
        throw new Error('Selected token is no longer held by the bot wallet on that network.');
    }

    if (selectedToken.programId === TOKEN_2022_PROGRAM_ID.toBase58()) {
        throw new Error('DAMM v2 pool creation is currently limited to standard SPL Token mints in this bot.');
    }

    const tokenAmountRaw = parseTokenAmountToRaw(tokenAmount, selectedToken.decimals);
    const solAmountRaw = parseTokenAmountToRaw(solAmount, 9);
    const solBalance = await fetchAuthoritySolBalance({
        network: selectedToken.network,
        rpcUrl: selectedToken.rpcUrl
    });

    if (tokenAmountRaw > BigInt(selectedToken.rawAmount)) {
        throw new Error(`Not enough ${selectedToken.tokenSymbol || 'token'} balance in the bot wallet for this pool.`);
    }

    if (solAmountRaw + SOL_FEE_BUFFER_LAMPORTS > BigInt(solBalance.lamports)) {
        throw new Error('Not enough SOL in the bot wallet. Leave extra SOL for transaction fees.');
    }

    const { connection, rpcUrl: resolvedRpcUrl, network: resolvedNetwork } = createConnection({
        cluster: selectedToken.network,
        rpcUrl: selectedToken.rpcUrl
    }, config);
    const cpAmm = new CpAmm(connection);
    const configAccount = await chooseDefaultDammConfig(cpAmm);

    if (!configAccount) {
        throw new Error('No public DAMM v2 config accounts were found on the selected network.');
    }

    const tokenMint = new PublicKey(selectedToken.mintAddress);
    const quoteMint = NATIVE_MINT;
    const poolAddress = derivePoolAddress(configAccount.publicKey, tokenMint, quoteMint);
    const existingPool = await cpAmm.isPoolExist(poolAddress);

    if (existingPool) {
        throw new Error(`A DAMM v2 pool already exists for ${selectedToken.mintAddress} and SOL on ${resolvedNetwork} using the default public config.`);
    }

    const prepared = cpAmm.preparePoolCreationParams({
        tokenAAmount: new BN(tokenAmountRaw.toString()),
        tokenBAmount: new BN(solAmountRaw.toString()),
        minSqrtPrice: configAccount.account.sqrtMinPrice,
        maxSqrtPrice: configAccount.account.sqrtMaxPrice,
        collectFeeMode: configAccount.account.collectFeeMode
    });
    const positionNft = Keypair.generate();
    const createPoolTransaction = await cpAmm.createPool({
        payer: authority.publicKey,
        creator: authority.publicKey,
        config: configAccount.publicKey,
        positionNft: positionNft.publicKey,
        tokenAMint: tokenMint,
        tokenBMint: quoteMint,
        initSqrtPrice: prepared.initSqrtPrice,
        liquidityDelta: prepared.liquidityDelta,
        activationPoint: null,
        tokenAAmount: new BN(tokenAmountRaw.toString()),
        tokenBAmount: new BN(solAmountRaw.toString()),
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID
    });
    const createSignature = await connection.sendTransaction(createPoolTransaction, [authority, positionNft]);
    await connection.confirmTransaction(createSignature, 'confirmed');

    const poolRecord = createPoolRecord({
        poolAddress: poolAddress.toBase58(),
        network: resolvedNetwork,
        baseMint: tokenMint.toBase58(),
        quoteMint: quoteMint.toBase58(),
        tokenName: selectedToken.tokenName,
        tokenSymbol: selectedToken.tokenSymbol,
        solAmount,
        tokenAmount,
        configAddress: configAccount.publicKey.toBase58(),
        collectFeeMode: configAccount.account.collectFeeMode,
        tradeFeeRate: configAccount.account.tradeFeeRate?.toString() || '0',
        createSignature,
        positionAddress: derivePositionAddress(positionNft.publicKey).toBase58(),
        positionNftMint: positionNft.publicKey.toBase58(),
        meteoraUrl: `https://app.meteora.ag/pools/${poolAddress.toBase58()}`
    });
    await savePool(poolRecord);

    return {
        ...poolRecord,
        rpcUrl: resolvedRpcUrl,
        tokenBalance: selectedToken.balance,
        solBalance: solBalance.balance,
        collectFeeModeLabel: getCollectFeeModeLabel(configAccount.account.collectFeeMode)
    };
}

module.exports = {
    createDammPool,
    getCollectFeeModeLabel,
    listHeldTokens
};
