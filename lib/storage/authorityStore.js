const fs = require('fs');
const path = require('path');

const fsp = fs.promises;
const DATA_ROOT = path.join(process.cwd(), 'data');
const AUTHORITY_FILE = path.join(DATA_ROOT, 'authority-override.json');

function readRuntimeAuthorityOverrideSync() {
    try {
        const fileContents = fs.readFileSync(AUTHORITY_FILE, 'utf8');
        const parsed = JSON.parse(fileContents);
        return typeof parsed?.authorityPrivateKey === 'string'
            ? parsed.authorityPrivateKey.trim()
            : '';
    } catch (error) {
        if (error.code === 'ENOENT') {
            return '';
        }

        throw error;
    }
}

async function setRuntimeAuthorityPrivateKey(authorityPrivateKey) {
    await fsp.mkdir(DATA_ROOT, { recursive: true });
    await fsp.writeFile(AUTHORITY_FILE, JSON.stringify({
        authorityPrivateKey: String(authorityPrivateKey || '').trim(),
        updatedAt: new Date().toISOString()
    }, null, 2));
}

module.exports = {
    readRuntimeAuthorityOverrideSync,
    setRuntimeAuthorityPrivateKey
};
