const { PublicKey } = require('@solana/web3.js');
const { Telegraf, session, Markup } = require('telegraf');
const { loadConfig } = require('./lib/config');
const { addAllowedUserId, loadRuntimeAllowlist, removeAllowedUserId } = require('./lib/storage/allowlistStore');
const { backfillMintMetadata, listMintSummaries, listRuns, loadRun } = require('./lib/storage/runStore');
const { executeMintRun, retryMintFailures } = require('./lib/services/mintService');
const { executeRefundRun } = require('./lib/services/refundService');
const { createConnection, fetchTokenMetadata } = require('./lib/services/solana');
const { createProgressReporter, formatProgressBar, parsePositiveInteger, parsePositiveNumber } = require('./lib/utils');

const config = loadConfig({ requireTelegram: true });
const bot = new Telegraf(config.telegramBotToken);
const allowlistState = {
    allowedUserIds: new Set()
};

const PAGE_SIZE = 6;
const DEFAULT_WALLET_COUNT = '10';
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
        refundState: null,
        browseState: null
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
    ctx.session.refundState = null;
    ctx.session.browseState = null;
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
            Markup.button.callback('🪙 Mint', 'menu:mint'),
            Markup.button.callback('↩️ Refund', 'menu:refund')
        ],
        [
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

function getTokenDisplay(entity = {}) {
    const tokenSymbol = String(entity.tokenSymbol || '').trim();
    const tokenName = String(entity.tokenName || '').trim();

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

function formatMintCardText(ctx) {
    const draft = ctx.session.mintDraft;
    const errors = draft ? getMintDraftErrors(draft) : [];
    const tokenDisplay = getTokenDisplay(draft);
    const lines = [
        'Mint Configuration',
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

function formatNetworkPickerText(ctx) {
    const lines = [
        'Select Network',
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
        title,
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

async function renderMainMenu(ctx, introText, options = {}) {
    resetSession(ctx, {
        preservePanel: !options.forceNewMessage
    });
    const text = introText || [
        'Solana Token Tools',
        '',
        'Choose an action from the button menu below.'
    ].join('\n');
    await renderPanel(ctx, text, buildActionButtons());
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

async function startRefundFlow(ctx) {
    resetSession(ctx);
    ctx.session.flow = 'refund';
    ctx.session.view = 'mints';
    ctx.session.refundState = createRefundState();
    ctx.session.refundState.mints = await listMintSummaries();

    if (!ctx.session.refundState.mints.length) {
        await renderPanel(ctx, 'No saved mints found.', [
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
        'Refund: Select Mint',
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
        'Refund: Select Run',
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
        'Refund Confirmation',
        '',
        `Mint: ${selectedMint.mintAddress}`,
        `Run: ${selectedRun.runId}`,
        `Status: ${selectedRun.status}`,
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
        await renderPanel(ctx, 'No saved mints found.', [
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
        state.mode === 'runs' ? 'Runs: Select Mint' : 'Saved Mints',
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
        'Mint Details',
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
        'Saved Runs',
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
        'Run Details',
        '',
        `Mint: ${getMintPrimaryLabel(selectedMint)}`,
        `Address: ${selectedMint.mintAddress}`,
        `Run: ${selectedRun.runId}`,
        `Status: ${selectedRun.status}`,
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
        await renderPanel(ctx, 'No saved mints found.', [
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
        'Mint Starting',
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
        'Refund Starting',
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
        'Retry Starting',
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

async function handleMenuAction(ctx, action) {
    if (action === 'main') {
        await renderMainMenu(ctx);
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

    if (action === 'runs') {
        await startBrowseRunsFlow(ctx);
        return;
    }
}

async function handleCallback(ctx) {
    const data = ctx.callbackQuery.data;

    if (ctx.session.busy) {
        await answerCallback(ctx, 'An operation is already running.');
        return;
    }

    if (data.startsWith('menu:')) {
        await answerCallback(ctx);
        await handleMenuAction(ctx, data.split(':')[1]);
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

bot.on('text', async ctx => {
    if (ctx.message.text.startsWith('/')) {
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
