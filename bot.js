const { PublicKey, Keypair } = require('@solana/web3.js');
const { Telegraf, session, Markup } = require('telegraf');
const { loadConfig, parseAuthoritySecretKey } = require('./lib/config');
const { addAllowedUserId, loadRuntimeAllowlist, removeAllowedUserId } = require('./lib/storage/allowlistStore');
const { setRuntimeAuthorityPrivateKey } = require('./lib/storage/authorityStore');
const { backfillMintMetadata, listMintSummaries, listRuns, loadRun } = require('./lib/storage/runStore');
const { listTokens } = require('./lib/storage/tokenStore');
const { executeMintRun, retryMintFailures } = require('./lib/services/mintService');
const { executeRefundRun } = require('./lib/services/refundService');
const { executeAdditionalMint, executeRevokeAuthority, executeTokenCreate, fetchBotWalletTokenBalance, fetchTokenAuthorityStatus } = require('./lib/services/tokenService');
const { createDammPool, listHeldTokens } = require('./lib/services/meteoraService');
const { uploadTokenImageToPinata, uploadTokenMetadataToPinata } = require('./lib/services/pinataService');
const { createConnection, fetchTokenMetadata } = require('./lib/services/solana');
const { createAuthorityFundingQrPng, fetchAuthoritySolBalances, getAuthorityPublicKey } = require('./lib/services/walletService');
const { createProgressReporter, formatProgressBar, formatRawAmount, parseIntegerInRange, parsePositiveInteger, parsePositiveNumber, parseTokenAmountToRaw } = require('./lib/utils');

const config = loadConfig({ requireTelegram: true });
const bot = new Telegraf(config.telegramBotToken);
const allowlistState = {
    allowedUserIds: new Set()
};

const PAGE_SIZE = 6;
const DEFAULT_WALLET_COUNT = '10';
const DEFAULT_TOKEN_DECIMALS = '6';
const NETWORKS = ['devnet', 'mainnet'];
const RETRYABLE_MINT_STATUSES = new Set(['pending', 'mint-failed', 'mint-retry-failed']);

function createDefaultSession() {
    return {
        busy: false,
        panel: {
            chatId: null,
            messageId: null
        },
        progress: {
            chatId: null,
            messageId: null,
            kind: null,
            lastText: null,
            lastSnapshot: null,
            lastMarkupKey: null
        },
        flow: null,
        view: null,
        editField: null,
        mintPromptQueue: [],
        error: null,
        mintDraft: null,
        tokenDraft: null,
        poolState: null,
        refundState: null,
        browseState: null,
        createdTokenState: null
    };
}

function createMintDraft(overrides = {}) {
    const requestedNetwork = overrides.network || config.defaultCluster;
    const defaultNetwork = normalizeBotNetwork(requestedNetwork);
    const draft = {
        mintAddress: '',
        totalAmount: '',
        walletCount: DEFAULT_WALLET_COUNT,
        network: defaultNetwork,
        rpcOverride: getDefaultRpcForNetwork(defaultNetwork),
        tokenName: '',
        tokenSymbol: '',
        ...overrides
    };

    draft.network = normalizeBotNetwork(draft.network);
    if (!draft.rpcOverride || draft.rpcOverride === getDefaultRpcForNetwork(requestedNetwork)) {
        draft.rpcOverride = getDefaultRpcForNetwork(draft.network);
    }

    return draft;
}

function createRefundState() {
    return {
        mints: [],
        mintPage: 0,
        selectedMintIndex: null,
        runs: [],
        runPage: 0,
        selectedRunIndex: null
    };
}

function createBrowseState(mode = 'mints') {
    return {
        mode,
        mints: [],
        mintPage: 0,
        selectedMintIndex: null,
        runs: [],
        runPage: 0,
        selectedRunIndex: null
    };
}

function createTokenDraft(overrides = {}) {
    const requestedNetwork = overrides.network || config.defaultCluster;
    const defaultNetwork = normalizeBotNetwork(requestedNetwork);
    const draft = {
        tokenName: '',
        tokenSymbol: '',
        decimals: DEFAULT_TOKEN_DECIMALS,
        initialMintAmount: '',
        imageUri: '',
        imageFileName: '',
        network: defaultNetwork,
        rpcOverride: getDefaultRpcForNetwork(defaultNetwork),
        ...overrides
    };

    draft.network = normalizeBotNetwork(draft.network);
    if (!draft.rpcOverride || draft.rpcOverride === getDefaultRpcForNetwork(requestedNetwork)) {
        draft.rpcOverride = getDefaultRpcForNetwork(draft.network);
    }

    return draft;
}

function createCreatedTokenState() {
    return {
        tokens: [],
        tokenPage: 0,
        selectedTokenIndex: null,
        additionalMintAmount: '',
        runs: [],
        runPage: 0,
        selectedRunIndex: null
    };
}

function createPoolDraft(overrides = {}) {
    const requestedNetwork = overrides.network || config.defaultCluster;
    const defaultNetwork = normalizeBotNetwork(requestedNetwork);

    return {
        network: defaultNetwork,
        tokenMintAddress: '',
        tokenName: '',
        tokenSymbol: '',
        tokenDecimals: 0,
        tokenProgramId: '',
        tokenBalance: '0',
        solBalance: '0',
        solAmount: '',
        tokenAmount: '',
        ...overrides
    };
}

function createPoolState() {
    return {
        network: null,
        tokens: [],
        tokenPage: 0,
        selectedTokenIndex: null,
        draft: null
    };
}

function isAuthorized(ctx) {
    const userId = String(ctx.from?.id || '');
    const chatId = String(ctx.chat?.id || '');
    const userAllowed = allowlistState.allowedUserIds.size
        ? allowlistState.allowedUserIds.has(userId)
        : !config.allowedUserIds.length || config.allowedUserIds.includes(userId);
    const chatAllowed = !config.allowedChatIds.length || config.allowedChatIds.includes(chatId);
    return userAllowed && chatAllowed;
}

function isAdmin(ctx) {
    return Boolean(config.adminUserId) && String(ctx.from?.id || '') === config.adminUserId;
}

function resetSession(ctx, options = {}) {
    const preservePanel = options.preservePanel !== false;
    const preserveProgress = Boolean(options.preserveProgress);
    const panel = preservePanel ? ctx.session.panel : { chatId: null, messageId: null };
    const progress = preserveProgress
        ? ctx.session.progress
        : {
            chatId: null,
            messageId: null,
            kind: null,
            lastText: null,
            lastSnapshot: null,
            lastMarkupKey: null
        };

    ctx.session.flow = null;
    ctx.session.view = null;
    ctx.session.editField = null;
    ctx.session.mintPromptQueue = [];
    ctx.session.error = null;
    ctx.session.mintDraft = null;
    ctx.session.tokenDraft = null;
    ctx.session.poolState = null;
    ctx.session.refundState = null;
    ctx.session.browseState = null;
    ctx.session.createdTokenState = null;
    ctx.session.panel = panel;
    ctx.session.progress = progress;
}

function clearError(ctx) {
    ctx.session.error = null;
}

function setError(ctx, message) {
    ctx.session.error = message;
}

function getCommandArgument(ctx) {
    return ctx.message?.text?.split(/\s+/).slice(1).join(' ').trim() || '';
}

function createKeyboard(rows) {
    return Markup.inlineKeyboard(rows).reply_markup;
}

function buildActionButtons() {
    return [
        [
            Markup.button.callback('🛠️ Create Token', 'menu:create')
        ],
        [
            Markup.button.callback('💼 Wallet', 'menu:wallet'),
            Markup.button.callback('🌊 DAMM Pool', 'menu:pool')
        ],
        [
            Markup.button.callback('🪙 Mint', 'menu:mint'),
            Markup.button.callback('↩️ Refund', 'menu:refund')
        ],
        [
            Markup.button.callback('🧾 Created Tokens', 'menu:tokens'),
            Markup.button.callback('🗂️ Saved Mints', 'menu:mints')
        ]
    ];
}

function getPanelTarget(ctx) {
    if (ctx.callbackQuery?.message) {
        return {
            chatId: ctx.callbackQuery.message.chat.id,
            messageId: ctx.callbackQuery.message.message_id
        };
    }

    if (ctx.session.panel?.chatId && ctx.session.panel?.messageId) {
        return {
            chatId: ctx.session.panel.chatId,
            messageId: ctx.session.panel.messageId
        };
    }

    return null;
}

async function renderPanel(ctx, text, rows) {
    const replyMarkup = createKeyboard(rows);
    const target = getPanelTarget(ctx);

    if (target) {
        try {
            await ctx.telegram.editMessageText(target.chatId, target.messageId, undefined, text, {
                reply_markup: replyMarkup
            });
            ctx.session.panel = target;
            return;
        } catch (error) {
            if (String(error.message).includes('message is not modified')) {
                ctx.session.panel = target;
                return;
            }

            if (!String(error.message).includes('message is not modified')) {
                const sentMessage = await ctx.reply(text, { reply_markup: replyMarkup });
                ctx.session.panel = {
                    chatId: sentMessage.chat.id,
                    messageId: sentMessage.message_id
                };
                return;
            }
        }
    }

    const sentMessage = await ctx.reply(text, { reply_markup: replyMarkup });
    ctx.session.panel = {
        chatId: sentMessage.chat.id,
        messageId: sentMessage.message_id
    };
}

async function answerCallback(ctx, text) {
    if (!ctx.callbackQuery) {
        return;
    }

    try {
        await ctx.answerCbQuery(text);
    } catch (error) {
        void error;
    }
}

function getProgressTarget(ctx) {
    if (ctx.session.progress?.chatId && ctx.session.progress?.messageId) {
        return {
            chatId: ctx.session.progress.chatId,
            messageId: ctx.session.progress.messageId
        };
    }

    return null;
}

async function renderProgressMessage(ctx, text, snapshot) {
    const target = getProgressTarget(ctx);
    const rows = snapshot.kind === 'mint' && snapshot.phase === 'completed'
        ? [[Markup.button.callback('🏠 Main Menu', 'menu:main')]]
        : [];
    const replyMarkup = rows.length ? createKeyboard(rows) : undefined;
    const markupKey = JSON.stringify(rows);

    if (ctx.session.progress?.lastText === text && ctx.session.progress?.lastMarkupKey === markupKey && target) {
        ctx.session.progress.lastSnapshot = snapshot;
        return;
    }

    if (target) {
        try {
            await ctx.telegram.editMessageText(target.chatId, target.messageId, undefined, text, {
                reply_markup: replyMarkup
            });
            ctx.session.progress = {
                ...ctx.session.progress,
                lastText: text,
                lastSnapshot: snapshot,
                lastMarkupKey: markupKey
            };
            return;
        } catch (error) {
            if (String(error.message).includes('message is not modified')) {
                ctx.session.progress = {
                    ...ctx.session.progress,
                    lastText: text,
                    lastSnapshot: snapshot,
                    lastMarkupKey: markupKey
                };
                return;
            }
        }
    }

    const sentMessage = await ctx.reply(text, replyMarkup ? { reply_markup: replyMarkup } : undefined);
    ctx.session.progress = {
        chatId: sentMessage.chat.id,
        messageId: sentMessage.message_id,
        kind: snapshot.kind,
        lastText: text,
        lastSnapshot: snapshot,
        lastMarkupKey: markupKey
    };
}

function formatMintAddress(address) {
    if (!address) {
        return 'Not set';
    }

    if (address.length <= 18) {
        return address;
    }

    return `${address.slice(0, 8)}...${address.slice(-8)}`;
}

function truncateText(text, maxLength = 40) {
    const value = String(text || '').trim();
    if (value.length <= maxLength) {
        return value;
    }

    return `${value.slice(0, maxLength - 1)}…`;
}

function formatBanner(title) {
    const label = String(title || '').trim().toUpperCase();
    return `━━ ${label} ━━`;
}

function getTokenDisplay(entity) {
    const source = entity || {};
    const tokenSymbol = String(source.tokenSymbol || '').trim();
    const tokenName = String(source.tokenName || '').trim();

    if (tokenSymbol && tokenName) {
        return `${tokenSymbol} | ${tokenName}`;
    }

    if (tokenSymbol) {
        return tokenSymbol;
    }

    if (tokenName) {
        return tokenName;
    }

    return '';
}

function getMintPrimaryLabel(entity = {}) {
    return getTokenDisplay(entity) || formatMintAddress(entity.mintAddress || '');
}

