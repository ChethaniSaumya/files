// blockchain-listener.js - COMPLETE FIXED VERSION
const { Connection, PublicKey } = require('@solana/web3.js');
const { getMint } = require('@solana/spl-token');

const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const LETS_BONK_PROGRAM = new PublicKey('BonKktHZNPGvGFxNQsPhFLMoESrh31Vf6FbMfvAPvumr');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

class BlockchainTokenListener {
    constructor(onTokenCallback) {
        this.onTokenCallback = onTokenCallback;
        this.pumpFunSubscriptionId = null;
        this.letsBonkSubscriptionId = null;

        this.recentSignatures = new Map();
        this.recentMints = new Map();
        this.processingTokens = new Set();

        const HELIUS_RPC = process.env.HELIUS_RPC;
        if (!HELIUS_RPC) throw new Error('❌ HELIUS_RPC not set!');

        this.connection = new Connection(HELIUS_RPC, {
            commitment: 'confirmed',
            wsEndpoint: HELIUS_RPC.replace('https://', 'wss://').replace('http://', 'ws://'),
        });

        console.log('🚀 Blockchain listener initialized');
    }

    start() {
        console.log('🔗 Starting blockchain listeners...');
        this.startPumpFunListener();
        this.startLetsBonkListener();
        console.log('✅ Blockchain listeners started');
    }

    startPumpFunListener() {
        this.pumpFunSubscriptionId = this.connection.onLogs(
            PUMP_FUN_PROGRAM,
            async (logs, ctx) => {
                await this.handleTokenCreation(logs, 'pump.fun');
            },
            'confirmed'
        );
        console.log('🟣 Pump.fun listener active');
    }

    startLetsBonkListener() {
        this.letsBonkSubscriptionId = this.connection.onLogs(
            LETS_BONK_PROGRAM,
            async (logs, ctx) => {
                await this.handleTokenCreation(logs, 'letsbonk');
            },
            'confirmed'
        );
        console.log('🟢 Let\'s Bonk listener active');
    }

    async handleTokenCreation(logs, platform) {
        const signature = logs.signature;

        if (this.recentSignatures.has(signature)) {
            return;
        }
        this.recentSignatures.set(signature, Date.now());

        const logMessages = logs.logs || [];
        const isTokenCreation = logMessages.some(log =>
            log.includes('Instruction: Create') ||
            log.includes('initializeMint') ||
            (log.includes('Instruction:') && log.includes('Create'))
        );

        if (!isTokenCreation) {
            return;
        }

        console.log(`🟣 ${platform} token detected: ${signature.substring(0, 12)}...`);

        setTimeout(() => {
            this.processTokenImmediately(signature, platform);
        }, 1000);
    }

    async processTokenImmediately(signature, platform) {
        if (this.processingTokens.has(signature)) {
            return;
        }
        this.processingTokens.add(signature);

        console.log(`⚡ Processing: ${signature.substring(0, 12)}...`);

        try {
            const tx = await this.fetchTransactionWithRetry(signature);

            if (!tx) {
                console.log(`❌ Failed to fetch tx`);
                return;
            }

            console.log(`✅ Tx fetched successfully`);

            const tokenData = await this.extractCompleteTokenData(tx, signature, platform);

            if (tokenData) {
                console.log(`🎯 TOKEN DATA READY - SENDING TO SERVER:`);
                console.log(JSON.stringify(tokenData, null, 2));

                await this.onTokenCallback(tokenData);
                console.log(`✅ Data sent to server`);
            } else {
                console.log(`❌ No token data extracted`);
            }

        } catch (error) {
            console.log(`❌ Processing error: ${error.message}`);
        } finally {
            this.processingTokens.delete(signature);
        }
    }

