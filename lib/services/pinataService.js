const { PinataSDK } = require('pinata');

const { loadConfig } = require('../config');

function getPinataClient(config = loadConfig()) {
    if (!config.pinataJwt) {
        throw new Error('PINATA_JWT is required to upload token images.');
    }

    return new PinataSDK({
        pinataJwt: config.pinataJwt,
        pinataGateway: config.pinataGateway || 'gateway.pinata.cloud'
    });
}

function createIpfsUri(cid, config = loadConfig()) {
    const rawGateway = String(config?.pinataGateway || 'gateway.pinata.cloud').trim();
    const cleanGateway = rawGateway.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return `https://${cleanGateway}/ipfs/${cid}`;
}

async function uploadTokenImageToPinata({
    buffer,
    fileName,
    contentType = 'image/jpeg'
}) {
    const config = loadConfig();
    const pinata = getPinataClient(config);
    const file = new File([buffer], fileName, { type: contentType });
    const upload = await pinata.upload.public.file(file);

    return {
        cid: upload.cid,
        imageUri: createIpfsUri(upload.cid, config),
        fileName: upload.name || fileName
    };
}

async function uploadTokenMetadataToPinata({
    tokenName,
    tokenSymbol,
    imageUri
}) {
    const config = loadConfig();
    const pinata = getPinataClient(config);
    const upload = await pinata.upload.public.json({
        name: tokenName,
        symbol: tokenSymbol,
        description: `${tokenName} token`,
        image: imageUri || ''
    });

    return {
        cid: upload.cid,
        metadataUri: createIpfsUri(upload.cid, config)
    };
}

module.exports = {
    createIpfsUri,
    getPinataClient,
    uploadTokenImageToPinata,
    uploadTokenMetadataToPinata
};
