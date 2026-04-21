const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');
const { getMint } = require('@solana/spl-token');
const { loadConfig, normalizeCluster, normalizeText } = require('../config');

const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

function getClusterApiName(cluster) {
    return normalizeCluster(cluster) === 'mainnet' ? 'mainnet-beta' : 'devnet';
}

function resolveConnectionOptions(overrides = {}, config = loadConfig()) {
    const overrideRpcUrl = normalizeText(overrides.rpcUrl);
    const overrideCluster = normalizeText(overrides.cluster);

    if (overrideRpcUrl) {
        return {
            rpcUrl: overrideRpcUrl,
            network: overrideCluster ? normalizeCluster(overrideCluster) : config.defaultCluster
        };
    }

    if (overrideCluster) {
        const network = normalizeCluster(overrideCluster);
        return {
            rpcUrl: clusterApiUrl(getClusterApiName(network)),
            network
        };
    }

    if (config.defaultRpcUrl) {
        return {
            rpcUrl: config.defaultRpcUrl,
            network: config.defaultCluster
        };
    }

    return {
        rpcUrl: clusterApiUrl(getClusterApiName(config.defaultCluster)),
        network: config.defaultCluster
    };
}

function createConnection(overrides = {}, config = loadConfig()) {
    const { rpcUrl, network } = resolveConnectionOptions(overrides, config);
    return {
        connection: new Connection(rpcUrl, 'confirmed'),
        rpcUrl,
        network
    };
}

async function getMintContext(connection, mintAddressInput) {
    const mintAddress = mintAddressInput instanceof PublicKey
        ? mintAddressInput
        : new PublicKey(String(mintAddressInput).trim());
    const mintAccountInfo = await connection.getAccountInfo(mintAddress);

    if (!mintAccountInfo) {
        throw new Error(`Mint address ${mintAddress.toBase58()} was not found on the selected cluster.`);
    }

    const programId = mintAccountInfo.owner;
    const mintInfo = await getMint(connection, mintAddress, 'confirmed', programId);

    return {
        mintAddress,
        mintInfo,
        programId
    };
}

function readBorshString(buffer, offset) {
    if (offset + 4 > buffer.length) {
        throw new Error('Invalid metadata account.');
    }

    const length = buffer.readUInt32LE(offset);
    const start = offset + 4;
    const end = start + length;

    if (end > buffer.length) {
        throw new Error('Invalid metadata string length.');
    }

    return {
        value: buffer.slice(start, end).toString('utf8').replace(/\0/g, '').trim(),
        offset: end
    };
}

function parseTokenMetadataAccount(buffer) {
    let offset = 0;
    offset += 1; // key enum
    offset += 32; // update authority
    offset += 32; // mint

    const nameField = readBorshString(buffer, offset);
    const symbolField = readBorshString(buffer, nameField.offset);
    const uriField = readBorshString(buffer, symbolField.offset);

    return {
        name: nameField.value,
        symbol: symbolField.value,
        uri: uriField.value
    };
}

function deriveTokenMetadataAddress(mintAddressInput) {
    const mintAddress = mintAddressInput instanceof PublicKey
        ? mintAddressInput
        : new PublicKey(String(mintAddressInput).trim());

    const [metadataAddress] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('metadata'),
            TOKEN_METADATA_PROGRAM_ID.toBuffer(),
            mintAddress.toBuffer()
        ],
        TOKEN_METADATA_PROGRAM_ID
    );

    return metadataAddress;
}

async function fetchTokenMetadata(connection, mintAddressInput) {
    try {
        const metadataAddress = deriveTokenMetadataAddress(mintAddressInput);
        const metadataAccount = await connection.getAccountInfo(metadataAddress);

        if (!metadataAccount?.data) {
            return null;
        }

        const parsed = parseTokenMetadataAccount(metadataAccount.data);
        if (!parsed.name && !parsed.symbol) {
            return null;
        }

        return parsed;
    } catch (error) {
        return null;
    }
}

module.exports = {
    createConnection,
    deriveTokenMetadataAddress,
    fetchTokenMetadata,
    getMintContext,
    parseTokenMetadataAccount,
    resolveConnectionOptions
};