    async fetchTransactionWithRetry(signature, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const tx = await this.connection.getTransaction(signature, {
                    commitment: 'confirmed',
                    maxSupportedTransactionVersion: 0
                });

                if (tx && tx.transaction) {
                    return tx;
                }

                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, attempt * 1000));
                }

            } catch (error) {
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, attempt * 1000));
                }
            }
        }
        return null;
    }

    async extractCompleteTokenData(tx, signature, platform) {
        try {
            // ✅ FIXED: Properly extract account keys from versioned transactions
            let accountKeys = [];

            // Combine static keys + loaded addresses (for versioned transactions)
            if (tx.transaction?.message?.staticAccountKeys) {
                accountKeys = [...tx.transaction.message.staticAccountKeys];
            }

            // Add loaded addresses from lookup tables
            if (tx.meta?.loadedAddresses?.writable) {
                accountKeys.push(...tx.meta.loadedAddresses.writable);
            }
            if (tx.meta?.loadedAddresses?.readonly) {
                accountKeys.push(...tx.meta.loadedAddresses.readonly);
            }

            console.log(`🔍 Extracted ${accountKeys.length} account keys`);

            // ✅ FIXED: Get creator address (first account is always fee payer)
            let creatorAddress = 'Unknown';

            if (accountKeys.length > 0 && accountKeys[0]) {
                if (typeof accountKeys[0].toString === 'function') {
                    creatorAddress = accountKeys[0].toString();
                } else if (typeof accountKeys[0] === 'string') {
                    creatorAddress = accountKeys[0];
                } else if (accountKeys[0].pubkey) {
                    creatorAddress = accountKeys[0].pubkey.toString();
                }
            }

            console.log(`👤 Creator: ${creatorAddress}`);

            // Find mint address
            let mint = this.findMintInInnerInstructions(tx);
            if (!mint) {
                mint = this.findMintInTokenBalances(tx);
            }
            if (!mint) {
                mint = this.findMintInAccountKeys(accountKeys);
            }

            if (!mint) {
                console.log('❌ No mint address found');
                return null;
            }

            console.log(`✅ Found mint: ${mint.substring(0, 16)}...`);

            if (this.recentMints.has(mint)) {
                console.log(`⏩ Already processed mint`);
                return null;
            }
            this.recentMints.set(mint, Date.now());

            const mintPublicKey = new PublicKey(mint);

            // ✅ CALCULATE BONDING CURVE ADDRESS FIRST
            let bondingCurveAddress = null;
            if (platform === 'pump.fun') {
                const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), mintPublicKey.toBytes()],
                    PUMP_FUN_PROGRAM
                );
                bondingCurveAddress = bondingCurvePDA.toString();
                console.log(`📊 Bonding Curve: ${bondingCurveAddress}`);
            }

            // Get token info
            let tokenInfo = null;
            try {
                tokenInfo = await getMint(this.connection, mintPublicKey);
                console.log(`🪙 Token info: ${tokenInfo.supply.toString()} supply, ${tokenInfo.decimals} decimals`);
            } catch (error) {
                console.log(`❌ Failed to get token info: ${error.message}`);
                return null;
            }

            // Get complete metadata
            const completeMetadata = await this.getCompleteMetadata(mintPublicKey);
            console.log(`📝 Metadata: ${completeMetadata.name} (${completeMetadata.symbol})`);

            // Get bonding curve data
            const financialData = platform === 'pump.fun' ?
                await this.getBondingCurveData(mintPublicKey) :
                { marketCap: '0', price: '0', liquidity: '0', solAmount: '0' };

            // ✅ CREATE COMPLETE TOKEN DATA
            const tokenData = {
                id: mint,
                mint: mint,
                name: completeMetadata.name,
                symbol: completeMetadata.symbol,
                description: completeMetadata.description,
                image: completeMetadata.image,
                metadataUri: completeMetadata.uri,

                marketCap: financialData.marketCap, // Keep as string for display: "67.4167"
                marketCapSol: parseFloat(financialData.marketCap || 0), // ✅ Convert to number, handle null/undefined
                price: financialData.price,
                liquidity: financialData.liquidity,
                solAmount: parseFloat(financialData.solAmount || financialData.liquidity || 0), // ✅ Add fallback to 0
                totalSupply: tokenInfo.supply.toString(),
                decimals: tokenInfo.decimals,

                creator: creatorAddress,
                traderPublicKey: creatorAddress,
                creatorProfile: null,

                twitter: completeMetadata.twitter,
                twitterType: this.extractTwitterType(completeMetadata.twitter),
                twitterHandle: this.extractTwitterHandle(completeMetadata.twitter),
                twitterCommunityId: this.extractTwitterCommunityId(completeMetadata.twitter),
                twitterAdmin: this.extractTwitterAdmin(completeMetadata.twitter),
                website: completeMetadata.website,
                telegram: completeMetadata.telegram,
                discord: completeMetadata.discord,

                platform: platform,
                created: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : new Date().toISOString(),
                creationSignature: signature,

                bondingCurveAddress: bondingCurveAddress,
                bondingCurveKey: bondingCurveAddress,
                pool: platform === 'pump.fun' ? 'pump' : 'bonk',

                complete: true,
                metadataAlreadyFetched: true,
                featured: false,
                trending: false,
                verified: false,

                volume24h: '0',
                priceChange24h: '0',
                holders: '0',

                tokenProgram: TOKEN_PROGRAM_ID.toString(),
                associatedTokenAccount: await this.getAssociatedTokenAccount(mintPublicKey, creatorAddress),

                tags: completeMetadata.tags || [],
                category: completeMetadata.category || 'meme',
                audit: completeMetadata.audit || 'unaudited'
            };

            return tokenData;

        } catch (error) {
            console.log(`❌ Extraction error: ${error.message}`);
            console.error(error);
            return null;
        }
    }

    async getCompleteMetadata(mintPublicKey) {
        const metadata = {
            name: 'Unknown',
            symbol: 'UNKNOWN',
            description: 'A new token on Solana',
            image: null,
            uri: null,
            twitter: null,
            website: null,
            telegram: null,
            discord: null,
            tags: [],
            category: 'meme'
        };

        try {
            const [metadataPDA] = PublicKey.findProgramAddressSync(
                [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPublicKey.toBuffer()],
                TOKEN_METADATA_PROGRAM_ID
            );

            const metadataAccount = await this.connection.getAccountInfo(metadataPDA);
            if (metadataAccount) {
                const parsed = this.parseMetadataAccount(metadataAccount.data);
                if (parsed) {
                    metadata.name = parsed.name || 'Unknown';
                    metadata.symbol = parsed.symbol || 'UNKNOWN';
                    metadata.uri = parsed.uri;

                    if (parsed.uri) {
                        try {
                            const fullMetadata = await this.fetchIPFSJson(parsed.uri);
                            if (fullMetadata?.json) {
                                metadata.description = fullMetadata.json.description || 'A new token on Solana';
                                metadata.image = fullMetadata.json.image || null;
                                metadata.twitter = fullMetadata.json.twitter ||
                                    fullMetadata.json.extensions?.twitter || null;
                                metadata.website = fullMetadata.json.website || null;
                                metadata.telegram = fullMetadata.json.telegram || null;
                                metadata.discord = fullMetadata.json.discord || null;
                                metadata.tags = fullMetadata.json.tags || [];
                                metadata.category = fullMetadata.json.category || 'meme';
                            }
                        } catch (e) {
                            console.log('⚠️ IPFS metadata fetch failed');
                        }
                    }
                }
            }
        } catch (error) {
            console.log(`⚠️ Metadata fetch failed: ${error.message}`);
        }

        return metadata;
    }

    async getBondingCurveData(mintPublicKey) {
        try {
            const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
                [Buffer.from("bonding-curve"), mintPublicKey.toBytes()],
                PUMP_FUN_PROGRAM
            );

            const bondingCurveAccount = await this.connection.getAccountInfo(bondingCurvePDA);
            if (bondingCurveAccount) {
                const curveData = this.parseBondingCurve(bondingCurveAccount.data);
                return {
                    marketCap: curveData.marketCap,
                    price: curveData.price,
                    liquidity: curveData.liquidity,
                    virtualSolReserves: curveData.virtualSolReserves,
                    virtualTokenReserves: curveData.virtualTokenReserves
                };
            }
        } catch (error) {
            console.log('⚠️ Could not fetch bonding curve data');
        }

        return { marketCap: '0', price: '0', liquidity: '0' };
    }

    async getAssociatedTokenAccount(mintPublicKey, creatorAddress) {
        try {
            if (creatorAddress === 'Unknown') return null;

            const creatorPubkey = new PublicKey(creatorAddress);
            const [ata] = PublicKey.findProgramAddressSync(
                [creatorPubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintPublicKey.toBuffer()],
                new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
            );
            return ata.toString();
        } catch (error) {
            console.log(`⚠️ Could not calculate ATA: ${error.message}`);
        }
        return null;
    }

    parseBondingCurve(data) {
        try {
            let offset = 8;
            const virtualTokenReserves = data.readBigUInt64LE(offset);
            offset += 8;
            const virtualSolReserves = data.readBigUInt64LE(offset);

            // ✅ CONVERT TO SOL (divide by LAMPORTS_PER_SOL = 1000000000)
            const solReservesInSOL = Number(virtualSolReserves) / 1000000000;
            const marketCapInSOL = solReservesInSOL * 2;
            const priceInSOL = virtualTokenReserves > 0 ?
                solReservesInSOL / (Number(virtualTokenReserves) / 1000000) : 0;

            return {
                virtualSolReserves: virtualSolReserves.toString(),
                virtualTokenReserves: virtualTokenReserves.toString(),
                marketCap: marketCapInSOL.toFixed(4), // ✅ Return as SOL string
                price: priceInSOL.toFixed(10),
                liquidity: solReservesInSOL.toFixed(4), // ✅ Return as SOL string
                solAmount: solReservesInSOL.toFixed(4) // ✅ ADD THIS for initial liquidity
            };
        } catch (error) {
            return { marketCap: '0', price: '0', liquidity: '0', solAmount: '0' };
        }
    }

    findMintInInnerInstructions(tx) {
        const innerInstructions = tx.meta?.innerInstructions || [];
        for (const innerGroup of innerInstructions) {
            for (const instruction of innerGroup.instructions || []) {
                if (instruction.parsed?.type === 'initializeMint' || instruction.parsed?.type === 'initializeMint2') {
                    const mint = instruction.parsed.info?.mint;
                    if (mint && this.isValidSolanaAddress(mint)) {
                        return mint;
                    }
                }
            }
        }
        return null;
    }

    findMintInTokenBalances(tx) {
        const postTokenBalances = tx.meta?.postTokenBalances || [];
        for (const balance of postTokenBalances) {
            if (balance.mint && this.isValidSolanaAddress(balance.mint)) {
                return balance.mint;
            }
        }
        return null;
    }

    findMintInAccountKeys(accountKeys) {
        for (let i = 2; i < Math.min(accountKeys.length, 6); i++) {
            const account = accountKeys[i];
            const address = typeof account === 'string' ? account :
                account?.toString?.() || account?.pubkey?.toString();
            if (address && this.isValidSolanaAddress(address)) {
                return address;
            }
        }
        return null;
    }

    parseMetadataAccount(data) {
        try {
            let offset = 1;
            offset += 32;
            offset += 32;

            if (data.length > offset) {
                const nameLen = data.readUInt32LE(offset);
                offset += 4;
                const name = data.slice(offset, offset + nameLen).toString('utf8').replace(/\0/g, '');
                offset += nameLen;

                const symbolLen = data.readUInt32LE(offset);
                offset += 4;
                const symbol = data.slice(offset, offset + symbolLen).toString('utf8').replace(/\0/g, '');
                offset += symbolLen;

                const uriLen = data.readUInt32LE(offset);
                offset += 4;
                const uri = data.slice(offset, offset + uriLen).toString('utf8').replace(/\0/g, '');

                return { name, symbol, uri };
            }
        } catch (error) {
            console.error('Error parsing metadata:', error);
        }
        return null;
    }

    async fetchIPFSJson(uri) {
        const candidates = [];

        if (uri.startsWith("ipfs://")) {
            const path = uri.replace("ipfs://", "");
            candidates.push(`https://ipfs.io/ipfs/${path}`);
            candidates.push(`https://cloudflare-ipfs.com/ipfs/${path}`);
        } else if (uri.startsWith("ar://")) {
            const path = uri.replace("ar://", "");
            candidates.push(`https://arweave.net/${path}`);
        } else {
            candidates.push(uri);
        }

        for (const url of candidates) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                const res = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (res.ok) {
                    const jsonData = await res.json();
                    return { ok: true, json: jsonData, url };
                }
            } catch (e) {
                // Try next gateway
            }
        }
        throw new Error("All gateways failed");
    }

    isValidSolanaAddress(address) {
        if (typeof address !== 'string') return false;
        if (address.length < 32 || address.length > 44) return false;
        const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
        return base58Regex.test(address);
    }

    // Twitter extraction helpers
    extractTwitterType(twitterUrl) {
        if (!twitterUrl) return null;
        if (twitterUrl.includes('/status/')) return 'tweet';
        if (twitterUrl.includes('/communities/')) return 'community';
        if (twitterUrl.includes('twitter.com/') || twitterUrl.includes('x.com/')) return 'individual';
        return 'individual';
    }

    extractTwitterHandle(twitterUrl) {
        if (!twitterUrl) return null;
        const tweetMatch = twitterUrl.match(/(?:twitter\.com\/|x\.com\/)([a-zA-Z0-9_]+)\/status\//i);
        if (tweetMatch) return tweetMatch[1].toLowerCase();
        const profileMatch = twitterUrl.match(/(?:twitter\.com\/|x\.com\/)(?!i\/communities\/)([a-zA-Z0-9_]+)/i);
        if (profileMatch) return profileMatch[1].toLowerCase();
        return null;
    }

    extractTwitterCommunityId(twitterUrl) {
        if (!twitterUrl) return null;
        const match = twitterUrl.match(/\/communities\/(\d+)/i);
        return match ? match[1] : null;
    }

    extractTwitterAdmin(twitterUrl) {
        const handle = this.extractTwitterHandle(twitterUrl);
        const communityId = this.extractTwitterCommunityId(twitterUrl);
        return handle || communityId || null;
    }

    stop() {
        if (this.pumpFunSubscriptionId) {
            this.connection.removeOnLogsListener(this.pumpFunSubscriptionId);
        }
        if (this.letsBonkSubscriptionId) {
            this.connection.removeOnLogsListener(this.letsBonkSubscriptionId);
        }
        console.log('🛑 Blockchain listener stopped');
    }
}

module.exports = { BlockchainTokenListener };