"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VECTOR_SIZE = exports.COLLECTION_NAME = void 0;
exports.getQdrantClient = getQdrantClient;
exports.initializeCollection = initializeCollection;
exports.storeMemory = storeMemory;
exports.searchMemories = searchMemories;
exports.getRecentMemories = getRecentMemories;
exports.getUserMemories = getUserMemories;
exports.deleteOldMemories = deleteOldMemories;
const js_client_rest_1 = require("@qdrant/js-client-rest");
const crypto_1 = require("crypto");
// Qdrant configuration
const QDRANT_API_KEY = process.env.QDRANT;
const QDRANT_ENDPOINT = process.env.QDRANT_ENDPOINT;
const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'discord_memories';
exports.COLLECTION_NAME = COLLECTION_NAME;
const VECTOR_SIZE = parseInt(process.env.QDRANT_VECTOR_SIZE || '1536', 10);
exports.VECTOR_SIZE = VECTOR_SIZE;
// Initialize Qdrant client
let qdrantClient = null;
function getQdrantClient() {
    if (!qdrantClient) {
        if (!QDRANT_ENDPOINT) {
            throw new Error('QDRANT_ENDPOINT is not set');
        }
        qdrantClient = new js_client_rest_1.QdrantClient({
            url: QDRANT_ENDPOINT,
            apiKey: QDRANT_API_KEY,
        });
        console.log('✅ Qdrant client initialized');
    }
    return qdrantClient;
}
// Generate a unique UUID for memory entries (Qdrant requires UUID or unsigned int)
function generateId() {
    return (0, crypto_1.randomUUID)();
}
// Initialize collection if it doesn't exist
async function initializeCollection() {
    const client = getQdrantClient();
    try {
        const collections = await client.getCollections();
        const exists = collections.collections.some(c => c.name === COLLECTION_NAME);
        if (!exists) {
            console.log(`📦 Creating Qdrant collection: ${COLLECTION_NAME}`);
            await client.createCollection(COLLECTION_NAME, {
                vectors: {
                    size: VECTOR_SIZE,
                    distance: 'Cosine'
                }
            });
            // Create payload indexes for efficient filtering
            await client.createPayloadIndex(COLLECTION_NAME, {
                field_name: 'userId',
                field_schema: 'keyword',
                wait: true
            });
            await client.createPayloadIndex(COLLECTION_NAME, {
                field_name: 'channelId',
                field_schema: 'keyword',
                wait: true
            });
            await client.createPayloadIndex(COLLECTION_NAME, {
                field_name: 'timestamp',
                field_schema: 'integer',
                wait: true
            });
            console.log(`✅ Collection ${COLLECTION_NAME} created with indexes`);
        }
        else {
            console.log(`✅ Collection ${COLLECTION_NAME} already exists`);
        }
    }
    catch (error) {
        console.error('❌ Error initializing Qdrant collection:', error);
        throw error;
    }
}
// Store a memory with its embedding
async function storeMemory(memory, embedding) {
    const client = getQdrantClient();
    try {
        const pointId = generateId();
        await client.upsert(COLLECTION_NAME, {
            wait: true,
            points: [
                {
                    id: pointId,
                    vector: embedding,
                    payload: {
                        content: memory.content,
                        userId: memory.userId,
                        username: memory.username,
                        channelId: memory.channelId,
                        timestamp: memory.timestamp,
                        messageType: memory.messageType,
                        isBot: memory.isBot
                    }
                }
            ]
        });
        console.log(`📝 Stored memory: ${memory.content.substring(0, 50)}...`);
    }
    catch (error) {
        console.error('❌ Error storing memory:', error);
        throw error;
    }
}
// Search for relevant memories
async function searchMemories(queryEmbedding, options = {}) {
    const client = getQdrantClient();
    const { limit = 10, channelId, userId, scoreThreshold = 0.5 } = options;
    try {
        // Build filter conditions
        const mustConditions = [];
        if (channelId) {
            mustConditions.push({
                key: 'channelId',
                match: { value: channelId }
            });
        }
        if (userId) {
            mustConditions.push({
                key: 'userId',
                match: { value: userId }
            });
        }
        const searchParams = {
            vector: queryEmbedding,
            limit,
            with_payload: true,
            score_threshold: scoreThreshold
        };
        if (mustConditions.length > 0) {
            searchParams.filter = { must: mustConditions };
        }
        const results = await client.search(COLLECTION_NAME, searchParams);
        return results.map(result => ({
            id: String(result.id),
            content: result.payload?.content || '',
            userId: result.payload?.userId || '',
            username: result.payload?.username || '',
            channelId: result.payload?.channelId || '',
            timestamp: result.payload?.timestamp || 0,
            messageType: result.payload?.messageType || '',
            isBot: result.payload?.isBot || false,
            score: result.score
        }));
    }
    catch (error) {
        console.error('❌ Error searching memories:', error);
        return [];
    }
}
// Get recent memories for a channel (sorted by timestamp)
async function getRecentMemories(channelId, limit = 10) {
    const client = getQdrantClient();
    try {
        // Use scroll to get points with filter
        const result = await client.scroll(COLLECTION_NAME, {
            filter: {
                must: [
                    {
                        key: 'channelId',
                        match: { value: channelId }
                    }
                ]
            },
            limit,
            with_payload: true,
            with_vector: false
        });
        const memories = result.points.map(point => ({
            id: String(point.id),
            content: point.payload?.content || '',
            userId: point.payload?.userId || '',
            username: point.payload?.username || '',
            channelId: point.payload?.channelId || '',
            timestamp: point.payload?.timestamp || 0,
            messageType: point.payload?.messageType || '',
            isBot: point.payload?.isBot || false
        }));
        // Sort by timestamp descending
        return memories.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    }
    catch (error) {
        console.error('❌ Error getting recent memories:', error);
        return [];
    }
}
// Get memories for a specific user
async function getUserMemories(userId, limit = 20) {
    const client = getQdrantClient();
    try {
        const result = await client.scroll(COLLECTION_NAME, {
            filter: {
                must: [
                    {
                        key: 'userId',
                        match: { value: userId }
                    }
                ]
            },
            limit,
            with_payload: true,
            with_vector: false
        });
        const memories = result.points.map(point => ({
            id: String(point.id),
            content: point.payload?.content || '',
            userId: point.payload?.userId || '',
            username: point.payload?.username || '',
            channelId: point.payload?.channelId || '',
            timestamp: point.payload?.timestamp || 0,
            messageType: point.payload?.messageType || '',
            isBot: point.payload?.isBot || false
        }));
        return memories.sort((a, b) => b.timestamp - a.timestamp);
    }
    catch (error) {
        console.error('❌ Error getting user memories:', error);
        return [];
    }
}
// Delete old memories (cleanup)
async function deleteOldMemories(olderThanTimestamp) {
    const client = getQdrantClient();
    try {
        // First, find points to delete
        const result = await client.scroll(COLLECTION_NAME, {
            filter: {
                must: [
                    {
                        key: 'timestamp',
                        range: { lt: olderThanTimestamp }
                    }
                ]
            },
            limit: 1000,
            with_payload: false,
            with_vector: false
        });
        if (result.points.length === 0) {
            return 0;
        }
        const pointIds = result.points.map(p => p.id);
        await client.delete(COLLECTION_NAME, {
            wait: true,
            points: pointIds
        });
        console.log(`🗑️ Deleted ${pointIds.length} old memories`);
        return pointIds.length;
    }
    catch (error) {
        console.error('❌ Error deleting old memories:', error);
        return 0;
    }
}
