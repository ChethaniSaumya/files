const { Connection, PublicKey } = require('@solana/web3.js');
const grpc = require('@triton-one/yellowstone-grpc');
const bs58 = require('bs58');
const dotenv = require("dotenv");

dotenv.config();

// Constants
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const RAYDIUM_LAUNCHLAB_PROGRAM = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
const LETSBONK_PLATFORM_CONFIG = new PublicKey('FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// gRPC Client Setup
const GRPC_ENDPOINT = "http://grpc.solanavibestation.com:10000";

class BlockchainTokenListener {
    constructor(onTokenCallback) {
        this.onTokenCallback = onTokenCallback;
        this.grpcClient = null;
        this.grpcStream = null;
        this.isGrpcConnected = false;
        this.reconnecting = false;
        this.isSubscribed = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.pingInterval = null;

        this.recentSignatures = new Map();
        this.recentMints = new Map();
        this.processingTokens = new Set();

        console.log('🚀 Blockchain listener initialized');
    }

    async start() {
        console.log('🔗 Starting blockchain listeners...');
        await this.initGrpcClient();
        await this.subscribeToGrpcUpdates();
        console.log('✅ Blockchain listeners started');
    }

    async initGrpcClient() {
        try {
            if (this.grpcClient) {
                console.log("⚠️ gRPC client already exists, reusing...");
                return true;
            }

            this.grpcClient = new grpc.default(
                GRPC_ENDPOINT,
                undefined
            );

            console.log("✅ gRPC client initialized");
            this.isGrpcConnected = true;
            this.reconnectAttempts = 0;
            return true;
        } catch (error) {
            console.error("❌ Failed to initialize gRPC client:", error);
            this.isGrpcConnected = false;
            return false;
        }
    }

    async subscribeToGrpcUpdates() {
        if (this.isSubscribed) {
            console.log("⚠️ Already subscribed, skipping...");
            return;
        }

        if (!this.grpcClient) {
            console.error("❌ gRPC client not initialized");
            return;
        }

        try {
            this.grpcStream = await this.grpcClient.subscribe();
            this.isSubscribed = true;

            console.log("🔌 gRPC stream created");

            this.grpcStream.on("data", (data) => {
                this.handleGrpcUpdate(data);
            });

            this.grpcStream.on("error", (error) => {
                console.error("❌ gRPC stream error:", error.message);

                if (error.message.includes('serialization')) {
                    console.error("⚠️ Serialization error - check request format");
                    return;
                }

                this.isGrpcConnected = false;
                this.isSubscribed = false;

                if (!this.reconnecting && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.scheduleReconnect();
                } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                    console.error("❌ Max reconnection attempts reached. Manual restart required.");
                }
            });

            this.grpcStream.on("end", () => {
                console.log("⚠️ gRPC stream ended");
                this.isGrpcConnected = false;
                this.isSubscribed = false;

                if (!this.reconnecting && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.scheduleReconnect();
                }
            });

            const request = {
                accounts: {},
                slots: {},
                transactions: {
                    "pumpFun": {
                        vote: false,
                        failed: false,
                        accountInclude: [PUMP_FUN_PROGRAM.toString()],
                        accountExclude: [],
                        accountRequired: []
                    },
                    "raydiumLaunchlab": {
                        vote: false,
                        failed: false,
                        accountInclude: [RAYDIUM_LAUNCHLAB_PROGRAM.toString()],
                        accountExclude: [],
                        accountRequired: []
                    }
                },
                transactionsStatus: {},
                blocks: {},
                blocksMeta: {},
                entry: {},
                commitment: 1,
                accountsDataSlice: []
            };

            this.grpcStream.write(request);
            console.log("✅ gRPC subscription request sent for pump.fun and Raydium LaunchLab");
            console.log(`🔍 DEBUG - PUMP.FUN Program ID: ${PUMP_FUN_PROGRAM.toString()}`);
            console.log(`🔍 DEBUG - RAYDIUM LAUNCHLAB Program ID: ${RAYDIUM_LAUNCHLAB_PROGRAM.toString()}`);

            this.startPingInterval();

        } catch (error) {
            console.error("❌ Failed to subscribe to gRPC updates:", error);
            this.isGrpcConnected = false;
            this.isSubscribed = false;

            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.scheduleReconnect();
            }
        }
    }

    extractBondingCurveStateFromTransaction(grpcTransaction, bondingCurvePubkey) {
        try {
            console.log('📊 Extracting bonding curve state from transaction data...');

            if (grpcTransaction.transaction && grpcTransaction.transaction.meta) {
                const meta = grpcTransaction.transaction.meta;
                const accountKeys = grpcTransaction.transaction.message?.accountKeys || [];

                let bondingCurveIndex = -1;
                for (let i = 0; i < accountKeys.length; i++) {
                    const key = accountKeys[i];
                    let keyStr;

                    if (typeof key === 'string') {
                        keyStr = key;
                    } else if (Buffer.isBuffer(key)) {
                        keyStr = new PublicKey(key).toString();
                    } else if (key.pubkey) {
                        keyStr = key.pubkey.toString();
                    } else {
                        keyStr = key.toString();
                    }

                    if (keyStr === bondingCurvePubkey.toString()) {
                        bondingCurveIndex = i;
                        break;
                    }
                }

                if (bondingCurveIndex !== -1 && meta.postBalances && meta.postBalances[bondingCurveIndex]) {
                    const solBalance = meta.postBalances[bondingCurveIndex];
                    const tokenBalance = meta.postTokenBalances?.find(
                        tb => tb.accountIndex === bondingCurveIndex
                    );

                    if (tokenBalance) {
                        return {
                            virtualSolReserves: BigInt(solBalance || 30000000000),
                            virtualTokenReserves: BigInt(tokenBalance.uiTokenAmount?.amount || 1000000000),
                            realSolReserves: BigInt(solBalance || 30000000000),
                            realTokenReserves: BigInt(tokenBalance.uiTokenAmount?.amount || 1000000000),
                            fromTransaction: true
                        };
                    }
                }
            }

            console.log('⚠️ Could not extract bonding curve from transaction, using defaults');
            return null;

        } catch (error) {
            console.log('⚠️ Error extracting bonding curve from transaction:', error.message);
            return null;
        }
    }

    scheduleReconnect() {
        if (this.reconnecting) {
            console.log("⏳ Reconnection already scheduled, skipping...");
            return;
        }

        this.reconnecting = true;
        this.reconnectAttempts++;

        const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000);

        console.log(`⏳ Scheduling reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);

        setTimeout(async () => {
            this.reconnecting = false;

            if (this.grpcStream) {
                try {
                    this.grpcStream.end();
                } catch (e) {
                    // Ignore cleanup errors
                }
                this.grpcStream = null;
            }

            if (!this.grpcClient || !this.isGrpcConnected) {
                this.grpcClient = null;
                await this.initGrpcClient();
            }

            if (this.isGrpcConnected) {
                await this.subscribeToGrpcUpdates();
            }
        }, delay);
    }

    startPingInterval() {
        this.stopPingInterval();

        this.pingInterval = setInterval(() => {
            if (this.grpcStream && this.isGrpcConnected && this.isSubscribed) {
                try {
                    const pingRequest = {
                        ping: { id: Date.now() }
                    };
                    this.grpcStream.write(pingRequest);
                    console.log("📡 Ping sent to keep connection alive");
                } catch (error) {
                    console.error("❌ Failed to send ping:", error.message);
                }
            }
        }, 30000);

        console.log("✅ Ping interval started (30s)");
    }

    stopPingInterval() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
            console.log("🛑 Ping interval stopped");
        }
    }

    handleGrpcUpdate(data) {
        try {
            if (data.transaction) {
                this.handleTransactionUpdate(data.transaction);
            } else if (data.slot) {
                // Handle slot updates if needed
            } else if (data.pong) {
                console.log("🏓 Received Pong response - connection alive");
            }
        } catch (error) {
            console.error("❌ Error handling gRPC update:", error);
        }
    }

    handleTransactionUpdate(transactionUpdate) {
        try {
            const transaction = transactionUpdate.transaction;
            let signature = transaction.signature;

            if (!signature) return;

            let signatureStr;
            if (Buffer.isBuffer(signature)) {
                signatureStr = bs58.encode(signature);
            } else if (typeof signature === 'string') {
                signatureStr = signature;
            } else {
                console.log('Unknown signature type:', typeof signature);
                return;
            }

            console.log(`🔍 DEBUG - Processing transaction: ${signatureStr.substring(0, 12)}...`);

            let platform = null;

            if (transaction.transaction && transaction.transaction.message) {
                const message = transaction.transaction.message;
                const accountKeys = message.accountKeys || [];

                console.log(`🔍 DEBUG - Account keys count: ${accountKeys.length}`);

                const accountKeyStrings = accountKeys.map(key => {
                    if (typeof key === 'string') return key;
                    if (Buffer.isBuffer(key)) return new PublicKey(key).toString();
                    if (key.pubkey) return key.pubkey.toString();
                    return key.toString();
                });

                console.log(`🔍 DEBUG - Looking for program IDs in ALL account keys...`);

                for (let i = 0; i < accountKeyStrings.length; i++) {
                    const key = accountKeyStrings[i];

                    if (key === PUMP_FUN_PROGRAM.toString()) {
                        platform = 'pump.fun';
                        console.log(`✅ DEBUG - Found PUMP.FUN program at index ${i}: ${key}`);
                        break;
                    } else if (key === RAYDIUM_LAUNCHLAB_PROGRAM.toString()) {
                        platform = 'raydium';
                        console.log(`✅ DEBUG - Found RAYDIUM LAUNCHLAB program at index ${i}: ${key}`);

                        // ✅ ADDED: Check if this is a Bonk token by looking for Bonk Platform Config
                        for (let j = 0; j < accountKeyStrings.length; j++) {
                            if (accountKeyStrings[j] === LETSBONK_PLATFORM_CONFIG.toString()) {
                                platform = 'letsbonk';
                                console.log(`🎯 BONK TOKEN DETECTED - Raydium LaunchLab + Bonk Platform Config`);
                                break;
                            }
                        }
                        break;
                    }
                }

                if (!platform && transaction.meta && transaction.meta.loadedAddresses) {
                    console.log(`🔍 DEBUG - Checking loaded addresses...`);

                    if (transaction.meta.loadedAddresses.writable) {
                        for (const loadedAccount of transaction.meta.loadedAddresses.writable) {
                            const loadedKey = this.safeAccountKeyToString(loadedAccount.pubkey);

                            if (loadedKey === PUMP_FUN_PROGRAM.toString()) {
                                platform = 'pump.fun';
                                console.log(`✅ DEBUG - Found PUMP.FUN program in loaded writable addresses: ${loadedKey}`);
                                break;
                            } else if (loadedKey === RAYDIUM_LAUNCHLAB_PROGRAM.toString()) {
                                platform = 'raydium';
                                console.log(`✅ DEBUG - Found RAYDIUM LAUNCHLAB program in loaded writable addresses: ${loadedKey}`);

                                // ✅ ADDED: Check loaded addresses for Bonk Platform Config
                                for (const loadedAcc of transaction.meta.loadedAddresses.writable) {
                                    const loadedKey2 = this.safeAccountKeyToString(loadedAcc.pubkey);
                                    if (loadedKey2 === LETSBONK_PLATFORM_CONFIG.toString()) {
                                        platform = 'letsbonk';
                                        console.log(`🎯 BONK TOKEN DETECTED - Raydium LaunchLab + Bonk Platform Config in loaded addresses`);
                                        break;
                                    }
                                }
                                break;
                            }
                        }
                    }

                    if (!platform && transaction.meta.loadedAddresses.readonly) {
                        for (const loadedAccount of transaction.meta.loadedAddresses.readonly) {
                            const loadedKey = this.safeAccountKeyToString(loadedAccount.pubkey);

                            if (loadedKey === PUMP_FUN_PROGRAM.toString()) {
                                platform = 'pump.fun';
                                console.log(`✅ DEBUG - Found PUMP.FUN program in loaded readonly addresses: ${loadedKey}`);
                                break;
                            } else if (loadedKey === RAYDIUM_LAUNCHLAB_PROGRAM.toString()) {
                                platform = 'raydium';
                                console.log(`✅ DEBUG - Found RAYDIUM LAUNCHLAB program in loaded readonly addresses: ${loadedKey}`);

                                // ✅ ADDED: Check loaded addresses for Bonk Platform Config
                                for (const loadedAcc of transaction.meta.loadedAddresses.readonly) {
                                    const loadedKey2 = this.safeAccountKeyToString(loadedAcc.pubkey);
                                    if (loadedKey2 === LETSBONK_PLATFORM_CONFIG.toString()) {
                                        platform = 'letsbonk';
                                        console.log(`🎯 BONK TOKEN DETECTED - Raydium LaunchLab + Bonk Platform Config in loaded readonly addresses`);
                                        break;
                                    }
                                }
                                break;
                            }
                        }
                    }
                }
            }

            if (!platform && transaction.transaction && transaction.transaction.message && transaction.transaction.message.instructions) {
                console.log(`🔍 DEBUG - Checking instruction data...`);
                const accountKeyStrings = transaction.transaction.message.accountKeys.map(key => {
                    if (typeof key === 'string') return key;
                    if (Buffer.isBuffer(key)) return new PublicKey(key).toString();
                    if (key.pubkey) return key.pubkey.toString();
                    return key.toString();
                });

                for (let i = 0; i < transaction.transaction.message.instructions.length; i++) {
                    const instruction = transaction.transaction.message.instructions[i];
                    const programIdIndex = instruction.programIdIndex;
                    if (programIdIndex !== undefined && accountKeyStrings[programIdIndex]) {
                        const programId = accountKeyStrings[programIdIndex];
                        console.log(`   Instruction ${i} program ID: ${programId}`);

                        if (programId === PUMP_FUN_PROGRAM.toString()) {
                            platform = 'pump.fun';
                            console.log(`✅ DEBUG - Found PUMP.FUN program in instruction data: ${programId}`);
                            break;
                        } else if (programId === RAYDIUM_LAUNCHLAB_PROGRAM.toString()) {
                            platform = 'raydium';
                            console.log(`✅ DEBUG - Found RAYDIUM LAUNCHLAB program in instruction data: ${programId}`);

                            // ✅ ADDED: Check if this is a Bonk token
                            for (const key of accountKeyStrings) {
                                if (key === LETSBONK_PLATFORM_CONFIG.toString()) {
                                    platform = 'letsbonk';
                                    console.log(`🎯 BONK TOKEN DETECTED - Raydium LaunchLab instruction + Bonk Platform Config`);
                                    break;
                                }
                            }
                            break;
                        }
                    }
                }
            }

            if (platform) {
                console.log(`🟣 ${platform} transaction detected: ${signatureStr.substring(0, 12)}...`);

                const logs = {
                    signature: signatureStr,
                    logs: transaction.meta?.logMessages || []
                };

                this.handleTokenCreation(logs, platform, transaction);
            } else {
                console.log(`❌ NO PLATFORM IDENTIFIED for transaction: ${signatureStr.substring(0, 12)}...`);
                console.log(`❌ This transaction will be IGNORED - cannot process without knowing platform!`);
            }
        } catch (error) {
            console.error("❌ Error handling transaction update:", error);
        }
    }

    safeAccountKeyToString(key) {
        try {
            if (!key) return 'unknown';
            if (typeof key === 'string') return key;
            if (Buffer.isBuffer(key)) return new PublicKey(key).toString();
            if (key.pubkey) return key.pubkey.toString();
            if (key.toString) return key.toString();
            return String(key);
        } catch (error) {
            console.log(`❌ Error converting account key:`, key);
            return 'unknown';
        }
    }

    async handleTokenCreation(logs, platform, grpcTransaction) {
        const signature = logs.signature;

        if (this.recentSignatures.has(signature)) {
            return;
        }
        this.recentSignatures.set(signature, Date.now());

        const logMessages = logs.logs || [];

        // ✅ IMPROVED: Better detection for Bonk tokens
        const isTokenCreation = logMessages.some(log =>
            log.includes('Instruction: Create') ||
            log.includes('initializeMint') ||
            log.includes('initialize_v2') ||
            log.includes('Instruction: InitializeV2') ||
            log.includes('initializeMint2') ||
            log.includes('Create pool') ||
            (log.includes('Instruction:') && log.includes('Create')) ||
            (platform === 'letsbonk' && (
                log.includes('Initialize') ||
                log.includes('initialize') ||
                log.includes('Create') ||
                log.includes('create')
            ))
        );

        if (!isTokenCreation) {
            console.log(`❌ Not a token creation transaction for platform: ${platform}`);
            return;
        }

        console.log(`🟣 ${platform} token detected: ${signature.substring(0, 12)}...`);

        setTimeout(() => {
            this.processTokenImmediately(signature, platform, grpcTransaction);
        }, 100);
    }

    async processTokenImmediately(signature, platform, grpcTransaction) {
        if (this.processingTokens.has(signature)) {
            return;
        }
        this.processingTokens.add(signature);

        console.log(`⚡ Processing: ${signature.substring(0, 12)}... (using gRPC data - ULTRA FAST)`);

        try {
            const tokenData = await this.extractCompleteTokenDataFromGrpc(grpcTransaction, signature, platform);

            if (tokenData) {
                console.log(`🎯 TOKEN DATA READY - SENDING TO SERVER:`);
                console.log(`   Platform: ${tokenData.platform}`);
                console.log(`   Pool: ${tokenData.pool}`);
                console.log(`   Mint: ${tokenData.mint}`);
                console.log(`   Name: ${tokenData.name}`);

                await this.onTokenCallback(tokenData);
                console.log(`✅ Data sent to server`);
            } else {
                console.log(`❌ No token data extracted`);
            }

        } catch (error) {
            console.log(`❌ Processing error: ${error.message}`);
            console.error(error.stack);
        } finally {
            this.processingTokens.delete(signature);
        }
    }

    async extractCompleteTokenDataFromGrpc(grpcTransaction, signature, platform) {
        try {
            let accountKeys = [];

            if (grpcTransaction.transaction && grpcTransaction.transaction.message) {
                const message = grpcTransaction.transaction.message;
                accountKeys = (message.accountKeys || []).map(key => {
                    if (typeof key === 'string') return new PublicKey(key);
                    if (Buffer.isBuffer(key)) return new PublicKey(key);
                    if (key.pubkey) return new PublicKey(key.pubkey);
                    return new PublicKey(key.toString());
                });
            }

            console.log(`🔍 Extracted ${accountKeys.length} account keys from gRPC`);

            let isBonkToken = platform === 'letsbonk';
            if (!isBonkToken) {
                const accountKeyStrings = accountKeys.map(key => key.toString());
                for (const key of accountKeyStrings) {
                    if (key === LETSBONK_PLATFORM_CONFIG.toString()) {
                        isBonkToken = true;
                        console.log(`🎯 CONFIRMED BONK TOKEN LAUNCH`);
                        break;
                    }
                }
            }

            let creatorAddress = 'Unknown';
            if (accountKeys.length > 0 && accountKeys[0]) {
                creatorAddress = accountKeys[0].toString();
            }
            console.log(`👤 Creator: ${creatorAddress}`);

            let mint = this.findMintInGrpcTransaction(grpcTransaction, platform);

            if (!mint) {
                console.log('❌ No mint address found in gRPC transaction');
                return null;
            }

            console.log(`✅ Found mint: ${mint.substring(0, 16)}...`);

            if (this.recentMints.has(mint)) {
                console.log(`↩ Already processed mint`);
                return null;
            }
            this.recentMints.set(mint, Date.now());

            const mintPublicKey = new PublicKey(mint);

            let normalizedPlatform = platform;
            if (platform === 'pump.fun') {
                normalizedPlatform = 'pumpfun';
            } else if (platform === 'letsbonk') {
                normalizedPlatform = 'letsbonk';
            } else if (platform === 'raydium' && isBonkToken) {
                normalizedPlatform = 'letsbonk';
            }

            console.log(`🔄 Platform normalized: ${platform} -> ${normalizedPlatform}`);

            let bondingCurveAddress = null;
            let bondingCurveState = null;

            if (normalizedPlatform === 'pumpfun') {
                const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), mintPublicKey.toBytes()],
                    PUMP_FUN_PROGRAM
                );
                bondingCurveAddress = bondingCurvePDA.toString();
                console.log(`📊 Bonding Curve: ${bondingCurveAddress}`);

                bondingCurveState = this.extractBondingCurveFromTransactionAccounts(grpcTransaction, bondingCurvePDA);

                if (bondingCurveState) {
                    console.log('✅ Bonding curve extracted from transaction (0ms)');
                } else {
                    console.log('⚠️ Bonding curve not in transaction, will fetch via RPC');
                }
            }

            let tokenInfo = this.extractTokenInfoFromGrpc(grpcTransaction, mint);
            console.log(`🪙 Token info: ${tokenInfo.supply} supply, ${tokenInfo.decimals} decimals`);

            const completeMetadata = this.extractMetadataFromGrpc(grpcTransaction);
            console.log(`📝 Metadata: ${completeMetadata.name} (${completeMetadata.symbol})`);

            const financialData = this.extractFinancialDataFromGrpc(grpcTransaction, normalizedPlatform);

            const blockTime = grpcTransaction.slot || null;

            const tokenData = {
                id: mint,
                mint: mint,
                name: completeMetadata.name,
                symbol: completeMetadata.symbol,
                description: completeMetadata.description,
                image: completeMetadata.image,
                metadataUri: completeMetadata.uri,

                marketCap: bondingCurveState?.marketCap || financialData.marketCap,
                marketCapSol: parseFloat(bondingCurveState?.marketCap || financialData.marketCap || 0),
                price: bondingCurveState?.price || financialData.price,
                liquidity: bondingCurveState?.liquidity || financialData.liquidity,
                solAmount: parseFloat(bondingCurveState?.solAmount || financialData.solAmount || 0),
                totalSupply: tokenInfo.supply,
                decimals: tokenInfo.decimals,

                creator: creatorAddress,
                traderPublicKey: creatorAddress,
                creatorWallet: creatorAddress,
                creatorProfile: null,

                twitter: completeMetadata.twitter,
                twitterType: this.extractTwitterType(completeMetadata.twitter),
                twitterHandle: this.extractTwitterHandle(completeMetadata.twitter),
                twitterCommunityId: this.extractTwitterCommunityId(completeMetadata.twitter),
                twitterAdmin: this.extractTwitterAdmin(completeMetadata.twitter),
                website: completeMetadata.website,
                telegram: completeMetadata.telegram,
                discord: completeMetadata.discord,

                platform: normalizedPlatform,
                created: blockTime ? new Date(blockTime * 1000).toISOString() : new Date().toISOString(),
                creationSignature: signature,

                bondingCurveAddress: bondingCurveAddress,
                bondingCurveKey: bondingCurveAddress,
                bondingCurveState: bondingCurveState,

                pool: normalizedPlatform === 'pumpfun' ? 'pump' : 'bonk',

                complete: true,
                metadataAlreadyFetched: true,
                featured: false,
                trending: false,
                verified: false,

                volume24h: '0',
                priceChange24h: '0',
                holders: '0',

                tokenProgram: TOKEN_PROGRAM_ID.toString(),
                associatedTokenAccount: this.calculateAssociatedTokenAccount(mintPublicKey, creatorAddress),

                tags: completeMetadata.tags || [],
                category: completeMetadata.category || 'meme',
                audit: completeMetadata.audit || 'unaudited',

                isBonkToken: isBonkToken,
                bonkLaunch: isBonkToken
            };

            return tokenData;

        } catch (error) {
            console.log(`❌ Extraction error: ${error.message}`);
            console.error(error);
            return null;
        }
    }

    extractBondingCurveFromTransactionAccounts(grpcTransaction, bondingCurvePubkey) {
        try {
            console.log('📊 Attempting to extract bonding curve state from transaction...');

            const meta = grpcTransaction.transaction?.meta;
            if (!meta) {
                console.log('❌ No transaction meta available');
                return null;
            }

            const accountKeys = grpcTransaction.transaction.message?.accountKeys || [];
            console.log(`🔍 Checking ${accountKeys.length} account keys for bonding curve`);

            let bondingCurveIndex = -1;
            for (let i = 0; i < accountKeys.length; i++) {
                const keyStr = this.safeAccountKeyToString(accountKeys[i]);
                if (keyStr === bondingCurvePubkey.toString()) {
                    bondingCurveIndex = i;
                    console.log(`✅ Found bonding curve at account index: ${i}`);
                    break;
                }
            }

            if (bondingCurveIndex === -1) {
                console.log('❌ Bonding curve not found in transaction accounts');
                return null;
            }

            if (meta.loadedAddresses && meta.loadedAddresses.writable) {
                for (const loadedAccount of meta.loadedAddresses.writable) {
                    const loadedKeyStr = this.safeAccountKeyToString(loadedAccount.pubkey);
                    if (loadedKeyStr === bondingCurvePubkey.toString()) {
                        console.log('✅ Found bonding curve in loaded addresses');
                        if (loadedAccount.data) {
                            const accountData = Buffer.from(loadedAccount.data);
                            return this.parseBondingCurveData(accountData);
                        }
                    }
                }
            }

            if (meta.postBalances && bondingCurveIndex < meta.postBalances.length) {
                console.log('📊 Extracting from postBalances...');
                const solBalance = meta.postBalances[bondingCurveIndex];
                const tokenBalance = meta.postTokenBalances?.find(
                    tb => tb.accountIndex === bondingCurveIndex
                );

                if (tokenBalance) {
                    console.log('✅ Found token balance for bonding curve');
                    return {
                        virtualSolReserves: BigInt(solBalance || 30000000000),
                        virtualTokenReserves: BigInt(tokenBalance.uiTokenAmount?.amount || 1000000000),
                        realSolReserves: BigInt(solBalance || 30000000000),
                        realTokenReserves: BigInt(tokenBalance.uiTokenAmount?.amount || 1000000000),
                        fromTransaction: true,
                        marketCap: (Number(solBalance) / 1000000000 * 2).toFixed(4),
                        liquidity: (Number(solBalance) / 1000000000).toFixed(4)
                    };
                }
            }

            console.log('❌ Could not extract bonding curve data from transaction');
            return null;

        } catch (error) {
            console.log('❌ Error extracting bonding curve from transaction:', error.message);
            return null;
        }
    }

    extractTokenInfoFromGrpc(grpcTransaction, mint) {
        try {
            if (grpcTransaction.meta && grpcTransaction.meta.postTokenBalances) {
                for (const balance of grpcTransaction.meta.postTokenBalances) {
                    if (balance.mint === mint) {
                        return {
                            supply: balance.uiTokenAmount?.amount || '1000000000',
                            decimals: balance.uiTokenAmount?.decimals || 6
                        };
                    }
                }
            }

            return {
                supply: '1000000000',
                decimals: 6
            };
        } catch (error) {
            console.log(`⚠️ Error extracting token info from gRPC: ${error.message}`);
            return {
                supply: '1000000000',
                decimals: 6
            };
        }
    }

    extractMetadataFromGrpc(grpcTransaction) {
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
            console.log('🔍 Starting metadata extraction from gRPC transaction...');

            // ✅ METHOD 1: Extract from logs first (most reliable for Bonk tokens)
            const logs = grpcTransaction.meta?.logMessages || [];
            console.log(`🔍 Checking ${logs.length} log messages for metadata...`);

            let foundInLogs = false;

            for (const log of logs) {
                // Look for base_mint_param patterns (Raydium specific) - MOST RELIABLE
                if (log.includes('base_mint_param')) {
                    console.log('🔍 Found base_mint_param in logs - extracting metadata...');

                    // Extract name
                    const nameMatch = log.match(/name:\s*["']?([^,"'\]]+)["']?/);
                    if (nameMatch && nameMatch[1].trim().length > 0) {
                        metadata.name = nameMatch[1].trim().replace(/['"]/g, '');
                        console.log(`✅ Extracted name from base_mint_param: ${metadata.name}`);
                        foundInLogs = true;
                    }

                    // Extract symbol with validation
                    const symbolMatch = log.match(/symbol:\s*["']?([^,"'\]]+)["']?/);
                    if (symbolMatch && symbolMatch[1].trim().length > 0) {
                        const rawSymbol = symbolMatch[1].trim().replace(/['"]/g, '');
                        // Validate symbol
                        if (this.isValidSymbol(rawSymbol)) {
                            metadata.symbol = rawSymbol;
                            console.log(`✅ Extracted symbol from base_mint_param: ${metadata.symbol}`);
                            foundInLogs = true;
                        } else {
                            console.log(`⚠️ Invalid symbol from base_mint_param: "${rawSymbol}"`);
                        }
                    }

                    // Extract URI
                    const uriMatch = log.match(/uri:\s*["']?([^,"'\]]+)["']?/);
                    if (uriMatch && uriMatch[1].trim().length > 0) {
                        metadata.uri = uriMatch[1].trim().replace(/['"]/g, '');
                        console.log(`✅ Extracted URI from base_mint_param: ${metadata.uri}`);
                        foundInLogs = true;
                    }
                }

                // Also check for general metadata patterns in logs
                if (log.includes('"name"') || log.includes("'name'")) {
                    const nameMatch = log.match(/["']name["']\s*:\s*["']([^"']+)["']/);
                    if (nameMatch && !foundInLogs) {
                        metadata.name = nameMatch[1];
                        console.log(`✅ Extracted name from logs: ${metadata.name}`);
                    }
                }

                if (log.includes('"symbol"') || log.includes("'symbol'")) {
                    const symbolMatch = log.match(/["']symbol["']\s*:\s*["']([^"']+)["']/);
                    if (symbolMatch && !foundInLogs) {
                        const rawSymbol = symbolMatch[1];
                        if (this.isValidSymbol(rawSymbol)) {
                            metadata.symbol = rawSymbol;
                            console.log(`✅ Extracted symbol from logs: ${metadata.symbol}`);
                        }
                    }
                }

                if (log.includes('"uri"') || log.includes("'uri'")) {
                    const uriMatch = log.match(/["']uri["']\s*:\s*["']([^"']+)["']/);
                    if (uriMatch && !foundInLogs) {
                        metadata.uri = uriMatch[1];
                        console.log(`✅ Extracted URI from logs: ${metadata.uri}`);
                    }
                }
            }

            // Only try other methods if we didn't find reliable data in logs
            if (!foundInLogs) {
                // ✅ METHOD 2: Check for metadata in instruction data
                if (grpcTransaction.transaction?.message?.instructions) {
                    console.log(`🔍 Checking ${grpcTransaction.transaction.message.instructions.length} instructions for metadata...`);

                    for (const instruction of grpcTransaction.transaction.message.instructions) {
                        if (instruction.data) {
                            try {
                                const data = Buffer.isBuffer(instruction.data) ?
                                    instruction.data : Buffer.from(instruction.data, 'base64');

                                console.log(`🔍 Instruction data length: ${data.length}`);

                                // ✅ Check if this is a Raydium LaunchLab initialize_v2 instruction
                                if (data.length > 100) { // Raydium instructions are larger
                                    const parsed = this.parseRaydiumMetadataFromInstruction(data);
                                    if (parsed.name && parsed.name !== 'Unknown' && !metadata.name || metadata.name === 'Unknown') {
                                        metadata.name = parsed.name;
                                        console.log(`✅ Extracted name from Raydium instruction: ${metadata.name}`);
                                    }
                                    if (parsed.symbol && parsed.symbol !== 'UNKNOWN' && this.isValidSymbol(parsed.symbol) && (!metadata.symbol || metadata.symbol === 'UNKNOWN')) {
                                        metadata.symbol = parsed.symbol;
                                        console.log(`✅ Extracted symbol from Raydium instruction: ${metadata.symbol}`);
                                    }
                                    if (parsed.uri && (!metadata.uri || !metadata.uri.includes('unknown'))) {
                                        metadata.uri = parsed.uri;
                                        console.log(`✅ Extracted URI from Raydium instruction: ${metadata.uri}`);
                                    }
                                }

                                // ✅ Also check for Metaplex metadata instructions
                                if (data.length > 0 && data[0] === 33) { // createMetadataAccountV3 discriminator
                                    const parsed = this.parseMetaplexMetadataFromInstruction(data);
                                    if (parsed.name && parsed.name !== 'Unknown' && (!metadata.name || metadata.name === 'Unknown')) {
                                        metadata.name = parsed.name;
                                        console.log(`✅ Extracted name from Metaplex instruction: ${metadata.name}`);
                                    }
                                    if (parsed.symbol && parsed.symbol !== 'UNKNOWN' && this.isValidSymbol(parsed.symbol) && (!metadata.symbol || metadata.symbol === 'UNKNOWN')) {
                                        metadata.symbol = parsed.symbol;
                                        console.log(`✅ Extracted symbol from Metaplex instruction: ${metadata.symbol}`);
                                    }
                                    if (parsed.uri && (!metadata.uri || !metadata.uri.includes('unknown'))) {
                                        metadata.uri = parsed.uri;
                                        console.log(`✅ Extracted URI from Metaplex instruction: ${metadata.uri}`);
                                    }
                                }
                            } catch (e) {
                                console.log(`⚠️ Error parsing instruction data: ${e.message}`);
                            }
                        }
                    }
                }

                // ✅ METHOD 3: Extract from inner instructions (where metadata often is)
                if (grpcTransaction.meta?.innerInstructions) {
                    console.log(`🔍 Checking ${grpcTransaction.meta.innerInstructions.length} inner instruction sets...`);

                    for (const innerInstSet of grpcTransaction.meta.innerInstructions) {
                        const instructions = innerInstSet.instructions || [];

                        for (const innerInst of instructions) {
                            if (innerInst.parsed && innerInst.parsed.info) {
                                // Look for createMetadataAccountV3 in inner instructions
                                if (innerInst.parsed.type === 'createMetadataAccountV3') {
                                    const info = innerInst.parsed.info;
                                    if (info.data) {
                                        const data = info.data;
                                        if (data.name && (!metadata.name || metadata.name === 'Unknown')) {
                                            metadata.name = data.name;
                                            console.log(`✅ Extracted name from inner createMetadata: ${metadata.name}`);
                                        }
                                        if (data.symbol && this.isValidSymbol(data.symbol) && (!metadata.symbol || metadata.symbol === 'UNKNOWN')) {
                                            metadata.symbol = data.symbol;
                                            console.log(`✅ Extracted symbol from inner createMetadata: ${metadata.symbol}`);
                                        }
                                        if (data.uri && (!metadata.uri || !metadata.uri.includes('unknown'))) {
                                            metadata.uri = data.uri;
                                            console.log(`✅ Extracted URI from inner createMetadata: ${metadata.uri}`);
                                        }
                                    }
                                }
                            }

                            // Also check instruction data in inner instructions
                            if (innerInst.data) {
                                try {
                                    const data = Buffer.isBuffer(innerInst.data) ?
                                        innerInst.data : Buffer.from(innerInst.data, 'base64');

                                    if (data.length > 0 && data[0] === 33) { // createMetadataAccountV3
                                        const parsed = this.parseMetaplexMetadataFromInstruction(data);
                                        if (parsed.name && parsed.name !== 'Unknown' && (!metadata.name || metadata.name === 'Unknown')) {
                                            metadata.name = parsed.name;
                                            console.log(`✅ Extracted name from inner instruction data: ${metadata.name}`);
                                        }
                                        if (parsed.symbol && parsed.symbol !== 'UNKNOWN' && this.isValidSymbol(parsed.symbol) && (!metadata.symbol || metadata.symbol === 'UNKNOWN')) {
                                            metadata.symbol = parsed.symbol;
                                            console.log(`✅ Extracted symbol from inner instruction data: ${metadata.symbol}`);
                                        }
                                        if (parsed.uri && (!metadata.uri || !metadata.uri.includes('unknown'))) {
                                            metadata.uri = parsed.uri;
                                            console.log(`✅ Extracted URI from inner instruction data: ${metadata.uri}`);
                                        }
                                    }
                                } catch (e) {
                                    // Skip parsing errors
                                }
                            }
                        }
                    }
                }
            }

            // ✅ IMPROVED: Final validation with stricter rules
            if (!this.isValidSymbol(metadata.symbol) || metadata.symbol === 'UNKNOWN' || metadata.symbol.length < 2) {
                console.log(`⚠️ Final symbol validation failed: "${metadata.symbol}" - setting to UNKNOWN`);
                metadata.symbol = 'UNKNOWN';
            }

            console.log(`📝 Final metadata: ${metadata.name} (${metadata.symbol}) - URI: ${metadata.uri}`);

        } catch (error) {
            console.log(`⚠️ Error extracting metadata from gRPC: ${error.message}`);
        }

        return metadata;
    }

    isValidSymbol(symbol) {
        if (!symbol || typeof symbol !== 'string') return false;

        // Remove any null characters and trim
        const cleanSymbol = symbol.replace(/\0/g, '').trim();

        // Check length - require at least 2 characters
        if (cleanSymbol.length < 2 || cleanSymbol.length > 10) return false;

        // ✅ STRICTER: Only allow alphanumeric and very common symbols
        const validSymbolRegex = /^[a-zA-Z0-9\$\€\£\¥\₿\s\-_.+*&@!#%]+$/;

        // ✅ ADDITIONAL: Check for common garbage patterns
        const garbagePatterns = [
            /\$&/,  // Your specific garbage pattern
            /^[^a-zA-Z0-9]+$/, // Only symbols, no letters/numbers
            /[^\x20-\x7E]/, // Non-printable characters
        ];

        for (const pattern of garbagePatterns) {
            if (pattern.test(cleanSymbol)) {
                return false;
            }
        }

        return validSymbolRegex.test(cleanSymbol);
    }

    parseRaydiumMetadataFromInstruction(data) {
        const parsed = { name: null, symbol: null, uri: null };

        try {
            console.log('🔍 Parsing Raydium instruction data...');

            // Look for string patterns in the data
            const dataString = data.toString('utf8');

            // ✅ IMPROVED: Look for structured data patterns instead of random strings
            // Try to find name and symbol in more structured way
            const structuredMatch = dataString.match(/name[\x00\s]*([\x20-\x7E]{2,20})[\x00\s]*symbol[\x00\s]*([\x20-\x7E]{2,10})/);
            if (structuredMatch) {
                parsed.name = structuredMatch[1].replace(/\0/g, '').trim();
                const potentialSymbol = structuredMatch[2].replace(/\0/g, '').trim();
                if (this.isValidSymbol(potentialSymbol)) {
                    parsed.symbol = potentialSymbol;
                }
            } else {
                // Fallback: Try to extract reasonable strings
                const nameMatch = dataString.match(/[\x20-\x7E]{3,20}/);
                if (nameMatch && !nameMatch[0].includes('Raydium') && !nameMatch[0].includes('Token')) {
                    parsed.name = nameMatch[0].replace(/\0/g, '').trim();
                }

                // Look for symbol with validation
                const symbolMatch = dataString.match(/[\x20-\x7E]{2,10}/);
                if (symbolMatch && symbolMatch[0] !== parsed.name) {
                    const potentialSymbol = symbolMatch[0].replace(/\0/g, '').trim();
                    if (this.isValidSymbol(potentialSymbol)) {
                        parsed.symbol = potentialSymbol;
                    }
                }
            }

            // Look for URI patterns
            const uriMatch = dataString.match(/https?:\/\/[^\s\0]+/);
            if (uriMatch) {
                parsed.uri = uriMatch[0].replace(/\0/g, '').trim();
            }

        } catch (error) {
            console.log(`⚠️ Error parsing Raydium metadata: ${error.message}`);
        }

        return parsed;
    }

    parseMetaplexMetadataFromInstruction(data) {
        const parsed = { name: null, symbol: null, uri: null };

        try {
            console.log('🔍 Parsing Metaplex metadata instruction...');
            let offset = 8; // Skip discriminator

            // Parse name
            if (data.length > offset + 4) {
                const nameLen = data.readUInt32LE(offset);
                offset += 4;
                if (nameLen > 0 && nameLen < 100 && data.length >= offset + nameLen) {
                    parsed.name = data.slice(offset, offset + nameLen).toString('utf8').replace(/\0/g, '').trim();
                    offset += nameLen;
                    console.log(`📝 Found name: ${parsed.name} (length: ${nameLen})`);
                }
            }

            // Parse symbol - IMPROVED VALIDATION
            if (data.length > offset + 4) {
                const symbolLen = data.readUInt32LE(offset);
                offset += 4;
                if (symbolLen > 0 && symbolLen < 20 && data.length >= offset + symbolLen) {
                    const symbolData = data.slice(offset, offset + symbolLen);
                    const rawSymbol = symbolData.toString('utf8').replace(/\0/g, '').trim();

                    // ✅ STRICTER validation
                    if (this.isValidSymbol(rawSymbol)) {
                        parsed.symbol = rawSymbol;
                        console.log(`📝 Found symbol: ${parsed.symbol} (length: ${symbolLen})`);
                        offset += symbolLen;
                    } else {
                        console.log(`⚠️ Invalid symbol detected: "${rawSymbol}" - skipping`);
                    }
                }
            }

            // Parse URI
            if (data.length > offset + 4) {
                const uriLen = data.readUInt32LE(offset);
                offset += 4;
                if (uriLen > 0 && uriLen < 500 && data.length >= offset + uriLen) {
                    parsed.uri = data.slice(offset, offset + uriLen).toString('utf8').replace(/\0/g, '').trim();
                    console.log(`📝 Found URI: ${parsed.uri} (length: ${uriLen})`);
                }
            }

        } catch (error) {
            console.log(`⚠️ Error parsing Metaplex metadata: ${error.message}`);
        }

        return parsed;
    }

    parseMetadataFromInstructionData(data) {
        const parsed = { name: null, symbol: null, uri: null };

        try {
            let offset = 8;

            if (data.length > offset + 4) {
                const nameLen = data.readUInt32LE(offset);
                offset += 4;
                if (nameLen > 0 && nameLen < 100 && data.length >= offset + nameLen) {
                    parsed.name = data.slice(offset, offset + nameLen).toString('utf8').replace(/\0/g, '').trim();
                    offset += nameLen;
                }
            }

            if (data.length > offset + 4) {
                const symbolLen = data.readUInt32LE(offset);
                offset += 4;
                if (symbolLen > 0 && symbolLen < 20 && data.length >= offset + symbolLen) {
                    parsed.symbol = data.slice(offset, offset + symbolLen).toString('utf8').replace(/\0/g, '').trim();
                    offset += symbolLen;
                }
            }

            if (data.length > offset + 4) {
                const uriLen = data.readUInt32LE(offset);
                offset += 4;
                if (uriLen > 0 && uriLen < 500 && data.length >= offset + uriLen) {
                    parsed.uri = data.slice(offset, offset + uriLen).toString('utf8').replace(/\0/g, '').trim();
                }
            }
        } catch (error) {
            // Return what we have
        }

        return parsed;
    }

    extractFinancialDataFromGrpc(grpcTransaction, platform) {
        try {
            if (grpcTransaction.meta?.postBalances && grpcTransaction.meta?.preBalances) {
                const postBalances = grpcTransaction.meta.postBalances;
                const preBalances = grpcTransaction.meta.preBalances;

                for (let i = 0; i < postBalances.length; i++) {
                    const change = postBalances[i] - (preBalances[i] || 0);
                    if (change > 0) {
                        const solAmount = change / 1000000000;
                        const marketCap = solAmount * 2;
                        return {
                            marketCap: marketCap.toFixed(4),
                            price: '0.0000000001',
                            liquidity: solAmount.toFixed(4),
                            solAmount: solAmount.toFixed(4)
                        };
                    }
                }
            }

            return {
                marketCap: '0',
                price: '0',
                liquidity: '0',
                solAmount: '0'
            };
        } catch (error) {
            console.log(`⚠️ Error extracting financial data from gRPC: ${error.message}`);
            return {
                marketCap: '0',
                price: '0',
                liquidity: '0',
                solAmount: '0'
            };
        }
    }

    calculateAssociatedTokenAccount(mintPublicKey, creatorAddress) {
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

    findMintInGrpcTransaction(grpcTransaction, platform) {
        try {
            console.log('🔍 Searching for mint address in transaction...');

            // ✅ ADDED: List of tokens to exclude
            const EXCLUDED_MINTS = [
                'So11111111111111111111111111111111111111112', // WSOL
                'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
                'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',   // USD1
                'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
                // Add other system tokens as needed
            ];

            if (grpcTransaction.meta && grpcTransaction.meta.innerInstructions) {
                console.log(`🔍 Checking ${grpcTransaction.meta.innerInstructions.length} inner instruction sets...`);

                for (const innerInstSet of grpcTransaction.meta.innerInstructions) {
                    const instructions = innerInstSet.instructions || [];

                    for (const innerInst of instructions) {
                        if (innerInst.parsed && innerInst.parsed.type === 'initializeMint2') {
                            const mintAddress = innerInst.parsed.info?.mint;
                            if (mintAddress && this.isValidSolanaAddress(mintAddress) && !EXCLUDED_MINTS.includes(mintAddress)) {
                                console.log(`✅ Found mint in initializeMint2 inner instruction: ${mintAddress}`);
                                return mintAddress;
                            }
                        }

                        if (innerInst.parsed && innerInst.parsed.type === 'mintTo') {
                            const mintAddress = innerInst.parsed.info?.mint;
                            if (mintAddress && this.isValidSolanaAddress(mintAddress) && !EXCLUDED_MINTS.includes(mintAddress)) {
                                console.log(`✅ Found mint in mintTo inner instruction: ${mintAddress}`);
                                return mintAddress;
                            }
                        }
                    }
                }
            }

            if (grpcTransaction.meta && grpcTransaction.meta.postTokenBalances) {
                for (const balance of grpcTransaction.meta.postTokenBalances) {
                    if (balance.mint && this.isValidSolanaAddress(balance.mint) && !EXCLUDED_MINTS.includes(balance.mint)) {
                        if (platform === 'letsbonk' && balance.mint === 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB') {
                            continue;
                        }
                        console.log(`✅ Found mint in postTokenBalances: ${balance.mint}`);
                        return balance.mint;
                    }
                }
            }

            if (grpcTransaction.transaction && grpcTransaction.transaction.message) {
                const accountKeys = grpcTransaction.transaction.message.accountKeys || [];

                if (platform === 'pump.fun' || platform === 'pumpfun') {
                    for (let i = 2; i < Math.min(accountKeys.length, 6); i++) {
                        const key = accountKeys[i];
                        let address;
                        if (typeof key === 'string') {
                            address = key;
                        } else if (Buffer.isBuffer(key)) {
                            address = new PublicKey(key).toString();
                        } else if (key.pubkey) {
                            address = key.pubkey.toString();
                        } else {
                            address = key.toString();
                        }

                        if (this.isValidSolanaAddress(address) && !EXCLUDED_MINTS.includes(address)) {
                            return address;
                        }
                    }
                } else if (platform === 'letsbonk' || platform === 'raydium') {
                    if (accountKeys.length > 6) {
                        const baseMintKey = accountKeys[6];
                        const address = this.safeAccountKeyToString(baseMintKey);

                        if (this.isValidSolanaAddress(address) && !EXCLUDED_MINTS.includes(address) &&
                            address !== TOKEN_PROGRAM_ID.toString() &&
                            address !== RAYDIUM_LAUNCHLAB_PROGRAM.toString() &&
                            address !== PUMP_FUN_PROGRAM.toString() &&
                            address !== TOKEN_METADATA_PROGRAM_ID.toString() &&
                            address !== 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB') {
                            console.log(`✅ Found mint at account index 6 (Base Mint position): ${address}`);
                            return address;
                        }
                    }
                }
            }

            console.log('❌ Could not find mint in transaction');
            return null;
        } catch (error) {
            console.log(`⚠️ Error finding mint: ${error.message}`);
            return null;
        }
    }


    isValidSolanaAddress(address) {
        if (typeof address !== 'string') return false;
        if (address.length < 32 || address.length > 44) return false;
        const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
        return base58Regex.test(address);
    }

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

    async getAccountDataViaGrpc(publicKey) {
        try {
            console.log(`📡 Reading account via gRPC: ${publicKey.toString()}`);

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.grpcStream.off('data', dataHandler);
                    reject(new Error('Account read timeout after 3s'));
                }, 3000);

                let accountReceived = false;

                const dataHandler = (data) => {
                    if (data.account && data.account.account) {
                        const accountPubkey = data.account.account.pubkey ||
                            (data.account.pubkey ? new PublicKey(data.account.pubkey).toString() : null);

                        if (accountPubkey === publicKey.toString()) {
                            clearTimeout(timeout);
                            accountReceived = true;

                            const accountData = {
                                data: Buffer.from(data.account.account.data),
                                executable: data.account.account.executable,
                                lamports: data.account.account.lamports,
                                owner: new PublicKey(data.account.account.owner),
                                rentEpoch: data.account.account.rentEpoch || 0
                            };

                            this.grpcStream.off('data', dataHandler);
                            resolve(accountData);
                        }
                    }
                };

                this.grpcStream.on('data', dataHandler);

                const request = {
                    accounts: {
                        "account_read": {
                            account: [publicKey.toString()],
                            owner: [],
                            filters: []
                        }
                    },
                    slots: {},
                    transactions: {},
                    transactionsStatus: {},
                    blocks: {},
                    blocksMeta: {},
                    entry: {},
                    commitment: 1,
                    accountsDataSlice: []
                };

                this.grpcStream.write(request);
            });

        } catch (error) {
            console.error('❌ gRPC account read failed:', error);
            throw error;
        }
    }

    parseBondingCurveData(data) {
        try {
            console.log('📊 Parsing bonding curve data...');

            if (!data || data.length < 100) {
                console.log('❌ Invalid bonding curve data length');
                return null;
            }

            let offset = 8;

            const virtualTokenReserves = data.readBigUInt64LE(offset);
            offset += 8;

            const virtualSolReserves = data.readBigUInt64LE(offset);
            offset += 8;

            const realTokenReserves = data.readBigUInt64LE(offset);
            offset += 8;

            const realSolReserves = data.readBigUInt64LE(offset);
            offset += 8;

            const tokenTotalSupply = data.readBigUInt64LE(offset);
            offset += 8;

            const creator = new PublicKey(data.slice(41, 41 + 32));

            if (!virtualTokenReserves || !virtualSolReserves || virtualTokenReserves === 0n) {
                console.log('❌ Invalid bonding curve reserves');
                return null;
            }

            const solReservesInSOL = Number(virtualSolReserves) / 1000000000;
            const marketCapInSOL = solReservesInSOL * 2;
            const priceInSOL = virtualTokenReserves > 0 ?
                solReservesInSOL / (Number(virtualTokenReserves) / 1000000) : 0;

            console.log('✅ Bonding curve parsed:', {
                virtualTokenReserves: virtualTokenReserves.toString(),
                virtualSolReserves: virtualSolReserves.toString(),
                creator: creator.toBase58(),
                marketCap: marketCapInSOL.toFixed(4),
                liquidity: solReservesInSOL.toFixed(4)
            });

            return {
                virtualTokenReserves: virtualTokenReserves.toString(),
                virtualSolReserves: virtualSolReserves.toString(),
                realTokenReserves: realTokenReserves.toString(),
                realSolReserves: realSolReserves.toString(),
                tokenTotalSupply: tokenTotalSupply.toString(),
                creator: creator.toBase58(),
                marketCap: marketCapInSOL.toFixed(4),
                price: priceInSOL.toFixed(10),
                liquidity: solReservesInSOL.toFixed(4),
                solAmount: solReservesInSOL.toFixed(4),
                fromTransaction: true
            };
        } catch (error) {
            console.error('❌ Error parsing bonding curve:', error);
            return null;
        }
    }

    stop() {
        console.log('🛑 Stopping blockchain listener...');

        this.stopPingInterval();

        if (this.grpcStream) {
            try {
                this.grpcStream.end();
                console.log('✅ gRPC stream closed');
            } catch (error) {
                console.error('❌ Error closing stream:', error.message);
            }
            this.grpcStream = null;
        }

        this.isSubscribed = false;
        this.isGrpcConnected = false;

        console.log('🛑 Blockchain listener stopped');
    }
}

module.exports = { BlockchainTokenListener };