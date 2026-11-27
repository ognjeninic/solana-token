# Solana Token Tools

A Node.js toolkit and interactive Telegram bot for launching, distributing, managing, and pooling Solana SPL tokens on `devnet` and `mainnet`.

It combines a full-featured [Telegraf](https://github.com/telegraf/telegraf) control panel with standalone CLI scripts for batch minting, retrying failed runs, and reclaiming tokens and SOL rent from ephemeral wallets.

---

## Features

- **SPL Token Creation & IPFS Metadata (`/create`)**
  - Deploy new SPL tokens with configurable name, symbol, decimals, and initial mint supply.
  - Upload token icons and Metaplex JSON metadata (including description and Twitter/X link) directly to IPFS via [Pinata](https://pinata.cloud/).
  - Attach on-chain Metaplex Token Metadata v3 accounts automatically.
- **Multi-Wallet Batch Minting (`/mint`, `npm run mint`)**
  - Generate fresh ephemeral keypairs per run and split the total token amount across them with randomized ±15% pairwise variance.
  - Automatically fund each wallet with `0.001` SOL (`1,000,000` lamports) for gas, create Associated Token Accounts idempotently, and mint in batches of 3 with single-wallet fallback on error.
  - Uses dynamic priority fee estimation (`getPriorityFeeEstimate`, falling back to `15,000` micro-lamports) and configurable inter-batch delays.
- **Automated Refunds & Rent Reclamation (`/refund`, `npm run refund`)**
  - Sweep remaining token balances from saved run wallets back to the authority wallet's ATA.
  - Close ephemeral token accounts and return reclaimed SOL rent to the authority wallet.
- **Retry & Run History (`/mints`, `/runs`, `npm run multimint`, `npm run multirefund`)**
  - Persist every run in `data/mints/<mintAddress>/<runId>.json` with per-wallet status and failure logs.
  - Resume or retry only failed mint or refund wallets without duplicating completed ones.
- **Token Management (`/tokens`)**
  - Inspect created tokens, authority wallet balances, and mint/freeze authority status.
  - Execute additional mints to the authority wallet or permanently revoke Mint / Freeze authorities.
- **Meteora DAMM v2 Pool Creation (`/pool`)**
  - Create Token/SOL liquidity pools via `@meteora-ag/cp-amm-sdk` for standard SPL tokens held by the bot wallet.
  - Automatically selects the lowest-fee full-range (or widest available) public static DAMM v2 config and stores pool/position details locally.
- **Authority Wallet & Access Control (`/wallet`, `/allowlist`)**
  - Check `mainnet` and `devnet` SOL balances, generate a funding QR code, or hot-swap the runtime authority private key.
  - Restrict bot access by Telegram user ID, chat ID, and admin privileges, with optional monitor chat alerts (`TELEGRAM_MONITOR_CHAT_IDS`).

---

## Prerequisites

- **Node.js** v18+ (uses native `fetch` and `File`)
- **npm**
- A funded Solana authority wallet (Base58 or JSON byte-array private key)
- A **Telegram Bot Token** from [@BotFather](https://t.me/BotFather) (required for `bot.js`)
- A **Pinata JWT** (required when uploading token icons and metadata to IPFS)
- *(Recommended)* Dedicated Solana RPC endpoints (e.g., Helius) for reliable `mainnet` and `getPriorityFeeEstimate` support

---

## Installation

```bash
git clone <repository-url>
cd solana-token
npm install
cp .env.example .env
```

Edit `.env` with your credentials and RPC configuration (see [Configuration](#configuration)).

---

## Configuration

All environment variables are loaded from `.env` via `dotenv` (see [`.env.example`](.env.example)):

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `AUTHORITY_PRIVATE_KEY` | Yes | — | Authority wallet private key in Base58 or JSON byte-array format (`[1,2,...]`). |
| `TELEGRAM_BOT_TOKEN` | For bot | — | Telegram bot token used by `bot.js`. |
| `SOLANA_CLUSTER` | No | `devnet` | Default cluster: `devnet` or `mainnet` (`mainnet-beta` alias supported). |
| `SOLANA_RPC_URL` | No | Cluster public RPC | Fallback custom RPC URL for the active `SOLANA_CLUSTER`. |
| `SOLANA_MAINNET_RPC_URL` | No | — | Dedicated RPC URL used whenever `mainnet` is selected. |
| `SOLANA_DEVNET_RPC_URL` | No | — | Dedicated RPC URL used whenever `devnet` is selected. |
| `DEFAULT_DELAY_MS` | No | `1500` | Default delay in milliseconds between mint/refund batches. |
| `PINATA_JWT` | For uploads | — | Pinata API JWT for uploading token images and metadata JSON to IPFS. |
| `PINATA_GATEWAY` | No | `gateway.pinata.cloud` | Pinata gateway domain used when building IPFS URIs. |
| `TELEGRAM_ADMIN_USER_ID` | No | — | Telegram numeric user ID granted admin privileges (`/allowlist*`). |
| `TELEGRAM_ALLOWED_USER_IDS` | No | Open if empty | Comma-separated numeric Telegram user IDs allowed to use the bot. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | No | Open if empty | Comma-separated Telegram chat IDs where the bot will respond. |
| `TELEGRAM_MONITOR_CHAT_IDS` | No | — | Comma-separated chat IDs for `[MONITOR LOG]` operational alerts. |

---

## Usage

### 1. Telegram Bot

Start the interactive bot:

```bash
npm run bot
```

Open your bot in Telegram and send `/start` to launch the inline button menu, or use slash commands directly:

#### Bot Commands

| Command | Description |
| --- | --- |
| `/start` | Open the interactive main menu panel. |
| `/create` | Launch the guided SPL token creation wizard. |
| `/mint` | Configure and start a multi-wallet batch mint run. |
| `/refund` | Select a saved mint/run and sweep tokens + rent back to the authority wallet. |
| `/tokens` | Browse locally created tokens, mint additional supply, or revoke authorities. |
| `/mints` | Browse all saved mint histories. |
| `/runs [mintAddress]` | Browse saved runs (optionally filtered by mint address). |
| `/pool` | Create a Meteora DAMM v2 Token/SOL liquidity pool. |
| `/wallet [privateKey]` | View authority address/balances/QR code, or hot-swap the runtime authority key. |
| `/myid` | Print your numeric Telegram user ID. |
| `/allowlist` | *(Admin)* List currently allowed Telegram user IDs. |
| `/allowlist_add <userId>` | *(Admin)* Add a numeric user ID to the runtime allowlist. |
| `/allowlist_remove <userId>` | *(Admin)* Remove a numeric user ID from the runtime allowlist. |

---

### 2. Standalone CLI Scripts

Every core mint and refund workflow can also be run interactively from the terminal without Telegram:

| Script | Command | Description |
| --- | --- | --- |
| `mint.js` | `npm run mint` | Create and execute a new multi-wallet batch mint run for an existing mint address. |
| `multimint.js` | `npm run multimint` | Select a saved mint and run ID to retry failed or pending wallets. |
| `refund.js` | `npm run refund` | Select a saved mint and run ID to transfer tokens back and close ephemeral ATAs. |
| `multirefund.js` | `npm run multirefund` | Retry failed or pending wallets in an existing refund run. |
| `convert.js` | `node convert.js` | Utility script to convert a `[byte, ...]` Solana secret key array to Base58. |

---

## Project Structure

```text
.
├── bot.js                        # Telegram bot entrypoint, interactive panels & command handlers
├── mint.js                       # CLI: execute a new multi-wallet mint run
├── multimint.js                  # CLI: retry failed wallets from a saved mint run
├── refund.js                     # CLI: refund tokens and reclaim SOL rent from a saved run
├── multirefund.js                # CLI: retry failed wallets from a saved refund run
├── convert.js                    # Helper to encode JSON byte-array keys to Base58
├── .env.example                  # Sample environment configuration
├── package.json
└── lib/
    ├── config.js                 # Environment & runtime authority configuration loader
    ├── utils.js                  # Input parsers, amount formatters, progress helpers
    ├── cli/
    │   └── helpers.js            # Interactive CLI prompts for choosing saved mints/runs
    ├── services/
    │   ├── meteoraService.js     # Meteora DAMM v2 pool creation & held token discovery
    │   ├── mintService.js        # Randomized allocation, batch minting & retry logic
    │   ├── pinataService.js      # IPFS image & metadata JSON upload via Pinata
    │   ├── refundService.js      # Token sweep & ATA close/rent reclamation logic
    │   ├── solana.js             # RPC connection, mint/metadata readers & priority fees
    │   ├── tokenService.js       # SPL token creation, additional mint & authority revocation
    │   └── walletService.js      # Authority balances & funding QR code generation
    └── storage/
        ├── allowlistStore.js     # Persistent Telegram user allowlist (data/allowlist.json)
        ├── authorityStore.js     # Runtime authority key override (data/authority-override.json)
        ├── poolStore.js          # Saved Meteora DAMM v2 pool records
        ├── runStore.js           # Saved mint/refund run records & ephemeral wallet keys
        └── tokenStore.js         # Saved created token records
```

---

## Local Data & Security Notes

Runtime state is stored locally inside `data/` (excluded from Git via [`.gitignore`](.gitignore)):

- `data/tokens/<mintAddress>.json` — Metadata and mint history for tokens created with this tool.
- `data/mints/<mintAddress>/<runId>.json` — Run status, failures, and **ephemeral wallet secret keys** needed to execute refunds.
- `data/pools/<network>/<poolAddress>.json` — Created Meteora DAMM v2 pool and position NFT metadata.
- `data/allowlist.json` — Runtime Telegram user allowlist managed by `/allowlist_add` and `/allowlist_remove`.
- `data/authority-override.json` — Runtime authority private key written when swapping keys via `/wallet`.

> [!CAUTION]
> **Protect `.env` and `data/`:** Both your `AUTHORITY_PRIVATE_KEY` (`.env` / `data/authority-override.json`) and generated ephemeral wallet secret keys (`data/mints/`) are stored in plaintext on disk. Never commit these files or expose them publicly, and always configure `TELEGRAM_ALLOWED_USER_IDS` / `TELEGRAM_ADMIN_USER_ID` before running the bot in production.

---

## License

ISC
