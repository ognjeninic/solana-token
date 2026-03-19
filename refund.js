const { Connection, Keypair, PublicKey, clusterApiUrl, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createTransferInstruction, createCloseAccountInstruction, getAccount } = require('@solana/spl-token');
const fs = require('fs');
const bs58 = (require('bs58').default || require('bs58'));
const readline = require('readline');

const ask = (query) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans); }));
};

async function run() {
    const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');

    console.log("--- Solana Token & Rent Reclaim Tool ---");

    const mainPrivKey = await ask("🔑 Paste Main Private Key: ");
    const mintAddrStr = await ask("🏷️  Enter Mint Address: ");

    let mainSecret;
    try {
        mainSecret = Uint8Array.from(JSON.parse(mainPrivKey));
    } catch (e) {
        mainSecret = bs58.decode(mainPrivKey.trim());
    }
    const mainWallet = Keypair.fromSecretKey(mainSecret);
    const mintAddress = new PublicKey(mintAddrStr.trim());

    const wallets = JSON.parse(fs.readFileSync('wallets.json', 'utf8'));

    const mintAccountInfo = await connection.getAccountInfo(mintAddress);
    if (!mintAccountInfo) throw new Error("Mint not found on Devnet!");
    const programId = mintAccountInfo.owner;

    const mainAta = await getAssociatedTokenAddress(mintAddress, mainWallet.publicKey, false, programId);

    console.log(`\n🔄 Reclaiming to ${mainWallet.publicKey.toBase58()}...`);

    for (const w of wallets) {
        const tempWallet = Keypair.fromSecretKey(Uint8Array.from(w.secret));
        const tempAta = await getAssociatedTokenAddress(mintAddress, tempWallet.publicKey, false, programId);

        try {
            // Check if the account exists and has tokens
            const account = await getAccount(connection, tempAta, 'confirmed', programId);

            const tx = new Transaction().add(
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 15000 }),
                
                // 1. Move the tokens back to you
                createTransferInstruction(
                    tempAta, 
                    mainAta, 
                    tempWallet.publicKey, 
                    account.amount, 
                    [], 
                    programId
                ),

                // 2. Close the account and send the ~0.002 SOL rent back to you
                createCloseAccountInstruction(
                    tempAta, 
                    mainWallet.publicKey, 
                    tempWallet.publicKey, 
                    [], 
                    programId
                )
            );

            const signature = await connection.sendTransaction(tx, [tempWallet]);
            await connection.confirmTransaction(signature);
            
            console.log(`✅ Reclaimed tokens & rent from: ${w.pub}`);
        } catch (e) {
            // If the account is already closed or doesn't exist, skip it gracefully
            console.log(`ℹ️  Skipping ${w.pub}: Account already empty or closed.`);
        }
    }
    console.log("\n✨ All possible tokens and rent reclaimed!");
}

run();