const { Connection, Keypair, PublicKey, clusterApiUrl, Transaction, SystemProgram, ComputeBudgetProgram } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, createMintToInstruction, getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID  } = require('@solana/spl-token');
const fs = require('fs');
const readline = require('readline');
const bs58 = (require('bs58').default || require('bs58'));

const ask = (query) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans); }));
};

async function run() {
    console.log("--- Solana Strict Type Minter ---");

    const privKeyInput = await ask("🔑 Paste Private Key: ");
    const mintAddrInput = await ask("🏷️  Enter Mint Address: ");
    const N = parseFloat(await ask("💰 Total (N): "));
    const M = parseInt(await ask("👥 Wallets (M): "));

    try {
        const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
        
        let secretKey;
        try {
            secretKey = Uint8Array.from(JSON.parse(privKeyInput));
        } catch (e) {
            secretKey = bs58.decode(privKeyInput.trim());
        }
        
        const authority = Keypair.fromSecretKey(secretKey);
        const mintAddress = new PublicKey(mintAddrInput.trim());

        // --- FIX 1: Detect Program First ---
        const mintAccountInfo = await connection.getAccountInfo(mintAddress);
        if (!mintAccountInfo) throw new Error("Mint address not found on Devnet!");
        const programId = mintAccountInfo.owner; 

        // --- FIX 2: Pass programId to getMint ---
        const mintInfo = await getMint(connection, mintAddress, 'confirmed', programId);
        
        const avg = N / M;
        const wallets = [];

        // Generate wallets
        for (let i = 0; i < M; i++) {
            const kp = Keypair.generate();
            if (M > 1 && i < M - 1) {
                const offset = Math.random() * (avg * 0.15);
                wallets.push({ kp, amount: avg + offset });
                wallets.push({ kp: Keypair.generate(), amount: avg - offset });
                i++;
            } else {
                wallets.push({ kp, amount: avg });
            }
        }

        // --- FIX 3: Save Wallets IMMEDIATELY ---
        const walletData = wallets.map(w => ({
            pub: w.kp.publicKey.toBase58(),
            privBase58: bs58.encode(w.kp.secretKey),
            secret: Array.from(w.kp.secretKey),
            tokens: w.amount
        }));
        fs.writeFileSync('wallets.json', JSON.stringify(walletData, null, 2));
        console.log("📂 Wallets saved to wallets.json");

        console.log(`🚀 Minting to ${wallets.length} wallets using Program: ${programId.toBase58()}`);

        for (const item of wallets) {
            try {
                const ata = await getOrCreateAssociatedTokenAccount(
                    connection,
                    authority,
                    mintAddress,
                    item.kp.publicKey,
                    false,
                    'confirmed',
                    undefined,
                    programId 
                );

                const rawAmount = BigInt(Math.floor(item.amount * Math.pow(10, mintInfo.decimals)));
                
                // Create the transaction
                const transaction = new Transaction().add(
                    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 15000 }),
                    
                    // --- ADD THIS LINE ---
                    // Sends 0.001 SOL from your main wallet to the new wallet for gas
                    SystemProgram.transfer({
                        fromPubkey: authority.publicKey,
                        toPubkey: item.kp.publicKey,
                        lamports: 950000, // 0.0095 SOL (950,000 lamports)
                    }),

                    createMintToInstruction(
                        mintAddress,
                        ata.address,
                        authority.publicKey,
                        rawAmount,
                        [],
                        programId 
                    )
                );

                const signature = await connection.sendTransaction(transaction, [authority]);
                await connection.confirmTransaction(signature);

                console.log(`✅ Success: Sent ${item.amount.toFixed(mintInfo.decimals)} tokens + 0.001 SOL gas to ${item.kp.publicKey.toBase58()}`);
                await new Promise(r => setTimeout(r, 1000)); 
            } catch (e) {
                console.error(`❌ Error on ${item.kp.publicKey.toBase58()}:`, e.message);
            }
        }
    } catch (err) {
        console.error("⛔ Fatal Error:", err.message);
    }
}
run();