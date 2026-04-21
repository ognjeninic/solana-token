const fs = require('fs');
const path = require('path');

const fsp = fs.promises;
const DATA_DIRECTORY = path.join(process.cwd(), 'data');
const ALLOWLIST_FILE = path.join(DATA_DIRECTORY, 'allowlist.json');

function normalizeUserIds(userIds = []) {
    return [...new Set(
        userIds
            .map(userId => String(userId || '').trim())
            .filter(userId => /^\d+$/.test(userId))
    )];
}

async function ensureAllowlistFile(seedUserIds = []) {
    await fsp.mkdir(DATA_DIRECTORY, { recursive: true });

    try {
        await fsp.access(ALLOWLIST_FILE);
    } catch (error) {
        await fsp.writeFile(
            ALLOWLIST_FILE,
            JSON.stringify({ allowedUserIds: normalizeUserIds(seedUserIds) }, null, 2)
        );
    }
}

async function loadRuntimeAllowlist(seedUserIds = []) {
    await ensureAllowlistFile(seedUserIds);
    const fileContents = await fsp.readFile(ALLOWLIST_FILE, 'utf8');
    const parsed = JSON.parse(fileContents);

    return {
        allowedUserIds: normalizeUserIds(parsed.allowedUserIds)
    };
}

async function saveRuntimeAllowlist(allowedUserIds) {
    await ensureAllowlistFile();
    const normalized = normalizeUserIds(allowedUserIds);
    await fsp.writeFile(ALLOWLIST_FILE, JSON.stringify({ allowedUserIds: normalized }, null, 2));

    return {
        allowedUserIds: normalized
    };
}

async function addAllowedUserId(userId, seedUserIds = []) {
    const current = await loadRuntimeAllowlist(seedUserIds);
    const normalized = String(userId || '').trim();

    if (!/^\d+$/.test(normalized)) {
        throw new Error('User ID must be numeric.');
    }

    if (current.allowedUserIds.includes(normalized)) {
        return {
            changed: false,
            allowedUserIds: current.allowedUserIds
        };
    }

    return {
        changed: true,
        ...(await saveRuntimeAllowlist([...current.allowedUserIds, normalized]))
    };
}

async function removeAllowedUserId(userId, seedUserIds = []) {
    const current = await loadRuntimeAllowlist(seedUserIds);
    const normalized = String(userId || '').trim();

    if (!/^\d+$/.test(normalized)) {
        throw new Error('User ID must be numeric.');
    }

    if (!current.allowedUserIds.includes(normalized)) {
        return {
            changed: false,
            allowedUserIds: current.allowedUserIds
        };
    }

    return {
        changed: true,
        ...(await saveRuntimeAllowlist(current.allowedUserIds.filter(entry => entry !== normalized)))
    };
}

module.exports = {
    addAllowedUserId,
    ALLOWLIST_FILE,
    ensureAllowlistFile,
    loadRuntimeAllowlist,
    normalizeUserIds,
    removeAllowedUserId,
    saveRuntimeAllowlist
};