function formatShortAddress(address) {
    if (!address) {
        return 'n/a';
    }

    if (address.length <= 14) {
        return address;
    }

    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function normalizeBotNetwork(network) {
    if (network === 'mainnet-beta') {
        return 'mainnet';
    }

    return NETWORKS.includes(network) ? network : 'devnet';
}

function getNetworkLabel(network) {
    return normalizeBotNetwork(network);
}

function getDefaultRpcForNetwork(network) {
    const normalizedNetwork = normalizeBotNetwork(network);
    if (normalizedNetwork === 'mainnet') {
        return config.defaultRpcUrl || 'https://api.mainnet-beta.solana.com';
    }

    return 'https://api.devnet.solana.com';
}

function formatRpcOverride(rpcOverride, network) {
    if (!rpcOverride) {
        return 'Automatic for selected network';
    }

    if (rpcOverride === getDefaultRpcForNetwork(network)) {
        return `${rpcOverride} (default)`;
    }

    return rpcOverride;
}

function formatSolBalanceLine(label, solBalance) {
    if (!solBalance) {
        return `${label}: unavailable`;
    }

    return `${label}: ${solBalance.balance} SOL`;
}

function validatePoolDraftField(field, value) {
    const trimmed = String(value).trim();

    if (field === 'solAmount') {
        parsePositiveNumber(trimmed, 'SOL amount');
        return trimmed;
    }

    if (field === 'tokenAmount') {
        parsePositiveNumber(trimmed, 'Token amount');
        return trimmed;
    }

    throw new Error('Unknown field.');
}

function getPoolDraftErrors(draft) {
    const errors = [];
    const source = draft || createPoolDraft();

    if (!NETWORKS.includes(source.network)) {
        errors.push('Network');
    }

    if (!String(source.tokenMintAddress || '').trim()) {
        errors.push('Token');
    }

    try {
        parsePositiveNumber(source.solAmount, 'SOL amount');
    } catch (error) {
        errors.push('SOL amount');
    }

    try {
        parsePositiveNumber(source.tokenAmount, 'Token amount');
    } catch (error) {
        errors.push('Token amount');
    }

    return errors;
}

async function ensureMintSummaryMetadata(summary) {
    if (!summary || summary.tokenName || summary.tokenSymbol) {
        return summary;
    }

    const { connection } = createConnection({
        cluster: summary.latestNetwork,
        rpcUrl: summary.latestRpcUrl
    }, config);
    const metadata = await fetchTokenMetadata(connection, summary.mintAddress);

    if (metadata?.name || metadata?.symbol) {
        summary.tokenName = metadata.name || '';
        summary.tokenSymbol = metadata.symbol || '';
        await backfillMintMetadata(summary.mintAddress, metadata);
    }

    return summary;
}

async function ensureMintSummariesPageMetadata(mintSummaries, page) {
    const { items } = paginate(mintSummaries, page);
    for (const summary of items) {
        await ensureMintSummaryMetadata(summary);
    }
}

function validateMintAddress(value) {
    const trimmed = String(value).trim();
    if (!trimmed) {
        throw new Error('Mint address is required.');
    }

    new PublicKey(trimmed);
    return trimmed;
}

function validateDraftField(field, value) {
    const trimmed = String(value).trim();

    if (field === 'mintAddress') {
        return validateMintAddress(trimmed);
    }

    if (field === 'totalAmount') {
        parsePositiveNumber(trimmed, 'Total amount');
        return trimmed;
    }

    if (field === 'walletCount') {
        parsePositiveInteger(trimmed, 'Wallet count');
        return trimmed;
    }

    if (field === 'rpcOverride') {
        if (!trimmed) {
            throw new Error('Custom RPC URL cannot be empty. Use the default RPC button to reset.');
        }

        return trimmed;
    }

    throw new Error('Unknown field.');
}

function validateTokenDraftField(field, value) {
    const trimmed = String(value).trim();

    if (field === 'tokenName') {
        if (!trimmed) {
            throw new Error('Token name is required.');
        }

        return trimmed;
    }

    if (field === 'tokenSymbol') {
        if (!trimmed) {
            throw new Error('Token symbol is required.');
        }

        return trimmed.toUpperCase();
    }

    if (field === 'decimals') {
        return String(parseIntegerInRange(trimmed, 'Decimals', 0, 255));
    }

    if (field === 'initialMintAmount') {
        parsePositiveNumber(trimmed, 'Initial mint amount');
        return trimmed;
    }

    if (field === 'rpcOverride') {
        if (!trimmed) {
            throw new Error('Custom RPC URL cannot be empty. Use the default RPC button to reset.');
        }

        return trimmed;
    }

    throw new Error('Unknown field.');
}

function getMintDraftErrors(draft) {
    const errors = [];

    try {
        validateMintAddress(draft.mintAddress);
    } catch (error) {
        errors.push('Mint address');
    }

    try {
        parsePositiveNumber(draft.totalAmount, 'Total amount');
    } catch (error) {
        errors.push('Total amount');
    }

    try {
        parsePositiveInteger(draft.walletCount, 'Wallet count');
    } catch (error) {
        errors.push('Wallet count');
    }

    if (!NETWORKS.includes(draft.network)) {
        errors.push('Network');
    }

    return errors;
}

function getTokenDraftErrors(draft) {
    const source = draft || createTokenDraft();
    const errors = [];

    if (!String(source.tokenName || '').trim()) {
        errors.push('Token name');
    }

    if (!String(source.tokenSymbol || '').trim()) {
        errors.push('Token symbol');
    }

    try {
        parseIntegerInRange(source.decimals, 'Decimals', 0, 255);
    } catch (error) {
        errors.push('Decimals');
    }

    try {
        parseTokenAmountToRaw(source.initialMintAmount, parseIntegerInRange(source.decimals, 'Decimals', 0, 255));
    } catch (error) {
        errors.push('Initial mint amount');
    }

    if (!NETWORKS.includes(source.network)) {
        errors.push('Network');
    }

    return errors;
}

function formatMintCardText(ctx) {
    const draft = ctx.session.mintDraft;
    const errors = draft ? getMintDraftErrors(draft) : [];
    const tokenDisplay = getTokenDisplay(draft);
    const lines = [
        formatBanner('Mint Configuration'),
        '',
        ...(tokenDisplay ? [`Token: ${tokenDisplay}`] : []),
        `Mint Address: ${formatMintAddress(draft.mintAddress)}`,
        `Total Amount: ${draft.totalAmount || 'Not set'}`,
        `Wallet Count: ${draft.walletCount || 'Not set'}`,
        `Network: ${getNetworkLabel(draft.network || 'devnet')}`,
        `RPC Override: ${formatRpcOverride(draft.rpcOverride, draft.network)}`,
        ''
    ];

    if (ctx.session.editField === 'mintAddress') {
        lines.push('Editing Mint Address: send the mint address as a normal message.');
    } else if (ctx.session.editField === 'totalAmount') {
        lines.push('Editing Total Amount: send a positive number.');
    } else if (ctx.session.editField === 'walletCount') {
        lines.push('Editing Wallet Count: send a positive integer.');
    } else if (ctx.session.editField === 'rpcOverride') {
        lines.push('Editing RPC Override: send a full custom RPC URL. Use the default RPC button to reset to the network default.');
    } else {
        lines.push('Tap a tile to edit a field, or start minting when the card looks correct.');
    }

    if (errors.length) {
        lines.push('');
        lines.push(`Missing or invalid: ${errors.join(', ')}`);
    }

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    return lines.join('\n');
}

function formatTokenCardText(ctx) {
    const draft = ctx.session.tokenDraft || createTokenDraft();
    const errors = getTokenDraftErrors(draft);
    const tokenDisplay = getTokenDisplay(draft);
    const lines = [
        formatBanner('Token Creation'),
        '',
        ...(tokenDisplay ? [`Token: ${tokenDisplay}`] : []),
        `Name: ${draft.tokenName || 'Not set'}`,
        `Symbol: ${draft.tokenSymbol || 'Not set'}`,
        `Decimals: ${draft.decimals || DEFAULT_TOKEN_DECIMALS}`,
        `Initial Mint Amount: ${draft.initialMintAmount || 'Not set'}`,
        `Token Icon: ${draft.imageUri ? `Uploaded (${draft.imageFileName || 'image'})` : 'Not set'}`,
        `Network: ${getNetworkLabel(draft.network || 'devnet')}`,
        `RPC Override: ${formatRpcOverride(draft.rpcOverride, draft.network)}`,
        ''
    ];

    if (ctx.session.editField === 'tokenName') {
        lines.push('Editing Token Name: send the token name as a normal message.');
    } else if (ctx.session.editField === 'tokenSymbol') {
        lines.push('Editing Token Symbol: send the token symbol as a normal message.');
    } else if (ctx.session.editField === 'decimals') {
        lines.push('Editing Decimals: send an integer between 0 and 255.');
    } else if (ctx.session.editField === 'initialMintAmount') {
        lines.push('Editing Initial Mint Amount: send a positive number. This will be minted into the bot wallet right after token creation.');
    } else if (ctx.session.editField === 'tokenImage') {
        lines.push('Editing Token Icon: send a photo in chat. The bot will upload it to Pinata and attach it to token metadata.');
    } else if (ctx.session.editField === 'rpcOverride') {
        lines.push('Editing RPC Override: send a full custom RPC URL. Use the default RPC button to reset to the network default.');
    } else {
        lines.push('Tap a tile to edit a field, or create the token when the card looks correct.');
    }

    if (errors.length) {
        lines.push('');
        lines.push(`Missing or invalid: ${errors.join(', ')}`);
    }

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    return lines.join('\n');
}

function buildMintCardButtons(ctx) {
    const draft = ctx.session.mintDraft;
    const startReady = getMintDraftErrors(draft).length === 0;

    return [
        [
            Markup.button.callback('🏷️ Mint Address', 'mint:edit:mintAddress'),
            Markup.button.callback('💰 Total Amount', 'mint:edit:totalAmount')
        ],
        [
            Markup.button.callback('👛 Wallet Count', 'mint:edit:walletCount'),
            Markup.button.callback(`🌐 Network: ${getNetworkLabel(draft.network)}`, 'mint:network')
        ],
        [
            Markup.button.callback('🔧 RPC Override', 'mint:edit:rpcOverride'),
            Markup.button.callback('♻️ Use Default RPC', 'mint:rpc:default')
        ],
        [
            Markup.button.callback(startReady ? '🚀 Start Mint' : '⚠️ Fix Fields First', 'mint:start')
        ],
        [
            Markup.button.callback('🏠 Main Menu', 'menu:main')
        ]
    ];
}

function buildTokenCardButtons(ctx) {
    const draft = ctx.session.tokenDraft || createTokenDraft();
    const createReady = getTokenDraftErrors(draft).length === 0;

    return [
        [
            Markup.button.callback('🏷️ Token Name', 'token:edit:tokenName'),
            Markup.button.callback('🔤 Token Symbol', 'token:edit:tokenSymbol')
        ],
        [
            Markup.button.callback('🔢 Decimals', 'token:edit:decimals'),
            Markup.button.callback('💸 Initial Mint', 'token:edit:initialMintAmount')
        ],
        [
            Markup.button.callback(draft.imageUri ? '🖼️ Token Icon: Ready' : '🖼️ Token Icon', 'token:edit:tokenImage')
        ],
        [
            Markup.button.callback(`🌐 Network: ${getNetworkLabel(draft.network)}`, 'token:network')
        ],
        [
            Markup.button.callback('🔧 RPC Override', 'token:edit:rpcOverride'),
            Markup.button.callback('♻️ Use Default RPC', 'token:rpc:default')
        ],
        [
            Markup.button.callback(createReady ? '🛠️ Create Token' : '⚠️ Fix Fields First', 'token:start')
        ],
        [
            Markup.button.callback('🏠 Main Menu', 'menu:main')
        ]
    ];
}

function formatNetworkButton(network, selectedNetwork) {
    const label = getNetworkLabel(network);
    return selectedNetwork === network ? `✅ ${label}` : `🌐 ${label}`;
}

function buildNetworkButtons(selectedNetwork) {
    return [
        [
            Markup.button.callback(formatNetworkButton('mainnet', selectedNetwork), 'mint:setnet:mainnet')
        ],
        [
            Markup.button.callback(formatNetworkButton('devnet', selectedNetwork), 'mint:setnet:devnet')
        ],
        [
            Markup.button.callback('⬅️ Back to Mint Card', 'mint:back')
        ]
    ];
}

function buildTokenNetworkButtons(selectedNetwork) {
    return [
        [
            Markup.button.callback(formatNetworkButton('mainnet', selectedNetwork), 'token:setnet:mainnet')
        ],
        [
            Markup.button.callback(formatNetworkButton('devnet', selectedNetwork), 'token:setnet:devnet')
        ],
        [
            Markup.button.callback('⬅️ Back to Token Card', 'token:back')
        ]
    ];
}

function formatNetworkPickerText(ctx) {
    const lines = [
        formatBanner('Select Network'),
        '',
        `Current: ${getNetworkLabel(ctx.session.mintDraft.network)}`,
        `RPC Override: ${formatRpcOverride(ctx.session.mintDraft.rpcOverride, ctx.session.mintDraft.network)}`,
        '',
        'Choose mainnet or devnet. Selecting a network also applies its default RPC.'
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    return lines.join('\n');
}

function formatTokenNetworkPickerText(ctx) {
    const lines = [
        formatBanner('Select Network'),
        '',
        `Current: ${getNetworkLabel(ctx.session.tokenDraft.network)}`,
        `RPC Override: ${formatRpcOverride(ctx.session.tokenDraft.rpcOverride, ctx.session.tokenDraft.network)}`,
        '',
        'Choose mainnet or devnet. Selecting a network also applies its default RPC.'
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    return lines.join('\n');
}

function buildProgressText({
    kind,
    phase,
    current,
    total,
    latestWallet,
    summary,
    error,
    details
}) {
    const safeTotal = Math.max(Number(total) || 0, 1);
    const safeCurrent = Math.max(0, Math.min(Number(current) || 0, safeTotal));
    const percent = Math.round((safeCurrent / safeTotal) * 100);
    const title = kind === 'refund' ? 'Refund Progress' : 'Mint Progress';
    const lines = [
        formatBanner(title),
        '',
        `${formatProgressBar(safeCurrent, safeTotal, 20)} ${percent}%`,
        `${safeCurrent}/${safeTotal} wallets`
    ];

    if (phase === 'starting') {
        lines.push('Latest: preparing operation');
    } else if (latestWallet) {
        lines.push(`Latest: ${latestWallet.status} ${formatShortAddress(latestWallet.publicKey)}`);
    } else {
        lines.push(`Latest: ${phase}`);
    }

    if (details && details.length) {
        lines.push('');
        lines.push(...details);
    }

    if (summary) {
        lines.push('');
        lines.push(summary);
    }

    if (error) {
        lines.push('');
        lines.push(`Error: ${error}`);
    }

    return lines.join('\n');
}

function paginate(items, page) {
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const start = safePage * PAGE_SIZE;
    const end = start + PAGE_SIZE;

    return {
        items: items.slice(start, end),
        page: safePage,
        totalPages
    };
}

function buildPaginationRow(prefix, page, totalPages) {
    if (totalPages <= 1) {
        return [];
    }

    const row = [];

    if (page > 0) {
        row.push(Markup.button.callback('⬅️ Prev', `${prefix}:${page - 1}`));
    }

    if (page < totalPages - 1) {
        row.push(Markup.button.callback('Next ➡️', `${prefix}:${page + 1}`));
    }

    return row;
}

function formatMintSummaryLabel(mint) {
    return `🪙 ${truncateText(getMintPrimaryLabel(mint), 26)} (${mint.runCount})`;
}

function buildMintListButtons(mints, page, selectionPrefix, pagePrefix, backCallback) {
    const { items, page: safePage, totalPages } = paginate(mints, page);
    const rows = items.map((mint, index) => [
        Markup.button.callback(
            formatMintSummaryLabel(mint),
            `${selectionPrefix}:${safePage * PAGE_SIZE + index}`
        )
    ]);
    const paginationRow = buildPaginationRow(pagePrefix, safePage, totalPages);

    if (paginationRow.length) {
        rows.push(paginationRow);
    }

      rows.push([
        Markup.button.callback('⬅️ Back', backCallback),
        Markup.button.callback('🏠 Main Menu', 'menu:main')
      ]);

    return {
        rows,
        page: safePage,
        totalPages
    };
}

function formatRunLabel(run) {
    return `🧾 ${run.runId} (${run.status})`;
}

function parseRawAmountOrZero(value) {
    try {
        return BigInt(String(value || '0'));
    } catch (error) {
        return 0n;
    }
}

function parseDisplayAmountOrZero(value, decimals) {
    const normalized = String(value || '').trim();
    if (!normalized || normalized === '0' || normalized === '0.0') {
        return 0n;
    }

    try {
        return parseTokenAmountToRaw(normalized, decimals);
    } catch (error) {
        return 0n;
    }
}

function getCreatedTokenTotals(token, runs = []) {
    const decimals = Number.isInteger(token?.decimals) ? token.decimals : 6;
    const botWalletRaw = token?.totalMintedToAuthority
        ? parseDisplayAmountOrZero(token.totalMintedToAuthority, decimals)
        : parseDisplayAmountOrZero(token?.initialMintAmount, decimals);

    const temporaryWalletsRaw = runs.reduce((runTotal, run) => {
        if (!Array.isArray(run?.wallets)) {
            return runTotal;
        }

        const walletTotal = run.wallets.reduce((walletSum, wallet) => {
            if (wallet?.mintedRawAmount !== undefined) {
                return walletSum + parseRawAmountOrZero(wallet.mintedRawAmount);
            }

            return walletSum + parseDisplayAmountOrZero(wallet?.mintedAmount, decimals);
        }, 0n);

        return runTotal + walletTotal;
    }, 0n);

    const acrossAllRaw = botWalletRaw + temporaryWalletsRaw;

    return {
        botWallet: formatRawAmount(botWalletRaw, decimals),
        temporaryWallets: formatRawAmount(temporaryWalletsRaw, decimals),
        acrossAll: formatRawAmount(acrossAllRaw, decimals)
    };
}

function countRetryableWallets(run) {
    return Array.isArray(run?.wallets)
        ? run.wallets.filter(wallet => RETRYABLE_MINT_STATUSES.has(wallet.status)).length
        : 0;
}

function buildRunListButtons(runs, page, selectionPrefix, pagePrefix, backCallback) {
    const { items, page: safePage, totalPages } = paginate(runs, page);
    const rows = items.map((run, index) => [
        Markup.button.callback(
            formatRunLabel(run),
            `${selectionPrefix}:${safePage * PAGE_SIZE + index}`
        )
    ]);
    const paginationRow = buildPaginationRow(pagePrefix, safePage, totalPages);

    if (paginationRow.length) {
        rows.push(paginationRow);
    }

      rows.push([
          Markup.button.callback('⬅️ Back', backCallback),
          Markup.button.callback('🏠 Main Menu', 'menu:main')
      ]);

    return {
        rows,
        page: safePage,
        totalPages
    };
}

function formatCreatedTokenLabel(token) {
    return `🧾 ${truncateText(getMintPrimaryLabel(token), 26)}`;
}

function buildCreatedTokenListButtons(tokens, page, selectionPrefix, pagePrefix, backCallback) {
    const { items, page: safePage, totalPages } = paginate(tokens, page);
    const rows = items.map((token, index) => [
        Markup.button.callback(
            formatCreatedTokenLabel(token),
            `${selectionPrefix}:${safePage * PAGE_SIZE + index}`
        )
    ]);
    const paginationRow = buildPaginationRow(pagePrefix, safePage, totalPages);

    if (paginationRow.length) {
        rows.push(paginationRow);
    }

    rows.push([
        Markup.button.callback('⬅️ Back', backCallback),
        Markup.button.callback('🏠 Main Menu', 'menu:main')
    ]);

    return {
        rows,
        page: safePage,
        totalPages
    };
}

function createMintSummaryFromRuns(token, runs) {
    const latestRun = runs[0] || null;

    return {
        mintAddress: token.mintAddress,
        tokenName: token.tokenName || '',
        tokenSymbol: token.tokenSymbol || '',
        runCount: runs.length,
        latestRunAt: latestRun?.createdAt || token.createdAt,
        latestRunId: latestRun?.runId || 'None',
        latestStatus: latestRun?.status || 'no_runs',
        latestNetwork: latestRun?.network || token.network,
        latestRpcUrl: latestRun?.rpcUrl || token.rpcUrl
    };
}

async function getCreatedTokenRunSummary(token) {
    const runs = await listRuns(token.mintAddress);

    return {
        runs,
        summary: createMintSummaryFromRuns(token, runs)
    };
}

async function getMainMenuText(introText) {
    const lines = [
        formatBanner('Solana Token Tools'),
        ''
    ];

    try {
        const balances = await fetchAuthoritySolBalances();
        lines.push(`💼 Wallet: ${balances.address}`);
        lines.push(formatSolBalanceLine('🟢 Mainnet', balances.mainnet));
        lines.push(formatSolBalanceLine('🔵 Devnet', balances.devnet));
    } catch (error) {
        lines.push('💼 Wallet balances are temporarily unavailable.');
    }

    lines.push('');
    lines.push(introText || 'Choose an action from the button menu below.');
    return lines.join('\n');
}

async function renderMainMenu(ctx, introText, options = {}) {
    resetSession(ctx, {
        preservePanel: !options.forceNewMessage
    });
    const text = await getMainMenuText(introText);
    await renderPanel(ctx, text, buildActionButtons());
}

function formatHeldTokenPickerLabel(token) {
    return `🪙 ${truncateText(getMintPrimaryLabel(token), 18)} • ${truncateText(token.balance, 8)}`;
}

function buildHeldTokenListButtons(tokens, page, selectionPrefix, pagePrefix, backCallback) {
    const { items, page: safePage, totalPages } = paginate(tokens, page);
    const rows = items.map((token, index) => [
        Markup.button.callback(
            formatHeldTokenPickerLabel(token),
            `${selectionPrefix}:${safePage * PAGE_SIZE + index}`
        )
    ]);
    const paginationRow = buildPaginationRow(pagePrefix, safePage, totalPages);

    if (paginationRow.length) {
        rows.push(paginationRow);
    }

    rows.push([
        Markup.button.callback('⬅️ Back', backCallback),
        Markup.button.callback('🏠 Main Menu', 'menu:main')
    ]);

    return {
        rows,
        page: safePage,
        totalPages
    };
}

async function renderWalletView(ctx, introText) {
    resetSession(ctx);
    ctx.session.flow = 'wallet';
    ctx.session.view = 'wallet';

    let balances = null;
    let errorMessage = '';

    try {
        balances = await fetchAuthoritySolBalances();
    } catch (error) {
        errorMessage = error.message;
    }

    const address = getAuthorityPublicKey().toBase58();
    const lines = [
        formatBanner('Bot Wallet'),
        '',
        ...(introText ? [introText, ''] : []),
        `🔑 Full Address: ${address}`,
        `✂️ Short Address: ${formatShortAddress(address)}`,
        ''
    ];

    if (balances) {
        lines.push(formatSolBalanceLine('🟢 Mainnet', balances.mainnet));
        lines.push(formatSolBalanceLine('🔵 Devnet', balances.devnet));
    } else {
        lines.push('SOL balances are temporarily unavailable.');
    }

    if (errorMessage) {
        lines.push('');
        lines.push(`Error: ${errorMessage}`);
    }

    await renderPanel(ctx, lines.join('\n'), [
        [
            Markup.button.callback('📋 Send Address', 'wallet:address'),
            Markup.button.callback('📷 QR Code', 'wallet:qr')
        ],
        [
            Markup.button.callback('🏠 Main Menu', 'menu:main')
        ]
    ]);
}

async function startPoolFlow(ctx) {
    resetSession(ctx);
    ctx.session.flow = 'pool';
    ctx.session.view = 'network';
    ctx.session.poolState = createPoolState();
    await renderPoolNetworkPicker(ctx);
}

async function renderPoolNetworkPicker(ctx) {
    const state = ctx.session.poolState || createPoolState();
    ctx.session.poolState = state;
    ctx.session.flow = 'pool';
    ctx.session.view = 'network';
    const lines = [
        formatBanner('DAMM Pool'),
        '',
        'Choose the network for the SOL + token DAMM v2 pool.'
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    await renderPanel(ctx, lines.join('\n'), [
        [Markup.button.callback('🟢 Mainnet', 'pool:network:mainnet')],
        [Markup.button.callback('🔵 Devnet', 'pool:network:devnet')],
        [Markup.button.callback('🏠 Main Menu', 'menu:main')]
    ]);
}

async function renderPoolTokenPicker(ctx, introText) {
    const state = ctx.session.poolState;
    const { rows, page, totalPages } = buildHeldTokenListButtons(
        state.tokens,
        state.tokenPage,
        'pool:token',
        'pool:tokens:page',
        'pool:back:network'
    );

    state.tokenPage = page;
    const lines = [
        formatBanner('Select Pool Token'),
        '',
        `🌐 Network: ${getNetworkLabel(state.network)}`,
        `Page ${page + 1} of ${totalPages}`,
        introText || 'Choose a token with a positive wallet balance. SOL is the quote asset automatically.'
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    await renderPanel(ctx, lines.join('\n'), rows);
}

function formatPoolCardText(ctx) {
    const draft = ctx.session.poolState?.draft || createPoolDraft();
    const errors = getPoolDraftErrors(draft);
    const tokenDisplay = getTokenDisplay(draft);
    const lines = [
        formatBanner('DAMM Pool Configuration'),
        '',
        `🌐 Network: ${getNetworkLabel(draft.network)}`,
        `🪙 Token: ${tokenDisplay || formatMintAddress(draft.tokenMintAddress)}`,
        `🧾 Mint Address: ${draft.tokenMintAddress}`,
        `💵 Token Balance: ${draft.tokenBalance || '0'}`,
        `◎ SOL Balance: ${draft.solBalance || '0'}`,
        '',
        'Pool Type: Meteora DAMM v2',
        'Price: derived automatically from token amount and SOL amount',
        `◎ SOL Amount: ${draft.solAmount || 'Not set'}`,
        `🪙 Token Amount: ${draft.tokenAmount || 'Not set'}`,
        ''
    ];

    if (ctx.session.editField === 'solAmount') {
        lines.push('Editing SOL Amount: send a positive number in chat.');
    } else if (ctx.session.editField === 'tokenAmount') {
        lines.push('Editing Token Amount: send a positive number in chat.');
    } else {
        lines.push('Set the liquidity amounts. DAMM will derive the starting price from the deposit ratio.');
    }

    if (errors.length) {
        lines.push('');
        lines.push(`Missing or invalid: ${errors.join(', ')}`);
    }

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    return lines.join('\n');
}

function buildPoolCardButtons(ctx) {
    const draft = ctx.session.poolState?.draft || createPoolDraft();
    const startReady = getPoolDraftErrors(draft).length === 0;

    return [
        [
            Markup.button.callback('◎ SOL Amount', 'pool:edit:solAmount'),
            Markup.button.callback('🪙 Token Amount', 'pool:edit:tokenAmount')
        ],
        [
            Markup.button.callback(startReady ? '🌊 Create DAMM Pool' : '⚠️ Fix Fields First', 'pool:start')
        ],
        [
            Markup.button.callback('⬅️ Change Token', 'pool:back:tokens'),
            Markup.button.callback('🏠 Main Menu', 'menu:main')
        ]
    ];
}

async function renderPoolCard(ctx) {
    ctx.session.flow = 'pool';
    ctx.session.view = 'config';
    await renderPanel(ctx, formatPoolCardText(ctx), buildPoolCardButtons(ctx));
}

async function updateOperationProgress(ctx, snapshot) {
    const text = buildProgressText(snapshot);
    await renderProgressMessage(ctx, text, snapshot);
}

async function startMintFlow(ctx, options = {}) {
    resetSession(ctx);
    ctx.session.flow = 'mint';
    ctx.session.view = 'config';
    ctx.session.mintDraft = createMintDraft(options.draftOverrides || {});
    ctx.session.editField = options.editField || null;
    ctx.session.mintPromptQueue = Array.isArray(options.promptQueue) ? [...options.promptQueue] : [];
    await renderMintCard(ctx);
}

async function renderMintCard(ctx) {
    ctx.session.view = 'config';
    await renderPanel(ctx, formatMintCardText(ctx), buildMintCardButtons(ctx));
}

async function renderNetworkPicker(ctx) {
    ctx.session.view = 'network';
    await renderPanel(ctx, formatNetworkPickerText(ctx), buildNetworkButtons(ctx.session.mintDraft.network));
}

async function startTokenCreateFlow(ctx, options = {}) {
    resetSession(ctx);
    ctx.session.flow = 'tokenCreate';
    ctx.session.view = 'config';
    ctx.session.tokenDraft = createTokenDraft(options.draftOverrides || {});
    ctx.session.editField = options.editField || null;
    await renderTokenCard(ctx);
}

async function renderTokenCard(ctx) {
    ctx.session.view = 'config';
    if (!ctx.session.tokenDraft) {
        ctx.session.tokenDraft = createTokenDraft();
    }
    await renderPanel(ctx, formatTokenCardText(ctx), buildTokenCardButtons(ctx));
}

async function renderTokenNetworkPicker(ctx) {
    ctx.session.view = 'network';
    await renderPanel(ctx, formatTokenNetworkPickerText(ctx), buildTokenNetworkButtons(ctx.session.tokenDraft.network));
}

async function startCreatedTokensFlow(ctx, options = {}) {
    resetSession(ctx);
    ctx.session.flow = 'createdTokens';
    ctx.session.view = 'tokens';
    ctx.session.createdTokenState = createCreatedTokenState();
    ctx.session.createdTokenState.tokens = await listTokens();

    if (!ctx.session.createdTokenState.tokens.length) {
        await renderPanel(ctx, [
            formatBanner('Created Tokens'),
            '',
            options.introText || 'No created tokens found.'
        ].join('\n'), [
            [Markup.button.callback('🏠 Main Menu', 'menu:main')]
        ]);
        return;
    }

    if (options.selectedMintAddress) {
        const selectedTokenIndex = ctx.session.createdTokenState.tokens.findIndex(
            token => token.mintAddress === options.selectedMintAddress
        );

        if (selectedTokenIndex >= 0) {
            ctx.session.createdTokenState.selectedTokenIndex = selectedTokenIndex;
            await renderCreatedTokenDetail(ctx, options.introText);
            return;
        }
    }

    await renderCreatedTokenPicker(ctx, options.introText);
}

async function renderCreatedTokenPicker(ctx, introText) {
    const state = ctx.session.createdTokenState;
    const { rows, page, totalPages } = buildCreatedTokenListButtons(
        state.tokens,
        state.tokenPage,
        'tokens:token',
        'tokens:page',
        'menu:main'
    );

    state.tokenPage = page;
    const lines = [
        formatBanner('Created Tokens'),
        '',
        `Page ${page + 1} of ${totalPages}`,
        introText || 'Choose a token you created to inspect it or start a new mint run.'
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    await renderPanel(ctx, lines.join('\n'), rows);
}

async function renderCreatedTokenDetail(ctx, introText) {
    ctx.session.flow = 'createdTokens';
    ctx.session.view = 'detail';
    ctx.session.editField = null;
    const state = ctx.session.createdTokenState;
    const selectedToken = state.tokens[state.selectedTokenIndex];
    const { runs, summary } = await getCreatedTokenRunSummary(selectedToken);
    const totals = getCreatedTokenTotals(selectedToken, runs);
    const tokenDisplay = getTokenDisplay(selectedToken);
    let authorityStatus = {
        mintAuthority: null,
        freezeAuthority: null
    };
    let walletBalance = {
        balance: '0',
        tokenAccount: selectedToken.authorityTokenAccount || ''
    };

    try {
        authorityStatus = await fetchTokenAuthorityStatus({
            mintAddress: selectedToken.mintAddress,
            connectionOptions: {
                cluster: selectedToken.network,
                rpcUrl: selectedToken.rpcUrl || undefined
            }
        });
    } catch (error) {
        void error;
    }

    try {
        walletBalance = await fetchBotWalletTokenBalance({
            mintAddress: selectedToken.mintAddress,
            connectionOptions: {
                cluster: selectedToken.network,
                rpcUrl: selectedToken.rpcUrl || undefined
            }
        });
    } catch (error) {
        void error;
    }

    const lines = [
        formatBanner('Created Token Details'),
        '',
        ...(introText ? [introText, ''] : []),
        ...(tokenDisplay ? [`🪙 Token: ${tokenDisplay}`] : []),
        `🧾 Mint Address: ${selectedToken.mintAddress}`,
        `🔢 Decimals: ${selectedToken.decimals}`,
        `🔒 Mint Authority: ${authorityStatus.mintAuthority ? '🟢 Active' : '🔴 Revoked'}`,
        `🧊 Freeze Authority: ${authorityStatus.freezeAuthority ? '🟢 Active' : '🔴 Revoked'}`,
        '',
        `🌐 Network: ${getNetworkLabel(selectedToken.network)}`,
        `🔧 RPC: ${selectedToken.rpcUrl || 'Automatic'}`,
        `🏦 Bot Token Account: ${walletBalance.tokenAccount || selectedToken.authorityTokenAccount || 'Unknown'}`,
        '',
        `📅 Created: ${selectedToken.createdAt}`,
        `🧾 Runs: ${summary.runCount}`,
        `🆔 Latest Run: ${summary.latestRunId}`,
        `📊 Latest Status: ${summary.latestStatus}`,
        `🕒 Latest Date: ${summary.latestRunAt}`,
        '',
        `💸 Initial Mint Amount: ${selectedToken.initialMintAmount || '0'}`,
        `📈 Total Minted To Bot Wallet: ${totals.botWallet}`,
        `👛 Total Minted To Temporary Wallets: ${totals.temporaryWallets}`,
        `🧮 Total Minted Across All Bot Actions: ${totals.acrossAll}`,
        `💼 Current Balance In Bot Wallet: ${walletBalance.balance}`
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    state.runs = runs;
    state.runPage = 0;
    state.selectedRunIndex = null;

    const rows = [
        [
            Markup.button.callback('🧾 View Runs', 'tokens:viewruns'),
            Markup.button.callback('🪙 New Run', 'tokens:newrun')
        ],
        [
            Markup.button.callback('➕ Additional Mint', 'tokens:additionalmint')
        ]
    ];

    if (authorityStatus.mintAuthority) {
        rows.push([
            Markup.button.callback('🔒 Revoke Mint Authority', 'tokens:revoke:mint')
        ]);
    }

    if (authorityStatus.freezeAuthority) {
        rows.push([
            Markup.button.callback('🧊 Revoke Freeze Authority', 'tokens:revoke:freeze')
        ]);
    }

    rows.push(
        [
            Markup.button.callback('⬅️ Back', 'tokens:back')
        ],
        [
            Markup.button.callback('🏠 Main Menu', 'menu:main')
        ]
    );

    await renderPanel(ctx, lines.join('\n'), rows);
}

async function renderAdditionalMintCard(ctx) {
    ctx.session.flow = 'tokenAdditionalMint';
    ctx.session.view = 'additionalMint';
    const state = ctx.session.createdTokenState;
    const selectedToken = state.tokens[state.selectedTokenIndex];
    const lines = [
        formatBanner('Additional Mint'),
        '',
        `Token: ${getMintPrimaryLabel(selectedToken)}`,
        `Mint Address: ${selectedToken.mintAddress}`,
        `Decimals: ${selectedToken.decimals}`,
        `Current Total Minted: ${selectedToken.totalMintedToAuthority || selectedToken.initialMintAmount || '0'}`,
        `Amount: ${state.additionalMintAmount || 'Not set'}`,
        '',
        ctx.session.editField === 'additionalMintAmount'
            ? 'Editing Amount: send a positive amount to mint into the bot wallet.'
            : 'Tap amount to edit it, then start the additional mint.'
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    await renderPanel(ctx, lines.join('\n'), [
        [
            Markup.button.callback('💸 Amount', 'tokens:additionalmint:edit')
        ],
        [
            Markup.button.callback('🚀 Start Additional Mint', 'tokens:additionalmint:start')
        ],
        [
            Markup.button.callback('⬅️ Back', 'tokens:additionalmint:back')
        ],
        [
            Markup.button.callback('🏠 Main Menu', 'menu:main')
        ]
    ]);
}

async function renderCreatedTokenRunPicker(ctx) {
    const state = ctx.session.createdTokenState;
    const selectedToken = state.tokens[state.selectedTokenIndex];
    const { rows, page, totalPages } = buildRunListButtons(
        state.runs,
        state.runPage,
        'tokens:runs:run',
        'tokens:runs:page',
        'tokens:detail'
    );

    state.runPage = page;
    const lines = [
        formatBanner('Created Token Runs'),
        '',
        `Token: ${getMintPrimaryLabel(selectedToken)}`,
        `Address: ${selectedToken.mintAddress}`,
        `Page ${page + 1} of ${totalPages}`,
        'Choose a run to view details.'
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    rows.splice(rows.length - 1, 0, [
        Markup.button.callback('🪙 New Run', 'tokens:newrun')
    ]);

    await renderPanel(ctx, lines.join('\n'), rows);
}

async function renderCreatedTokenRunDetail(ctx) {
    const state = ctx.session.createdTokenState;
    const selectedToken = state.tokens[state.selectedTokenIndex];
    const selectedRun = state.runs[state.selectedRunIndex];
    const retryableWalletCount = countRetryableWallets(selectedRun);
    const lines = [
        formatBanner('Created Token Run Details'),
        '',
        `Token: ${getMintPrimaryLabel(selectedToken)}`,
        `Address: ${selectedToken.mintAddress}`,
        `Run: ${selectedRun.runId}`,
        `Status: ${selectedRun.status}`,
        `Total Amount: ${selectedRun.totalAmount}`,
        `Wallets: ${selectedRun.walletCount}`,
        `Network: ${getNetworkLabel(selectedRun.network)}`,
        `RPC: ${selectedRun.rpcUrl || 'Automatic'}`,
        `Failures: ${selectedRun.failures?.length || 0}`,
        `Created: ${selectedRun.createdAt}`
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    const rows = [
        [
            Markup.button.callback('↩️ Refund This Run', 'tokens:runs:refund'),
            Markup.button.callback('🪙 New Run', 'tokens:newrun')
        ]
    ];

    if (retryableWalletCount > 0) {
        rows.push([
            Markup.button.callback(`🔁 Retry Failed (${retryableWalletCount})`, 'tokens:runs:retry')
        ]);
    }

    rows.push(
        [
            Markup.button.callback('⬅️ Back', 'tokens:runs:back')
        ],
        [
            Markup.button.callback('🏠 Main Menu', 'menu:main')
        ]
    );

    await renderPanel(ctx, lines.join('\n'), rows);
}

async function startRefundFlow(ctx) {
    resetSession(ctx);
    ctx.session.flow = 'refund';
    ctx.session.view = 'mints';
    ctx.session.refundState = createRefundState();
    ctx.session.refundState.mints = await listMintSummaries();

    if (!ctx.session.refundState.mints.length) {
        await renderPanel(ctx, [
            formatBanner('Refund Select Mint'),
            '',
            'No saved mints found.'
        ].join('\n'), [
            [Markup.button.callback('🏠 Main Menu', 'menu:main')]
        ]);
        return;
    }

    await renderRefundMintPicker(ctx);
}

async function renderRefundMintPicker(ctx) {
    const state = ctx.session.refundState;
    await ensureMintSummariesPageMetadata(state.mints, state.mintPage);
    const { rows, page, totalPages } = buildMintListButtons(
        state.mints,
        state.mintPage,
        'refund:mint',
        'refund:mints:page',
        'menu:main'
    );

    state.mintPage = page;

    const lines = [
        formatBanner('Refund Select Mint'),
        '',
        `Page ${page + 1} of ${totalPages}`,
        'Choose the mint you want to refund.'
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    await renderPanel(ctx, lines.join('\n'), rows);
}

async function renderRefundRunPicker(ctx) {
    const state = ctx.session.refundState;
    const selectedMint = state.mints[state.selectedMintIndex];
    const { rows, page, totalPages } = buildRunListButtons(
        state.runs,
        state.runPage,
        'refund:run',
        'refund:runs:page',
        'refund:back:mints'
    );

    state.runPage = page;
    const lines = [
        formatBanner('Refund Select Run'),
        '',
        `Mint: ${selectedMint.mintAddress}`,
        `Page ${page + 1} of ${totalPages}`,
        'Choose the saved run to refund.'
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    await renderPanel(ctx, lines.join('\n'), rows);
}

async function renderRefundConfirm(ctx) {
    const state = ctx.session.refundState;
    const selectedMint = state.mints[state.selectedMintIndex];
    const selectedRun = state.runs[state.selectedRunIndex];

    const lines = [
        formatBanner('Refund Confirmation'),
        '',
        `Mint: ${selectedMint.mintAddress}`,
        `Run: ${selectedRun.runId}`,
        `Status: ${selectedRun.status}`,
        `Total Amount: ${selectedRun.totalAmount}`,
        `Wallets: ${selectedRun.walletCount}`,
        `Created: ${selectedRun.createdAt}`,
        '',
        'Start refund for this saved run?'
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    await renderPanel(ctx, lines.join('\n'), [
        [
            Markup.button.callback('↩️ Start Refund', 'refund:start'),
            Markup.button.callback('⬅️ Back', 'refund:back:runs')
        ],
        [
            Markup.button.callback('🏠 Main Menu', 'menu:main')
        ]
    ]);
}

async function startBrowseMintsFlow(ctx) {
    resetSession(ctx);
    ctx.session.flow = 'browse';
    ctx.session.view = 'mints';
    ctx.session.browseState = createBrowseState('mints');
    ctx.session.browseState.mints = await listMintSummaries();

    if (!ctx.session.browseState.mints.length) {
        await renderPanel(ctx, [
            formatBanner('Saved Mints'),
            '',
            'No saved mints found.'
        ].join('\n'), [
            [Markup.button.callback('🏠 Main Menu', 'menu:main')]
        ]);
        return;
    }

    await renderBrowseMintPicker(ctx);
}

async function renderBrowseMintPicker(ctx) {
    const state = ctx.session.browseState;
    await ensureMintSummariesPageMetadata(state.mints, state.mintPage);
    const selectionPrefix = state.mode === 'runs' ? 'browse:runs:mint' : 'browse:mints:mint';
    const pagePrefix = state.mode === 'runs' ? 'browse:runs:mints:page' : 'browse:mints:page';
    const { rows, page, totalPages } = buildMintListButtons(
        state.mints,
        state.mintPage,
        selectionPrefix,
        pagePrefix,
        'menu:main'
    );

    state.mintPage = page;

    const lines = [
        formatBanner(state.mode === 'runs' ? 'Runs Select Mint' : 'Saved Mints'),
        '',
        `Page ${page + 1} of ${totalPages}`,
        state.mode === 'runs'
            ? 'Choose a mint to see its saved runs.'
            : 'Choose a mint to inspect its latest saved data.'
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    await renderPanel(ctx, lines.join('\n'), rows);
}

async function renderBrowseMintDetail(ctx) {
    const state = ctx.session.browseState;
    const selectedMint = state.mints[state.selectedMintIndex];
    await ensureMintSummaryMetadata(selectedMint);
    const tokenDisplay = getTokenDisplay(selectedMint);
    const lines = [
        formatBanner('Mint Details'),
        '',
        ...(tokenDisplay ? [`Token: ${tokenDisplay}`] : []),
        `Mint Address: ${selectedMint.mintAddress}`,
        `Runs: ${selectedMint.runCount}`,
        `Latest Run: ${selectedMint.latestRunId}`,
        `Latest Status: ${selectedMint.latestStatus}`,
        `Latest Date: ${selectedMint.latestRunAt}`
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    await renderPanel(ctx, lines.join('\n'), [
        [
            Markup.button.callback('🧾 View Runs', 'browse:mints:viewruns'),
            Markup.button.callback('🪙 New Run', 'browse:mints:newrun')
        ],
        [
            Markup.button.callback('⬅️ Back', 'browse:mints:back')
        ],
        [
            Markup.button.callback('🏠 Main Menu', 'menu:main')
        ]
    ]);
}

async function renderBrowseRunPicker(ctx) {
    const state = ctx.session.browseState;
    const selectedMint = state.mints[state.selectedMintIndex];
    await ensureMintSummaryMetadata(selectedMint);
    const { rows, page, totalPages } = buildRunListButtons(
        state.runs,
        state.runPage,
        'browse:runs:run',
        'browse:runs:page',
        'browse:runs:back:mints'
    );

    state.runPage = page;
    const lines = [
        formatBanner('Saved Runs'),
        '',
        `Mint: ${getMintPrimaryLabel(selectedMint)}`,
        `Address: ${selectedMint.mintAddress}`,
        `Page ${page + 1} of ${totalPages}`,
        'Choose a run to view details.'
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    rows.splice(rows.length - 1, 0, [
        Markup.button.callback('🪙 New Run', 'browse:runs:newrun')
    ]);

    await renderPanel(ctx, lines.join('\n'), rows);
}

async function renderBrowseRunDetail(ctx) {
    const state = ctx.session.browseState;
    const selectedMint = state.mints[state.selectedMintIndex];
    const selectedRun = state.runs[state.selectedRunIndex];
    const retryableWalletCount = countRetryableWallets(selectedRun);
    await ensureMintSummaryMetadata(selectedMint);
    const lines = [
        formatBanner('Run Details'),
        '',
        `Mint: ${getMintPrimaryLabel(selectedMint)}`,
        `Address: ${selectedMint.mintAddress}`,
        `Run: ${selectedRun.runId}`,
        `Status: ${selectedRun.status}`,
        `Total Amount: ${selectedRun.totalAmount}`,
        `Wallets: ${selectedRun.walletCount}`,
        `Network: ${getNetworkLabel(selectedRun.network)}`,
        `RPC: ${selectedRun.rpcUrl || 'Automatic'}`,
        `Failures: ${selectedRun.failures?.length || 0}`,
        `Created: ${selectedRun.createdAt}`
    ];

    if (ctx.session.error) {
        lines.push('');
        lines.push(`Error: ${ctx.session.error}`);
    }

    const rows = [
        [
            Markup.button.callback('↩️ Refund This Run', 'browse:runs:refund'),
            Markup.button.callback('🪙 New Run', 'browse:runs:newrun')
        ]
    ];

    if (retryableWalletCount > 0) {
        rows.push([
            Markup.button.callback(`🔁 Retry Failed (${retryableWalletCount})`, 'browse:runs:retry')
        ]);
    }

    rows.push(
        [
            Markup.button.callback('⬅️ Back', 'browse:runs:back:runs')
        ],
        [
            Markup.button.callback('🏠 Main Menu', 'menu:main')
        ]
    );

    await renderPanel(ctx, lines.join('\n'), rows);
}

async function startBrowseRunsFlow(ctx, mintAddress) {
    resetSession(ctx);
    ctx.session.flow = 'browse';
    ctx.session.view = 'runs';
    ctx.session.browseState = createBrowseState('runs');
    ctx.session.browseState.mints = await listMintSummaries();

    if (!ctx.session.browseState.mints.length) {
        await renderPanel(ctx, [
            formatBanner('Runs Select Mint'),
            '',
            'No saved mints found.'
        ].join('\n'), [
            [Markup.button.callback('🏠 Main Menu', 'menu:main')]
        ]);
        return;
    }

    if (mintAddress) {
        const selectedMintIndex = ctx.session.browseState.mints.findIndex(item => item.mintAddress === mintAddress);
        if (selectedMintIndex >= 0) {
            ctx.session.browseState.selectedMintIndex = selectedMintIndex;
            ctx.session.browseState.runs = await listRuns(mintAddress);
            ctx.session.view = 'runList';
            await ensureMintSummaryMetadata(ctx.session.browseState.mints[selectedMintIndex]);
            await renderBrowseRunPicker(ctx);
            return;
        }
    }

    await renderBrowseMintPicker(ctx);
}

async function startNewRunForMint(ctx, mintSummary) {
    await ensureMintSummaryMetadata(mintSummary);
    const latestRun = await loadRun(mintSummary.mintAddress, mintSummary.latestRunId);
    const inheritedNetwork = normalizeBotNetwork(latestRun.network);

    await startMintFlow(ctx, {
        draftOverrides: {
            mintAddress: mintSummary.mintAddress,
            totalAmount: '',
            walletCount: '',
            network: inheritedNetwork,
            rpcOverride: latestRun.rpcUrl || getDefaultRpcForNetwork(inheritedNetwork),
            tokenName: mintSummary.tokenName || latestRun.tokenName || '',
            tokenSymbol: mintSummary.tokenSymbol || latestRun.tokenSymbol || ''
        },
        editField: 'totalAmount',
        promptQueue: ['walletCount']
    });
}

async function beginMintExecution(ctx) {
    const draft = ctx.session.mintDraft;
    const invalidFields = getMintDraftErrors(draft);

    if (invalidFields.length) {
        setError(ctx, `Fix these fields before minting: ${invalidFields.join(', ')}`);
        await renderMintCard(ctx);
        return;
    }

    clearError(ctx);
    ctx.session.busy = true;
    await renderPanel(ctx, [
        formatBanner('Mint Starting'),
        '',
        `Mint: ${draft.mintAddress}`,
        `Total Amount: ${draft.totalAmount}`,
        `Wallet Count: ${draft.walletCount}`,
        `Network: ${getNetworkLabel(draft.network)}`,
        `RPC Override: ${formatRpcOverride(draft.rpcOverride, draft.network)}`,
        '',
        'Progress is shown below in a single live message.'
    ].join('\n'), []);

    await updateOperationProgress(ctx, {
        kind: 'mint',
        phase: 'starting',
        current: 0,
        total: Number(draft.walletCount),
        details: [
            `Mint: ${formatMintAddress(draft.mintAddress)}`,
            `Network: ${getNetworkLabel(draft.network)}`
        ]
    });

    const progressReporter = createProgressReporter(
        progress => updateOperationProgress(ctx, {
            kind: 'mint',
            phase: 'running',
            current: progress.current,
            total: progress.total,
            latestWallet: progress.wallet,
            details: [
                `Mint: ${formatMintAddress(draft.mintAddress)}`,
                `Network: ${getNetworkLabel(draft.network)}`
            ]
        }),
        Number(draft.walletCount),
        25
    );

    try {
        const runRecord = await executeMintRun({
            mintAddress: draft.mintAddress,
            totalAmount: draft.totalAmount,
            walletCount: draft.walletCount,
            tokenName: draft.tokenName,
            tokenSymbol: draft.tokenSymbol,
            connectionOptions: {
                cluster: draft.network,
                rpcUrl: draft.rpcOverride || undefined
            },
            onProgress: progressReporter
        });

        ctx.session.busy = false;
        await updateOperationProgress(ctx, {
            kind: 'mint',
            phase: 'completed',
            current: runRecord.walletCount,
            total: runRecord.walletCount,
            latestWallet: runRecord.wallets[runRecord.wallets.length - 1] || null,
            details: [
                `Mint: ${runRecord.mintAddress}`,
                `Run: ${runRecord.runId}`
            ],
            summary: `Result: ${runRecord.status} | Failures: ${runRecord.failures.length}`
        });
        await renderMainMenu(ctx, 'Mint completed. Back at the main menu.');
    } catch (error) {
        ctx.session.busy = false;
        await updateOperationProgress(ctx, {
            kind: 'mint',
            phase: 'failed',
            current: 0,
            total: Number(draft.walletCount),
            details: [
                `Mint: ${formatMintAddress(draft.mintAddress)}`,
                `Network: ${getNetworkLabel(draft.network)}`
            ],
            summary: 'Result: failed',
            error: error.message
        });
        await renderMainMenu(ctx, 'Mint failed. Back at the main menu.');
    }
}

async function beginRefundExecution(ctx) {
    const state = ctx.session.refundState;
    const selectedMint = state.mints[state.selectedMintIndex];
    const selectedRun = state.runs[state.selectedRunIndex];
    ctx.session.busy = true;

    await renderPanel(ctx, [
        formatBanner('Refund Starting'),
        '',
        `Mint: ${selectedMint.mintAddress}`,
        `Run: ${selectedRun.runId}`,
        `Wallets: ${selectedRun.walletCount}`,
        '',
        'Progress is shown below in a single live message.'
    ].join('\n'), []);

    await updateOperationProgress(ctx, {
        kind: 'refund',
        phase: 'starting',
        current: 0,
        total: selectedRun.walletCount,
        details: [
            `Mint: ${selectedMint.mintAddress}`,
            `Run: ${selectedRun.runId}`
        ]
    });

    const progressReporter = createProgressReporter(
        progress => updateOperationProgress(ctx, {
            kind: 'refund',
            phase: 'running',
            current: progress.current,
            total: progress.total,
            latestWallet: progress.wallet,
            details: [
                `Mint: ${selectedMint.mintAddress}`,
                `Run: ${selectedRun.runId}`
            ]
        }),
        selectedRun.walletCount,
        25
    );

    try {
        const runRecord = await executeRefundRun({
            mintAddress: selectedMint.mintAddress,
            runId: selectedRun.runId,
            onProgress: progressReporter
        });

        ctx.session.busy = false;
        await updateOperationProgress(ctx, {
            kind: 'refund',
            phase: 'completed',
            current: runRecord.walletCount,
            total: runRecord.walletCount,
            latestWallet: runRecord.wallets[runRecord.wallets.length - 1] || null,
            details: [
                `Mint: ${runRecord.mintAddress}`,
                `Run: ${runRecord.runId}`
            ],
            summary: `Result: ${runRecord.status} | Failures: ${runRecord.failures.length}`
        });
        await renderMainMenu(ctx, 'Refund completed. Back at the main menu.');
    } catch (error) {
        ctx.session.busy = false;
        await updateOperationProgress(ctx, {
            kind: 'refund',
            phase: 'failed',
            current: 0,
            total: selectedRun.walletCount,
            details: [
                `Mint: ${selectedMint.mintAddress}`,
                `Run: ${selectedRun.runId}`
            ],
            summary: 'Result: failed',
            error: error.message
        });
        await renderMainMenu(ctx, 'Refund failed. Back at the main menu.');
    }
}

async function beginMintRetryExecution(ctx) {
    const state = ctx.session.browseState;
    const selectedMint = state.mints[state.selectedMintIndex];
    const selectedRun = state.runs[state.selectedRunIndex];
    const retryWallets = Array.isArray(selectedRun.wallets)
        ? selectedRun.wallets.filter(wallet => RETRYABLE_MINT_STATUSES.has(wallet.status))
        : [];
    const retryableWalletCount = countRetryableWallets(selectedRun);

    if (!retryableWalletCount) {
        setError(ctx, 'This run has no failed wallets left to retry.');
        await renderBrowseRunDetail(ctx);
        return;
    }

    clearError(ctx);
    ctx.session.busy = true;
    await renderPanel(ctx, [
        formatBanner('Retry Starting'),
        '',
        `Mint: ${selectedMint.mintAddress}`,
        `Run: ${selectedRun.runId}`,
        `Wallets to Retry: ${retryableWalletCount}`,
        `Network: ${getNetworkLabel(selectedRun.network)}`,
        '',
        'Progress is shown below in a single live message.'
    ].join('\n'), []);

    await updateOperationProgress(ctx, {
        kind: 'mint',
        phase: 'starting',
        current: 0,
        total: retryableWalletCount,
        details: [
            `Mint: ${selectedMint.mintAddress}`,
            `Run: ${selectedRun.runId}`
        ]
    });

    const progressReporter = createProgressReporter(
        progress => updateOperationProgress(ctx, {
            kind: 'mint',
            phase: 'running',
            current: progress.current,
            total: progress.total,
            latestWallet: progress.wallet,
            details: [
                `Mint: ${selectedMint.mintAddress}`,
                `Run: ${selectedRun.runId}`
            ]
        }),
        retryableWalletCount,
        25
    );

    try {
        const runRecord = await retryMintFailures({
            mintAddress: selectedMint.mintAddress,
            runId: selectedRun.runId,
            connectionOptions: {
                cluster: selectedRun.network,
                rpcUrl: selectedRun.rpcUrl || undefined
            },
            onProgress: progressReporter
        });
        const remainingRetryableCount = countRetryableWallets(runRecord);

        state.runs[state.selectedRunIndex] = runRecord;
        ctx.session.busy = false;
        await updateOperationProgress(ctx, {
            kind: 'mint',
            phase: 'completed',
            current: retryableWalletCount,
            total: retryableWalletCount,
            latestWallet: runRecord.wallets.find(wallet => wallet.publicKey === retryWallets.slice(-1)[0]?.publicKey) || null,
            details: [
                `Mint: ${runRecord.mintAddress}`,
                `Run: ${runRecord.runId}`
            ],
            summary: `Result: ${runRecord.status} | Remaining Failed: ${remainingRetryableCount}`
        });
        await renderMainMenu(ctx, 'Retry completed. Back at the main menu.');
    } catch (error) {
        ctx.session.busy = false;
        await updateOperationProgress(ctx, {
            kind: 'mint',
            phase: 'failed',
            current: 0,
            total: retryableWalletCount,
            details: [
                `Mint: ${selectedMint.mintAddress}`,
                `Run: ${selectedRun.runId}`
            ],
            summary: 'Result: failed',
            error: error.message
        });
        await renderMainMenu(ctx, 'Retry failed. Back at the main menu.');
    }
}

async function startNewRunForCreatedToken(ctx, tokenRecord) {
    const inheritedNetwork = normalizeBotNetwork(tokenRecord.network);

    await startMintFlow(ctx, {
        draftOverrides: {
            mintAddress: tokenRecord.mintAddress,
            totalAmount: '',
            walletCount: '',
            network: inheritedNetwork,
            rpcOverride: tokenRecord.rpcUrl || getDefaultRpcForNetwork(inheritedNetwork),
            tokenName: tokenRecord.tokenName || '',
            tokenSymbol: tokenRecord.tokenSymbol || ''
        },
        editField: 'totalAmount',
        promptQueue: ['walletCount']
    });
}

async function beginTokenCreateExecution(ctx) {
    const draft = ctx.session.tokenDraft;
    const draftSnapshot = draft ? { ...draft } : createTokenDraft();
    const invalidFields = getTokenDraftErrors(draft);

    if (invalidFields.length) {
        setError(ctx, `Fix these fields before creating the token: ${invalidFields.join(', ')}`);
        await renderTokenCard(ctx);
        return;
    }

    clearError(ctx);
    ctx.session.busy = true;
    await renderPanel(ctx, [
        formatBanner('Token Creation Starting'),
        '',
        `Name: ${draft.tokenName}`,
        `Symbol: ${draft.tokenSymbol}`,
        `Decimals: ${draft.decimals}`,
        `Initial Mint Amount: ${draft.initialMintAmount}`,
        `Token Icon: ${draft.imageUri ? 'Uploaded' : 'Not set'}`,
        `Network: ${getNetworkLabel(draft.network)}`,
        `RPC Override: ${formatRpcOverride(draft.rpcOverride, draft.network)}`,
        '',
        'Creating token and minting the initial amount into the bot wallet now.'
    ].join('\n'), []);

    try {
        let metadataUri = '';
        if (draft.imageUri) {
            const metadataUpload = await uploadTokenMetadataToPinata({
                tokenName: draft.tokenName,
                tokenSymbol: draft.tokenSymbol,
                imageUri: draft.imageUri
            });
            metadataUri = metadataUpload.metadataUri;
        }

        const tokenRecord = await executeTokenCreate({
            tokenName: draft.tokenName,
            tokenSymbol: draft.tokenSymbol,
            metadataUri,
            imageUri: draft.imageUri,
            decimals: draft.decimals,
            initialMintAmount: draft.initialMintAmount,
            connectionOptions: {
                cluster: draft.network,
                rpcUrl: draft.rpcOverride || undefined
            }
        });

        ctx.session.busy = false;
        await startCreatedTokensFlow(ctx, {
            selectedMintAddress: tokenRecord.mintAddress,
            introText: `Token created successfully. Minted ${tokenRecord.initialMintAmount} into the bot wallet.`
        });
    } catch (error) {
        ctx.session.busy = false;
        if (!ctx.session.tokenDraft) {
            ctx.session.tokenDraft = draftSnapshot;
        }
        setError(ctx, error.message);
        await renderTokenCard(ctx);
    }
}

async function beginAdditionalMintExecution(ctx) {
    const state = ctx.session.createdTokenState;
    const selectedToken = state.tokens[state.selectedTokenIndex];
    const amount = String(state.additionalMintAmount || '').trim();

    try {
        parseTokenAmountToRaw(amount, selectedToken.decimals);
    } catch (error) {
        setError(ctx, 'Enter a valid amount before minting more tokens.');
        await renderAdditionalMintCard(ctx);
        return;
    }

    clearError(ctx);
    ctx.session.busy = true;
    await renderPanel(ctx, [
        formatBanner('Additional Mint Starting'),
        '',
        `Token: ${getMintPrimaryLabel(selectedToken)}`,
        `Mint Address: ${selectedToken.mintAddress}`,
        `Amount: ${amount}`,
        '',
        'Minting additional tokens into the bot wallet now.'
    ].join('\n'), []);

    try {
        const updatedToken = await executeAdditionalMint({
            mintAddress: selectedToken.mintAddress,
            amount,
            connectionOptions: {
                cluster: selectedToken.network,
                rpcUrl: selectedToken.rpcUrl || undefined
            }
        });

        state.tokens[state.selectedTokenIndex] = updatedToken;
        state.additionalMintAmount = '';
        ctx.session.busy = false;
        ctx.session.editField = null;
        await renderCreatedTokenDetail(ctx, `Additional mint completed. Minted ${amount} into the bot wallet.`);
    } catch (error) {
        ctx.session.busy = false;
        setError(ctx, error.message);
        await renderAdditionalMintCard(ctx);
    }
}

async function beginAuthorityRevokeExecution(ctx, authorityKind) {
    const state = ctx.session.createdTokenState;
    const selectedToken = state.tokens[state.selectedTokenIndex];
    const authorityLabel = authorityKind === 'freeze' ? 'Freeze' : 'Mint';

    clearError(ctx);
    ctx.session.busy = true;
    await renderPanel(ctx, [
        formatBanner(`${authorityLabel} Authority Revoke Starting`),
        '',
        `Token: ${getMintPrimaryLabel(selectedToken)}`,
        `Mint Address: ${selectedToken.mintAddress}`,
        `Network: ${getNetworkLabel(selectedToken.network)}`,
        '',
        `Revoking ${authorityLabel.toLowerCase()} authority on-chain now.`
    ].join('\n'), []);

    try {
        const result = await executeRevokeAuthority({
            mintAddress: selectedToken.mintAddress,
            authorityKind,
            connectionOptions: {
                cluster: selectedToken.network,
                rpcUrl: selectedToken.rpcUrl || undefined
            }
        });

        ctx.session.busy = false;
        await renderCreatedTokenDetail(
            ctx,
            `${authorityLabel} authority revoked. Signature: ${result.signature}`
        );
    } catch (error) {
        ctx.session.busy = false;
        setError(ctx, error.message);
        await renderCreatedTokenDetail(ctx);
    }
}

async function beginCreatedTokenMintRetryExecution(ctx) {
    const state = ctx.session.createdTokenState;
    const selectedToken = state.tokens[state.selectedTokenIndex];
    const selectedRun = state.runs[state.selectedRunIndex];
    const retryWallets = Array.isArray(selectedRun.wallets)
        ? selectedRun.wallets.filter(wallet => RETRYABLE_MINT_STATUSES.has(wallet.status))
        : [];
    const retryableWalletCount = countRetryableWallets(selectedRun);

    if (!retryableWalletCount) {
        setError(ctx, 'This run has no failed wallets left to retry.');
        await renderCreatedTokenRunDetail(ctx);
        return;
    }

    clearError(ctx);
    ctx.session.busy = true;
    await renderPanel(ctx, [
        formatBanner('Retry Starting'),
        '',
        `Mint: ${selectedToken.mintAddress}`,
        `Run: ${selectedRun.runId}`,
        `Wallets to Retry: ${retryableWalletCount}`,
        `Network: ${getNetworkLabel(selectedRun.network)}`,
        '',
        'Progress is shown below in a single live message.'
    ].join('\n'), []);

    await updateOperationProgress(ctx, {
        kind: 'mint',
        phase: 'starting',
        current: 0,
        total: retryableWalletCount,
        details: [
            `Mint: ${selectedToken.mintAddress}`,
            `Run: ${selectedRun.runId}`
        ]
    });

    const progressReporter = createProgressReporter(
        progress => updateOperationProgress(ctx, {
            kind: 'mint',
            phase: 'running',
            current: progress.current,
            total: progress.total,
            latestWallet: progress.wallet,
            details: [
                `Mint: ${selectedToken.mintAddress}`,
                `Run: ${selectedRun.runId}`
            ]
        }),
        retryableWalletCount,
        25
    );

    try {
        const runRecord = await retryMintFailures({
            mintAddress: selectedToken.mintAddress,
            runId: selectedRun.runId,
            connectionOptions: {
                cluster: selectedRun.network,
                rpcUrl: selectedRun.rpcUrl || undefined
            },
            onProgress: progressReporter
        });
        const remainingRetryableCount = countRetryableWallets(runRecord);

        state.runs[state.selectedRunIndex] = runRecord;
        ctx.session.busy = false;
        await updateOperationProgress(ctx, {
            kind: 'mint',
            phase: 'completed',
            current: retryableWalletCount,
            total: retryableWalletCount,
            latestWallet: runRecord.wallets.find(wallet => wallet.publicKey === retryWallets.slice(-1)[0]?.publicKey) || null,
            details: [
                `Mint: ${runRecord.mintAddress}`,
                `Run: ${runRecord.runId}`
            ],
            summary: `Result: ${runRecord.status} | Remaining Failed: ${remainingRetryableCount}`
        });
        await renderMainMenu(ctx, 'Retry completed. Back at the main menu.');
    } catch (error) {
        ctx.session.busy = false;
        await updateOperationProgress(ctx, {
            kind: 'mint',
            phase: 'failed',
            current: 0,
            total: retryableWalletCount,
            details: [
                `Mint: ${selectedToken.mintAddress}`,
                `Run: ${selectedRun.runId}`
            ],
            summary: 'Result: failed',
            error: error.message
        });
        await renderMainMenu(ctx, 'Retry failed. Back at the main menu.');
    }
}

async function handleMintTextInput(ctx, text) {
    if (!ctx.session.editField) {
        await ctx.reply('Use the buttons on the mint card to choose what to edit.');
        return;
    }

    try {
        const nextValue = validateDraftField(ctx.session.editField, text);
        ctx.session.mintDraft[ctx.session.editField] = nextValue;
        clearError(ctx);
        if (ctx.session.mintPromptQueue.length) {
            ctx.session.editField = ctx.session.mintPromptQueue.shift();
        } else {
            ctx.session.editField = null;
        }
        await renderMintCard(ctx);
    } catch (error) {
        setError(ctx, error.message);
        await renderMintCard(ctx);
    }
}

async function handleTokenTextInput(ctx, text) {
    if (!ctx.session.editField) {
        await ctx.reply('Use the buttons on the token card to choose what to edit.');
        return;
    }

    try {
        const nextValue = validateTokenDraftField(ctx.session.editField, text);
        ctx.session.tokenDraft[ctx.session.editField] = nextValue;
        clearError(ctx);
        ctx.session.editField = null;
        await renderTokenCard(ctx);
    } catch (error) {
        setError(ctx, error.message);
        await renderTokenCard(ctx);
    }
}

async function handleTokenPhotoInput(ctx) {
    if (ctx.session.flow !== 'tokenCreate' || ctx.session.editField !== 'tokenImage') {
        await ctx.reply('Use the token icon tile first, then send a photo.');
        return;
    }

    if (!config.pinataJwt) {
        setError(ctx, 'PINATA_JWT is not configured, so token images cannot be uploaded.');
        ctx.session.editField = null;
        await renderTokenCard(ctx);
        return;
    }

    const largestPhoto = [...(ctx.message.photo || [])].sort((left, right) => (right.file_size || 0) - (left.file_size || 0))[0];
    if (!largestPhoto) {
        setError(ctx, 'No photo was found in that message.');
        await renderTokenCard(ctx);
        return;
    }

    clearError(ctx);
    ctx.session.busy = true;
    await renderPanel(ctx, [
        formatBanner('Uploading Token Icon'),
        '',
        'Uploading the token icon to Pinata now.'
    ].join('\n'), []);

    try {
        const fileLink = await ctx.telegram.getFileLink(largestPhoto.file_id);
        const response = await fetch(fileLink.href);
        if (!response.ok) {
            throw new Error(`Telegram file download failed with status ${response.status}.`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const upload = await uploadTokenImageToPinata({
            buffer: Buffer.from(arrayBuffer),
            fileName: `${(ctx.session.tokenDraft.tokenSymbol || 'token').toLowerCase()}-icon-${Date.now()}.jpg`,
            contentType: response.headers.get('content-type') || 'image/jpeg'
        });

        ctx.session.tokenDraft.imageUri = upload.imageUri;
        ctx.session.tokenDraft.imageFileName = upload.fileName;
        ctx.session.editField = null;
        ctx.session.busy = false;
        await renderTokenCard(ctx);
    } catch (error) {
        ctx.session.busy = false;
        setError(ctx, error.message);
        await renderTokenCard(ctx);
    }
}

async function handleAdditionalMintTextInput(ctx, text) {
    const state = ctx.session.createdTokenState;
    const selectedToken = state.tokens[state.selectedTokenIndex];

    if (ctx.session.editField !== 'additionalMintAmount') {
        await ctx.reply('Use the amount button to choose what to edit.');
        return;
    }

    try {
        parseTokenAmountToRaw(text, selectedToken.decimals);
        state.additionalMintAmount = String(text).trim();
        ctx.session.editField = null;
        clearError(ctx);
        await renderAdditionalMintCard(ctx);
    } catch (error) {
        setError(ctx, error.message);
        await renderAdditionalMintCard(ctx);
    }
}

async function handlePoolTextInput(ctx, text) {
    const poolState = ctx.session.poolState;

    if (!poolState?.draft || !ctx.session.editField) {
        await ctx.reply('Use the pool tiles to choose what to edit.');
        return;
    }

    try {
        const nextValue = validatePoolDraftField(ctx.session.editField, text);
        poolState.draft[ctx.session.editField] = nextValue;
        ctx.session.editField = null;
        clearError(ctx);
        await renderPoolCard(ctx);
    } catch (error) {
        setError(ctx, error.message);
        await renderPoolCard(ctx);
    }
}

async function beginPoolCreateExecution(ctx) {
    const draft = ctx.session.poolState?.draft || createPoolDraft();
    const invalidFields = getPoolDraftErrors(draft);

    if (invalidFields.length) {
        setError(ctx, `Fix these fields before creating the pool: ${invalidFields.join(', ')}`);
        await renderPoolCard(ctx);
        return;
    }

    clearError(ctx);
    ctx.session.busy = true;
    await renderPanel(ctx, [
        formatBanner('DAMM Pool Starting'),
        '',
        `🌐 Network: ${getNetworkLabel(draft.network)}`,
        `🪙 Token: ${getTokenDisplay(draft) || draft.tokenMintAddress}`,
        `◎ SOL Amount: ${draft.solAmount}`,
        `🪙 Token Amount: ${draft.tokenAmount}`,
        '',
        'Creating the DAMM v2 pool and initial LP position on-chain now.'
    ].join('\n'), []);

    try {
        const poolRecord = await createDammPool({
            network: draft.network,
            tokenMintAddress: draft.tokenMintAddress,
            solAmount: draft.solAmount,
            tokenAmount: draft.tokenAmount
        });

        ctx.session.busy = false;
        resetSession(ctx, { preservePanel: true });
        await renderPanel(ctx, [
            formatBanner('DAMM Pool Created'),
            '',
            `🌐 Network: ${getNetworkLabel(poolRecord.network)}`,
            `🪙 Token: ${getTokenDisplay(poolRecord) || poolRecord.baseMint}`,
            `🏊 Pool Address: ${poolRecord.poolAddress}`,
            `🧾 Token Mint: ${poolRecord.baseMint}`,
            `◎ SOL Amount: ${poolRecord.solAmount}`,
            `🪙 Token Amount: ${poolRecord.tokenAmount}`,
            `⚙️ Config: ${poolRecord.configAddress}`,
            `🧮 Fee Mode: ${poolRecord.collectFeeModeLabel || poolRecord.collectFeeMode}`,
            `✍️ Create Signature: ${poolRecord.createSignature}`,
            `📍 Position: ${poolRecord.positionAddress}`
        ].join('\n'), [
            [Markup.button.callback('🏠 Main Menu', 'menu:main')]
        ]);
    } catch (error) {
        ctx.session.busy = false;
        setError(ctx, error.message);
        await renderPoolCard(ctx);
    }
}

async function handleMenuAction(ctx, action) {
    if (action === 'main') {
        await renderMainMenu(ctx);
        return;
    }

    if (action === 'create') {
        await startTokenCreateFlow(ctx);
        return;
    }

    if (action === 'mint') {
        await startMintFlow(ctx);
        return;
    }

    if (action === 'refund') {
        await startRefundFlow(ctx);
        return;
    }

    if (action === 'mints') {
        await startBrowseMintsFlow(ctx);
        return;
    }

    if (action === 'tokens') {
        await startCreatedTokensFlow(ctx);
        return;
    }

    if (action === 'wallet') {
        await renderWalletView(ctx);
        return;
    }

    if (action === 'pool') {
        await startPoolFlow(ctx);
        return;
    }

    if (action === 'runs') {
        await startBrowseRunsFlow(ctx);
        return;
    }
}

function logUserAction(ctx, action) {
    const username =
        ctx.from?.username ||
        [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') ||
        'Unknown';

    const telegramId = ctx.from?.id || 'Unknown';

    console.log(`${username} [${telegramId}]: ${action}`);
}

async function handleCallback(ctx) {
    const data = ctx.callbackQuery.data;

    logUserAction(ctx, `pressed ${data}`);

    if (ctx.session.busy) {
        await answerCallback(ctx, 'An operation is already running.');
        return;
    }

    if (data.startsWith('menu:')) {
        await answerCallback(ctx);
        await handleMenuAction(ctx, data.split(':')[1]);
        return;
    }

    if (data === 'wallet:address') {
        await answerCallback(ctx, 'Address sent.');
        await ctx.reply(getAuthorityPublicKey().toBase58());
        await renderWalletView(ctx);
        return;
    }

    if (data === 'wallet:qr') {
        await answerCallback(ctx, 'QR code sent.');
        await ctx.replyWithPhoto(
            { source: await createAuthorityFundingQrPng() },
            { caption: getAuthorityPublicKey().toBase58() }
        );
        await renderWalletView(ctx);
        return;
    }

    if (data.startsWith('pool:network:')) {
        await answerCallback(ctx, 'Loading wallet tokens.');
        ctx.session.flow = 'pool';
        ctx.session.view = 'tokens';
        ctx.session.editField = null;
        ctx.session.poolState = createPoolState();
        ctx.session.poolState.network = normalizeBotNetwork(data.split(':')[2]);

        try {
            ctx.session.poolState.tokens = await listHeldTokens({
                network: ctx.session.poolState.network
            });
        } catch (error) {
            setError(ctx, error.message);
            await renderPoolNetworkPicker(ctx);
            return;
        }

        if (!ctx.session.poolState.tokens.length) {
            setError(ctx, 'No positive token balances were found in the bot wallet on that network.');
            await renderPoolNetworkPicker(ctx);
            return;
        }

        clearError(ctx);
        await renderPoolTokenPicker(ctx);
        return;
    }

    if (data === 'pool:back:network') {
        await answerCallback(ctx);
        clearError(ctx);
        await renderPoolNetworkPicker(ctx);
        return;
    }

    if (data.startsWith('pool:tokens:page:')) {
        await answerCallback(ctx);
        ctx.session.poolState.tokenPage = Number.parseInt(data.split(':')[3], 10) || 0;
        clearError(ctx);
        await renderPoolTokenPicker(ctx);
        return;
    }

    if (data.startsWith('pool:token:')) {
        await answerCallback(ctx);
        const index = Number.parseInt(data.split(':')[2], 10);
        const state = ctx.session.poolState;

        if (!Number.isInteger(index) || !state.tokens[index]) {
            setError(ctx, 'Selected token is no longer available.');
            await renderPoolTokenPicker(ctx);
            return;
        }

        const selectedToken = state.tokens[index];
        const balances = await fetchAuthoritySolBalances().catch(() => null);
        state.selectedTokenIndex = index;
        state.draft = createPoolDraft({
            network: state.network,
            tokenMintAddress: selectedToken.mintAddress,
            tokenName: selectedToken.tokenName || '',
            tokenSymbol: selectedToken.tokenSymbol || '',
            tokenDecimals: selectedToken.decimals,
            tokenProgramId: selectedToken.programId,
            tokenBalance: selectedToken.balance,
            solBalance: balances?.[state.network]?.balance || 'Unavailable'
        });
        clearError(ctx);
        await renderPoolCard(ctx);
        return;
    }

    if (data === 'pool:back:tokens') {
        await answerCallback(ctx);
        ctx.session.editField = null;
        clearError(ctx);
        await renderPoolTokenPicker(ctx);
        return;
    }

    if (data.startsWith('pool:edit:')) {
        await answerCallback(ctx, 'Send the new value in chat.');
        ctx.session.flow = 'pool';
        ctx.session.editField = data.split(':')[2];
        clearError(ctx);
        await renderPoolCard(ctx);
        return;
    }

    if (data === 'pool:start') {
        await answerCallback(ctx);
        await beginPoolCreateExecution(ctx);
        return;
    }

    if (data.startsWith('mint:edit:')) {
        await answerCallback(ctx, 'Send the new value in chat.');
        ctx.session.flow = 'mint';
        ctx.session.editField = data.split(':')[2];
        ctx.session.mintPromptQueue = [];
        clearError(ctx);
        await renderMintCard(ctx);
        return;
    }

    if (data === 'mint:network') {
        await answerCallback(ctx);
        ctx.session.flow = 'mint';
        ctx.session.editField = null;
        ctx.session.mintPromptQueue = [];
        clearError(ctx);
        await renderNetworkPicker(ctx);
        return;
    }

    if (data.startsWith('mint:setnet:')) {
        await answerCallback(ctx, 'Network updated.');
        ctx.session.mintDraft.network = normalizeBotNetwork(data.split(':')[2]);
        ctx.session.mintDraft.rpcOverride = getDefaultRpcForNetwork(ctx.session.mintDraft.network);
        ctx.session.editField = null;
        ctx.session.mintPromptQueue = [];
        clearError(ctx);
        await renderMintCard(ctx);
        return;
    }

    if (data === 'mint:back') {
        await answerCallback(ctx);
        ctx.session.editField = null;
        ctx.session.mintPromptQueue = [];
        clearError(ctx);
        await renderMintCard(ctx);
        return;
    }

    if (data === 'mint:rpc:default') {
        await answerCallback(ctx, 'RPC reset to the configured default.');
        ctx.session.mintDraft.rpcOverride = getDefaultRpcForNetwork(ctx.session.mintDraft.network);
        ctx.session.editField = null;
        ctx.session.mintPromptQueue = [];
        clearError(ctx);
        await renderMintCard(ctx);
        return;
    }

    if (data === 'mint:start') {
        await answerCallback(ctx);
        await beginMintExecution(ctx);
        return;
    }

    if (data === 'token:edit:metadataUri') {
        await answerCallback(ctx, 'That field is no longer used.');
        ctx.session.flow = 'tokenCreate';
        ctx.session.editField = null;
        clearError(ctx);
        await renderTokenCard(ctx);
        return;
    }

    if (data === 'token:edit:tokenImage') {
        await answerCallback(ctx, 'Send a photo in chat.');
        ctx.session.flow = 'tokenCreate';
        ctx.session.editField = 'tokenImage';
        clearError(ctx);
        await renderTokenCard(ctx);
        return;
    }

    if (data.startsWith('token:edit:')) {
        await answerCallback(ctx, 'Send the new value in chat.');
        ctx.session.flow = 'tokenCreate';
        ctx.session.editField = data.split(':')[2];
        clearError(ctx);
        await renderTokenCard(ctx);
        return;
    }

    if (data === 'token:network') {
        await answerCallback(ctx);
        ctx.session.flow = 'tokenCreate';
        ctx.session.editField = null;
        clearError(ctx);
        await renderTokenNetworkPicker(ctx);
        return;
    }

    if (data.startsWith('token:setnet:')) {
        await answerCallback(ctx, 'Network updated.');
        ctx.session.tokenDraft.network = normalizeBotNetwork(data.split(':')[2]);
        ctx.session.tokenDraft.rpcOverride = getDefaultRpcForNetwork(ctx.session.tokenDraft.network);
        ctx.session.editField = null;
        clearError(ctx);
        await renderTokenCard(ctx);
        return;
    }

    if (data === 'token:back') {
        await answerCallback(ctx);
        ctx.session.editField = null;
        clearError(ctx);
        await renderTokenCard(ctx);
        return;
    }

    if (data === 'token:rpc:default') {
        await answerCallback(ctx, 'RPC reset to the configured default.');
        ctx.session.tokenDraft.rpcOverride = getDefaultRpcForNetwork(ctx.session.tokenDraft.network);
        ctx.session.editField = null;
        clearError(ctx);
        await renderTokenCard(ctx);
        return;
    }

    if (data === 'token:start') {
        await answerCallback(ctx);
        await beginTokenCreateExecution(ctx);
        return;
    }

    if (data.startsWith('refund:mints:page:')) {
        await answerCallback(ctx);
        ctx.session.refundState.mintPage = Number.parseInt(data.split(':')[3], 10) || 0;
        clearError(ctx);
        await renderRefundMintPicker(ctx);
        return;
    }

    if (data.startsWith('refund:mint:')) {
        await answerCallback(ctx);
        const index = Number.parseInt(data.split(':')[2], 10);
        const state = ctx.session.refundState;

        if (!Number.isInteger(index) || !state.mints[index]) {
            setError(ctx, 'Selected mint is no longer available.');
            await renderRefundMintPicker(ctx);
            return;
        }

        state.selectedMintIndex = index;
        state.runs = await listRuns(state.mints[index].mintAddress);
        state.runPage = 0;
        state.selectedRunIndex = null;

        if (!state.runs.length) {
            setError(ctx, 'No saved runs found for that mint.');
            await renderRefundMintPicker(ctx);
            return;
        }

        clearError(ctx);
        await renderRefundRunPicker(ctx);
        return;
    }

    if (data.startsWith('refund:runs:page:')) {
        await answerCallback(ctx);
        ctx.session.refundState.runPage = Number.parseInt(data.split(':')[3], 10) || 0;
        clearError(ctx);
        await renderRefundRunPicker(ctx);
        return;
    }

    if (data.startsWith('refund:run:')) {
        await answerCallback(ctx);
        const index = Number.parseInt(data.split(':')[2], 10);
        const state = ctx.session.refundState;

        if (!Number.isInteger(index) || !state.runs[index]) {
            setError(ctx, 'Selected run is no longer available.');
            await renderRefundRunPicker(ctx);
            return;
        }

        state.selectedRunIndex = index;
        clearError(ctx);
        await renderRefundConfirm(ctx);
        return;
    }

    if (data === 'refund:back:mints') {
        await answerCallback(ctx);
        clearError(ctx);
        await renderRefundMintPicker(ctx);
        return;
    }

    if (data === 'refund:back:runs') {
        await answerCallback(ctx);
        clearError(ctx);
        await renderRefundRunPicker(ctx);
        return;
    }

    if (data === 'refund:start') {
        await answerCallback(ctx);
        await beginRefundExecution(ctx);
        return;
    }

    if (data.startsWith('browse:mints:page:')) {
        await answerCallback(ctx);
        ctx.session.browseState.mintPage = Number.parseInt(data.split(':')[3], 10) || 0;
        clearError(ctx);
        await renderBrowseMintPicker(ctx);
        return;
    }

    if (data.startsWith('browse:mints:mint:')) {
        await answerCallback(ctx);
        const index = Number.parseInt(data.split(':')[3], 10);
        const state = ctx.session.browseState;

        if (!Number.isInteger(index) || !state.mints[index]) {
            setError(ctx, 'Selected mint is no longer available.');
            await renderBrowseMintPicker(ctx);
            return;
        }

        state.selectedMintIndex = index;
        clearError(ctx);
        await renderBrowseMintDetail(ctx);
        return;
    }

    if (data === 'browse:mints:back') {
        await answerCallback(ctx);
        clearError(ctx);
        await renderBrowseMintPicker(ctx);
        return;
    }

    if (data === 'browse:mints:viewruns') {
        await answerCallback(ctx);
        const state = ctx.session.browseState;
        state.mode = 'runs';
        state.runs = await listRuns(state.mints[state.selectedMintIndex].mintAddress);
        state.runPage = 0;
        state.selectedRunIndex = null;
        clearError(ctx);
        await renderBrowseRunPicker(ctx);
        return;
    }

    if (data === 'browse:mints:newrun') {
        await answerCallback(ctx);
        await startNewRunForMint(ctx, ctx.session.browseState.mints[ctx.session.browseState.selectedMintIndex]);
        return;
    }

    if (data.startsWith('browse:runs:mints:page:')) {
        await answerCallback(ctx);
        ctx.session.browseState.mintPage = Number.parseInt(data.split(':')[4], 10) || 0;
        clearError(ctx);
        await renderBrowseMintPicker(ctx);
        return;
    }

    if (data.startsWith('browse:runs:mint:')) {
        await answerCallback(ctx);
        const index = Number.parseInt(data.split(':')[3], 10);
        const state = ctx.session.browseState;

        if (!Number.isInteger(index) || !state.mints[index]) {
            setError(ctx, 'Selected mint is no longer available.');
            await renderBrowseMintPicker(ctx);
            return;
        }

        state.selectedMintIndex = index;
        state.runs = await listRuns(state.mints[index].mintAddress);
        state.runPage = 0;
        state.selectedRunIndex = null;

        if (!state.runs.length) {
            setError(ctx, 'No saved runs found for that mint.');
            await renderBrowseMintPicker(ctx);
            return;
        }

        clearError(ctx);
        await renderBrowseRunPicker(ctx);
        return;
    }

    if (data.startsWith('browse:runs:page:')) {
        await answerCallback(ctx);
        ctx.session.browseState.runPage = Number.parseInt(data.split(':')[3], 10) || 0;
        clearError(ctx);
        await renderBrowseRunPicker(ctx);
        return;
    }

    if (data.startsWith('browse:runs:run:')) {
        await answerCallback(ctx);
        const index = Number.parseInt(data.split(':')[3], 10);
        const state = ctx.session.browseState;

        if (!Number.isInteger(index) || !state.runs[index]) {
            setError(ctx, 'Selected run is no longer available.');
            await renderBrowseRunPicker(ctx);
            return;
        }

        state.selectedRunIndex = index;
        clearError(ctx);
        await renderBrowseRunDetail(ctx);
        return;
    }

    if (data === 'browse:runs:back:mints') {
        await answerCallback(ctx);
        clearError(ctx);
        await renderBrowseMintPicker(ctx);
        return;
    }

    if (data === 'browse:runs:back:runs') {
        await answerCallback(ctx);
        clearError(ctx);
        await renderBrowseRunPicker(ctx);
        return;
    }

    if (data === 'browse:runs:newrun') {
        await answerCallback(ctx);
        await startNewRunForMint(ctx, ctx.session.browseState.mints[ctx.session.browseState.selectedMintIndex]);
        return;
    }

    if (data === 'browse:runs:retry') {
        await answerCallback(ctx);
        await beginMintRetryExecution(ctx);
        return;
    }

    if (data === 'browse:runs:refund') {
        await answerCallback(ctx);
        const browseState = ctx.session.browseState;
        const selectedMintIndex = browseState.selectedMintIndex;
        const selectedRunIndex = browseState.selectedRunIndex;
        const mints = browseState.mints;
        const runs = browseState.runs;

        resetSession(ctx);
        ctx.session.flow = 'refund';
        ctx.session.view = 'confirm';
        ctx.session.refundState = createRefundState();
        ctx.session.refundState.mints = mints;
        ctx.session.refundState.selectedMintIndex = selectedMintIndex;
        ctx.session.refundState.runs = runs;
        ctx.session.refundState.selectedRunIndex = selectedRunIndex;
        await renderRefundConfirm(ctx);
        return;
    }

    if (data.startsWith('tokens:page:')) {
        await answerCallback(ctx);
        ctx.session.createdTokenState.tokenPage = Number.parseInt(data.split(':')[2], 10) || 0;
        clearError(ctx);
        await renderCreatedTokenPicker(ctx);
        return;
    }

    if (data.startsWith('tokens:token:')) {
        await answerCallback(ctx);
        const index = Number.parseInt(data.split(':')[2], 10);
        const state = ctx.session.createdTokenState;

        if (!Number.isInteger(index) || !state.tokens[index]) {
            setError(ctx, 'Selected token is no longer available.');
            await renderCreatedTokenPicker(ctx);
            return;
        }

        state.selectedTokenIndex = index;
        clearError(ctx);
        await renderCreatedTokenDetail(ctx);
        return;
    }

    if (data === 'tokens:back') {
        await answerCallback(ctx);
        clearError(ctx);
        await renderCreatedTokenPicker(ctx);
        return;
    }

    if (data === 'tokens:detail') {
        await answerCallback(ctx);
        clearError(ctx);
        await renderCreatedTokenDetail(ctx);
        return;
    }

    if (data === 'tokens:newrun') {
        await answerCallback(ctx);
        await startNewRunForCreatedToken(ctx, ctx.session.createdTokenState.tokens[ctx.session.createdTokenState.selectedTokenIndex]);
        return;
    }

    if (data === 'tokens:additionalmint') {
        await answerCallback(ctx);
        ctx.session.flow = 'tokenAdditionalMint';
        ctx.session.view = 'additionalMint';
        ctx.session.editField = null;
        ctx.session.createdTokenState.additionalMintAmount = '';
        clearError(ctx);
        await renderAdditionalMintCard(ctx);
        return;
    }

    if (data === 'tokens:additionalmint:edit') {
        await answerCallback(ctx, 'Send the amount in chat.');
        ctx.session.flow = 'tokenAdditionalMint';
        ctx.session.view = 'additionalMint';
        ctx.session.editField = 'additionalMintAmount';
        clearError(ctx);
        await renderAdditionalMintCard(ctx);
        return;
    }

    if (data === 'tokens:additionalmint:start') {
        await answerCallback(ctx);
        await beginAdditionalMintExecution(ctx);
        return;
    }

    if (data === 'tokens:revoke:mint') {
        await answerCallback(ctx);
        await beginAuthorityRevokeExecution(ctx, 'mint');
        return;
    }

    if (data === 'tokens:revoke:freeze') {
        await answerCallback(ctx);
        await beginAuthorityRevokeExecution(ctx, 'freeze');
        return;
    }

    if (data === 'tokens:additionalmint:back') {
        await answerCallback(ctx);
        ctx.session.flow = 'createdTokens';
        ctx.session.view = 'detail';
        ctx.session.editField = null;
        ctx.session.createdTokenState.additionalMintAmount = '';
        clearError(ctx);
        await renderCreatedTokenDetail(ctx);
        return;
    }

    if (data === 'tokens:viewruns') {
        await answerCallback(ctx);
        const state = ctx.session.createdTokenState;
        state.runs = await listRuns(state.tokens[state.selectedTokenIndex].mintAddress);
        state.runPage = 0;
        state.selectedRunIndex = null;

        if (!state.runs.length) {
            setError(ctx, 'No saved runs found for this token yet.');
            await renderCreatedTokenDetail(ctx);
            return;
        }

        clearError(ctx);
        await renderCreatedTokenRunPicker(ctx);
        return;
    }

    if (data.startsWith('tokens:runs:page:')) {
        await answerCallback(ctx);
        ctx.session.createdTokenState.runPage = Number.parseInt(data.split(':')[3], 10) || 0;
        clearError(ctx);
        await renderCreatedTokenRunPicker(ctx);
        return;
    }

    if (data.startsWith('tokens:runs:run:')) {
        await answerCallback(ctx);
        const index = Number.parseInt(data.split(':')[3], 10);
        const state = ctx.session.createdTokenState;

        if (!Number.isInteger(index) || !state.runs[index]) {
            setError(ctx, 'Selected run is no longer available.');
            await renderCreatedTokenRunPicker(ctx);
            return;
        }

        state.selectedRunIndex = index;
        clearError(ctx);
        await renderCreatedTokenRunDetail(ctx);
        return;
    }

    if (data === 'tokens:runs:back') {
        await answerCallback(ctx);
        clearError(ctx);
        await renderCreatedTokenRunPicker(ctx);
        return;
    }

    if (data === 'tokens:runs:retry') {
        await answerCallback(ctx);
        await beginCreatedTokenMintRetryExecution(ctx);
        return;
    }

    if (data === 'tokens:runs:refund') {
        await answerCallback(ctx);
        const tokenState = ctx.session.createdTokenState;
        const selectedToken = tokenState.tokens[tokenState.selectedTokenIndex];
        const mints = [createMintSummaryFromRuns(selectedToken, tokenState.runs)];
        const runs = tokenState.runs;
        const selectedRunIndex = tokenState.selectedRunIndex;

        resetSession(ctx);
        ctx.session.flow = 'refund';
        ctx.session.view = 'confirm';
        ctx.session.refundState = createRefundState();
        ctx.session.refundState.mints = mints;
        ctx.session.refundState.selectedMintIndex = 0;
        ctx.session.refundState.runs = runs;
        ctx.session.refundState.selectedRunIndex = selectedRunIndex;
        await renderRefundConfirm(ctx);
        return;
    }

    await answerCallback(ctx);
}

bot.use(session({ defaultSession: createDefaultSession }));

bot.use(async (ctx, next) => {
    const chatId = String(ctx.chat?.id || '');
    const chatAllowed = !config.allowedChatIds.length || config.allowedChatIds.includes(chatId);

    if (isAdmin(ctx) && chatAllowed) {
        return next();
    }

    if (!isAuthorized(ctx)) {
        await ctx.reply('Unauthorized.');
        return;
    }

    return next();
});

function getRequiredNumericUserIdArgument(ctx) {
    const value = getCommandArgument(ctx);
    if (!/^\d+$/.test(value)) {
        return null;
    }

    return value;
}

function getRequiredBase58Argument(ctx) {
    return getCommandArgument(ctx);
}

async function requireAdmin(ctx) {
    const chatId = String(ctx.chat?.id || '');
    const chatAllowed = !config.allowedChatIds.length || config.allowedChatIds.includes(chatId);

    if (!isAdmin(ctx) || !chatAllowed) {
        await ctx.reply('Unauthorized.');
        return false;
    }

    return true;
}

bot.command('start', async ctx => {
    await renderMainMenu(ctx, undefined, { forceNewMessage: true });
});

bot.command('allowlist', async ctx => {
    if (!(await requireAdmin(ctx))) {
        return;
    }

    const allowedUserIds = [...allowlistState.allowedUserIds];
    await ctx.reply(
        allowedUserIds.length
            ? `Allowed user IDs:\n${allowedUserIds.join('\n')}`
            : 'Allowlist is empty.'
    );
});

bot.command('myid', async ctx => {
    await ctx.reply(`Your Telegram user ID is ${ctx.from?.id}.`);
});

bot.command('allowlist_add', async ctx => {
    if (!(await requireAdmin(ctx))) {
        return;
    }

    const userId = getRequiredNumericUserIdArgument(ctx);
    if (!userId) {
        await ctx.reply('Usage: /allowlist_add <numeric_user_id>');
        return;
    }

    const result = await addAllowedUserId(userId, config.allowedUserIds);
    allowlistState.allowedUserIds = new Set(result.allowedUserIds);
    await ctx.reply(result.changed ? `Added user ID ${userId} to the allowlist.` : `User ID ${userId} is already allowed.`);
});

bot.command('allowlist_remove', async ctx => {
    if (!(await requireAdmin(ctx))) {
        return;
    }

    const userId = getRequiredNumericUserIdArgument(ctx);
    if (!userId) {
        await ctx.reply('Usage: /allowlist_remove <numeric_user_id>');
        return;
    }

    const result = await removeAllowedUserId(userId, config.allowedUserIds);
    allowlistState.allowedUserIds = new Set(result.allowedUserIds);
    await ctx.reply(result.changed ? `Removed user ID ${userId} from the allowlist.` : `User ID ${userId} was not in the allowlist.`);
});

bot.command('mint', async ctx => {
    if (ctx.session.busy) {
        await ctx.reply('An operation is already running.');
        return;
    }

    await startMintFlow(ctx);
});

bot.command('create', async ctx => {
    if (ctx.session.busy) {
        await ctx.reply('An operation is already running.');
        return;
    }

    await startTokenCreateFlow(ctx);
});

bot.command('refund', async ctx => {
    if (ctx.session.busy) {
        await ctx.reply('An operation is already running.');
        return;
    }

    await startRefundFlow(ctx);
});

bot.command('mints', async ctx => {
    if (ctx.session.busy) {
        await ctx.reply('An operation is already running.');
        return;
    }

    await startBrowseMintsFlow(ctx);
});

bot.command('tokens', async ctx => {
    if (ctx.session.busy) {
        await ctx.reply('An operation is already running.');
        return;
    }

    await startCreatedTokensFlow(ctx);
});

bot.command('wallet', async ctx => {
    if (!(await requireAdmin(ctx))) {
        return;
    }

    if (ctx.session.busy) {
        await ctx.reply('An operation is already running.');
        return;
    }

    const nextPrivateKey = getRequiredBase58Argument(ctx);
    if (!nextPrivateKey) {
        await ctx.reply('Usage: /wallet <base58_private_key>');
        return;
    }

    if (nextPrivateKey.trim().startsWith('[')) {
        await ctx.reply('The /wallet command only accepts a base58 private key.');
        return;
    }

    try {
        const previousAddress = getAuthorityPublicKey().toBase58();
        const nextSecretKey = parseAuthoritySecretKey(nextPrivateKey);
        const nextKeypair = Keypair.fromSecretKey(nextSecretKey);
        await setRuntimeAuthorityPrivateKey(nextPrivateKey);
        await ctx.reply([
            'Bot wallet updated.',
            `Previous: ${previousAddress}`,
            `Current: ${nextKeypair.publicKey.toBase58()}`
        ].join('\n'));
    } catch (error) {
        await ctx.reply(`Invalid base58 private key: ${error.message}`);
    }
});

bot.command('pool', async ctx => {
    if (ctx.session.busy) {
        await ctx.reply('An operation is already running.');
        return;
    }

    await startPoolFlow(ctx);
});

bot.command('runs', async ctx => {
    if (ctx.session.busy) {
        await ctx.reply('An operation is already running.');
        return;
    }

    await startBrowseRunsFlow(ctx, getCommandArgument(ctx));
});

bot.on('callback_query', async ctx => {
    await handleCallback(ctx);
});

bot.on('photo', async ctx => {
    if (ctx.session.busy) {
        await ctx.reply('An operation is already running.');
        return;
    }

    if (ctx.session.flow === 'tokenCreate') {
        await handleTokenPhotoInput(ctx);
        return;
    }

    await ctx.reply('Use the button panel to navigate. Send a photo only when the token icon field is in edit mode.');
});

bot.on('text', async ctx => {
    const messageText = ctx.message.text;
    const username = ctx.from?.username || ctx.from?.first_name || 'Unknown';
    const telegramId = ctx.from?.id;

    console.log(`${username} [${telegramId}]: ${messageText}`);

    if (ctx.message.text.startsWith('/')) {
        console.log(`${username} [${telegramId}]: ${messageText}`);
        return;
    }

    if (ctx.session.busy) {
        await ctx.reply('An operation is already running.');
        return;
    }

    if (ctx.session.flow === 'mint') {
        await handleMintTextInput(ctx, ctx.message.text);
        return;
    }

    if (ctx.session.flow === 'tokenCreate') {
        await handleTokenTextInput(ctx, ctx.message.text);
        return;
    }

    if (ctx.session.flow === 'tokenAdditionalMint') {
        await handleAdditionalMintTextInput(ctx, ctx.message.text);
        return;
    }

    if (ctx.session.flow === 'pool') {
        await handlePoolTextInput(ctx, ctx.message.text);
        return;
    }

    await ctx.reply('Use the button panel to navigate. Send text only when a field is in edit mode.');
});

bot.catch(async (error, ctx) => {
    console.error(error);
    if (ctx && ctx.reply) {
        await ctx.reply(`Unexpected error: ${error.message}`);
    }
});

loadRuntimeAllowlist(config.allowedUserIds)
    .then(runtimeAllowlist => {
        allowlistState.allowedUserIds = new Set(runtimeAllowlist.allowedUserIds);
        return bot.launch();
    })
    .then(() => {
        console.log('Telegram bot started.');
    })
    .catch(error => {
        console.error(`Failed to start bot: ${error.message}`);
        process.exit(1);
    });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
