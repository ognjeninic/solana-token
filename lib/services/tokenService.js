const { PublicKey, SystemProgram, Transaction, TransactionInstruction } = require('@solana/web3.js');
const { AuthorityType, createMint, getOrCreateAssociatedTokenAccount, mintTo, setAuthority } = require('@solana/spl-token');
const { getCreateMetadataAccountV3InstructionDataSerializer, MPL_TOKEN_METADATA_PROGRAM_ID } = require('@metaplex-foundation/mpl-token-metadata');
const { getAuthorityKeypair, loadConfig } = require('../config');
const { createConnection, deriveTokenMetadataAddress, getMintContext } = require('./solana');
const { createTokenRecord, loadToken, saveToken } = require('../storage/tokenStore');
const { formatRawAmount, parseIntegerInRange, parseTokenAmountToRaw } = require('../utils');

function normalizeRequiredText(value, label) {
    const normalized = String(value || '').trim();
    if (!normalized) {
        throw new Error(`${label} is required.`);
    }

    return normalized;
}

function parseRawAmountAllowZero(value, decimals) {
    const normalized = String(value).trim();
    if (!/^\d+(\.\d+)?$/.test(normalized)) {
        throw new Error('Amount must be a positive decimal number.');
    }

    const [wholePart, fractionalPart = ''] = normalized.split('.');
    if (fractionalPart.length > decimals) {
        throw new Error(`Amount has too many decimal places for this mint. Max decimals: ${decimals}.`);
    }

    const whole = wholePart.replace(/^0+(?=\d)/, '') || '0';
    const fraction = fractionalPart.padEnd(decimals, '0');
    const rawString = `${whole}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
    return BigInt(rawString);
}

function createMetadataInstruction({
    mintAddress,
    mintAuthority,
    payer,
    updateAuthority,
    tokenName,
    tokenSymbol,
    metadataUri
}) {
    const metadataAddress = deriveTokenMetadataAddress(mintAddress);
    const data = Buffer.from(getCreateMetadataAccountV3InstructionDataSerializer().serialize({
        data: {
            name: tokenName,
            symbol: tokenSymbol,
            uri: metadataUri,
            sellerFeeBasisPoints: 0,
            creators: null,
            collection: null,
            uses: null
        },
        isMutable: true,
        collectionDetails: null
    }));

    return new Transaction().add(new TransactionInstruction({
        programId: new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID),
        keys: [
            { pubkey: metadataAddress, isSigner: false, isWritable: true },
            { pubkey: mintAddress, isSigner: false, isWritable: false },
            { pubkey: mintAuthority.publicKey, isSigner: true, isWritable: false },
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: updateAuthority.publicKey, isSigner: true, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
        ],
        data
    }));
}

async function executeTokenCreate({
    tokenName,
    tokenSymbol,
    metadataUri,
    decimals = 6,
    initialMintAmount,
    connectionOptions = {}
}) {
    const config = loadConfig();
    const authority = getAuthorityKeypair(config);
    const normalizedName = normalizeRequiredText(tokenName, 'Token name');
    const normalizedSymbol = normalizeRequiredText(tokenSymbol, 'Token symbol');
    const normalizedMetadataUri = String(metadataUri || '').trim();
    const normalizedDecimals = parseIntegerInRange(decimals, 'Decimals', 0, 255);
    const normalizedInitialMintRaw = parseTokenAmountToRaw(initialMintAmount, normalizedDecimals);
    const { connection, rpcUrl, network } = createConnection(connectionOptions, config);
    const mintAddress = await createMint(
        connection,
        authority,
        authority.publicKey,
        null,
        normalizedDecimals
    );
    const metadataTransaction = createMetadataInstruction({
        mintAddress,
        mintAuthority: authority,
        payer: authority,
        updateAuthority: authority,
        tokenName: normalizedName,
        tokenSymbol: normalizedSymbol,
        metadataUri: normalizedMetadataUri
    });
    const metadataSignature = await connection.sendTransaction(metadataTransaction, [authority]);
    await connection.confirmTransaction(metadataSignature, 'confirmed');
    const authorityTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        mintAddress,
        authority.publicKey
    );
    const initialMintSignature = await mintTo(
        connection,
        authority,
        mintAddress,
        authorityTokenAccount.address,
        authority.publicKey,
        normalizedInitialMintRaw
    );

    const tokenRecord = createTokenRecord({
        mintAddress: mintAddress.toBase58(),
        network,
        rpcUrl,
        authorityPublicKey: authority.publicKey.toBase58(),
        tokenName: normalizedName,
        tokenSymbol: normalizedSymbol,
        decimals: normalizedDecimals,
        initialMintAmount: formatRawAmount(normalizedInitialMintRaw, normalizedDecimals),
        authorityTokenAccount: authorityTokenAccount.address.toBase58(),
        initialMintSignature,
        metadataUri: normalizedMetadataUri,
        totalMintedToAuthority: formatRawAmount(normalizedInitialMintRaw, normalizedDecimals),
        mintEvents: [
            {
                type: 'initial',
                amount: formatRawAmount(normalizedInitialMintRaw, normalizedDecimals),
                signature: initialMintSignature,
                createdAt: new Date().toISOString()
            }
        ]
    });

    await saveToken(tokenRecord);
    return tokenRecord;
}

async function executeAdditionalMint({
    mintAddress,
    amount,
    connectionOptions = {}
}) {
    const config = loadConfig();
    const authority = getAuthorityKeypair(config);
    const tokenRecord = await loadToken(mintAddress);
    const normalizedAmountRaw = parseTokenAmountToRaw(amount, tokenRecord.decimals);
    const effectiveOptions = {
        rpcUrl: connectionOptions.rpcUrl || tokenRecord.rpcUrl,
        cluster: connectionOptions.cluster || tokenRecord.network
    };
    const { connection, rpcUrl, network } = createConnection(effectiveOptions, config);
    const mintPublicKey = new PublicKey(tokenRecord.mintAddress);
    const authorityTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        mintPublicKey,
        authority.publicKey
    );
    const mintSignature = await mintTo(
        connection,
        authority,
        mintPublicKey,
        authorityTokenAccount.address,
        authority.publicKey,
        normalizedAmountRaw
    );
    const formattedAmount = formatRawAmount(normalizedAmountRaw, tokenRecord.decimals);
    const currentTotalRaw = parseRawAmountAllowZero(tokenRecord.totalMintedToAuthority, tokenRecord.decimals);
    const nextTotal = formatRawAmount(currentTotalRaw + normalizedAmountRaw, tokenRecord.decimals);

    tokenRecord.network = network;
    tokenRecord.rpcUrl = rpcUrl;
    tokenRecord.authorityTokenAccount = authorityTokenAccount.address.toBase58();
    tokenRecord.totalMintedToAuthority = nextTotal;
    tokenRecord.mintEvents = [
        ...tokenRecord.mintEvents,
        {
            type: 'manual',
            amount: formattedAmount,
            signature: mintSignature,
            createdAt: new Date().toISOString()
        }
    ];
    await saveToken(tokenRecord);

    return tokenRecord;
}

async function fetchTokenAuthorityStatus({
    mintAddress,
    connectionOptions = {}
}) {
    const config = loadConfig();
    const tokenRecord = await loadToken(mintAddress);
    const effectiveOptions = {
        rpcUrl: connectionOptions.rpcUrl || tokenRecord.rpcUrl,
        cluster: connectionOptions.cluster || tokenRecord.network
    };
    const { connection, rpcUrl, network } = createConnection(effectiveOptions, config);
    const { mintInfo, mintAddress: mintPublicKey, programId } = await getMintContext(connection, mintAddress);

    return {
        mintAddress: mintPublicKey.toBase58(),
        network,
        rpcUrl,
        mintAuthority: mintInfo.mintAuthority ? mintInfo.mintAuthority.toBase58() : null,
        freezeAuthority: mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toBase58() : null,
        programId: programId.toBase58()
    };
}

async function executeRevokeAuthority({
    mintAddress,
    authorityKind,
    connectionOptions = {}
}) {
    const config = loadConfig();
    const authority = getAuthorityKeypair(config);
    const tokenRecord = await loadToken(mintAddress);
    const effectiveOptions = {
        rpcUrl: connectionOptions.rpcUrl || tokenRecord.rpcUrl,
        cluster: connectionOptions.cluster || tokenRecord.network
    };
    const { connection, rpcUrl, network } = createConnection(effectiveOptions, config);
    const { mintAddress: mintPublicKey, mintInfo, programId } = await getMintContext(connection, mintAddress);
    const authorityType = authorityKind === 'freeze'
        ? AuthorityType.FreezeAccount
        : AuthorityType.MintTokens;
    const currentAuthority = authorityKind === 'freeze'
        ? mintInfo.freezeAuthority
        : mintInfo.mintAuthority;

    if (!currentAuthority) {
        throw new Error(`${authorityKind === 'freeze' ? 'Freeze' : 'Mint'} authority is already revoked.`);
    }

    if (!currentAuthority.equals(authority.publicKey)) {
        throw new Error(`Configured authority wallet does not control the ${authorityKind} authority for this token.`);
    }

    const signature = await setAuthority(
        connection,
        authority,
        mintPublicKey,
        authority.publicKey,
        authorityType,
        null,
        [],
        undefined,
        programId
    );

    tokenRecord.network = network;
    tokenRecord.rpcUrl = rpcUrl;
    await saveToken(tokenRecord);

    return {
        mintAddress: mintPublicKey.toBase58(),
        signature,
        network,
        rpcUrl,
        revokedAuthority: authorityKind
    };
}

module.exports = {
    executeAdditionalMint,
    executeRevokeAuthority,
    executeTokenCreate,
    fetchTokenAuthorityStatus
};
