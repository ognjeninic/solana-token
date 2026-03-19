const { Connection, Keypair, PublicKey, clusterApiUrl, Transaction, SystemProgram, ComputeBudgetProgram } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, createMintToInstruction, getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID  } = require('@solana/spl-token');
const fs = require('fs');
const readline = require('readline');
const bs58 = (require('bs58').default || require('bs58'));

const ask = (query) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans); }));
};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
    console.log("--- Solana Multi Type Minter ---");

    const privKeyInput = await ask("🔑 Paste Private Key: ");
    const mintAddrInput = await ask("🏷️  Enter Mint Address: ");

    try {
        const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
        // private RPC endpoint
        //const connection = new Connection("https://mainnet.helius-rpc.com/?api-key=YOUR_ACTUAL_KEY", "confirmed");

        // basic mainnet (rate limit)
        //const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
        
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
        console.log("Digits: ", mintInfo.decimals)
        
        
        const data = fs.readFileSync('errors.txt', 'utf8');
        const lines = data.split('\n').filter(line => line.trim() !== '');

        console.log(`🚀 Starting minting for ${lines.length} addresses...`);
        fs.unlinkSync("errors.txt");
        for (const line of lines) {
            const [amountStr, addressStr] = line.trim().split(/\s+/);
            const amount = parseFloat(amountStr);
            const recipient = new PublicKey(addressStr);

            try {
                const ata = await getOrCreateAssociatedTokenAccount(
                    connection,
                    authority,
                    mintAddress,
                    recipient,
                    false,
                    'confirmed',
                    undefined,
                    programId 
                );

                const rawAmount = BigInt(Math.floor(amount * Math.pow(10, mintInfo.decimals)));
                
                // Create the transaction
                const transaction = new Transaction().add(
                    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 15000 }),
                    
                    // --- ADD THIS LINE ---
                    // Sends 0.001 SOL from your main wallet to the new wallet for gas
                    SystemProgram.transfer({
                        fromPubkey: authority.publicKey,
                        toPubkey: recipient,
                        lamports: 1000000, // 0.001 SOL (1,000,000 lamports)
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

                console.log(`✅ Success: Sent ${amount.toFixed(mintInfo.decimals)} tokens + 0.001 SOL gas to ${recipient.toBase58()}`);
                // --- DELAY ---
                console.log("⏳ Waiting 1 second to avoid rate limits...");
                await sleep(1500); //change to 1500 if network is clogged, normally 1000

            } catch (e) {
                console.error(`❌ Error on ${recipient.toBase58()}:`, e.message);
                console.log("Mint failed, probably due to network congestion. Manually mint ", amount.toFixed(mintInfo.decimals), "+ 0.001 SOL gas to ", recipient.toBase58());
                fs.appendFile('errors.txt', `${amount.toFixed(mintInfo.decimals)} ${recipient.toBase58()}\n`, err => {
                    if (err) {
                        console.error("Couldn't write to error.txt");
                    } else {
                    console.log('Error wallet appended to errors.txt');
                    }
                });
                console.log("Sleeping 1.5s");
                await sleep(1500);
            }
        }
    } catch (err) {
        console.error("⛔ Fatal Error:", err.message);
    }
}
run();