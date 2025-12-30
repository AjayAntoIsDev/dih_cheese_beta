import { QdrantClient } from '@qdrant/js-client-rest';
import { randomUUID } from 'crypto';

// Qdrant configuration
const QDRANT_API_KEY = process.env.QDRANT;
const QDRANT_ENDPOINT = process.env.QDRANT_ENDPOINT;
const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'discord_memories';
const VECTOR_SIZE = parseInt(process.env.QDRANT_VECTOR_SIZE || '1536', 10);

// Initialize Qdrant client
let qdrantClient: QdrantClient | null = null;

export function getQdrantClient(): QdrantClient {
  if (!qdrantClient) {
    if (!QDRANT_ENDPOINT) {
      throw new Error('QDRANT_ENDPOINT is not set');
    }
    
    qdrantClient = new QdrantClient({
      url: QDRANT_ENDPOINT,
      apiKey: QDRANT_API_KEY,
    });
    
    console.log('✅ Qdrant client initialized');
  }
  return qdrantClient;
}

// Interface for memory entries
export interface MemoryEntry {
  id: string;
  content: string;
  userId: string;
  username: string;
  channelId: string;
  timestamp: number;
  messageType: string;
  isBot: boolean;
}

// Generate a unique UUID for memory entries (Qdrant requires UUID or unsigned int)
function generateId(): string {
  return randomUUID();
}

// Initialize collection if it doesn't exist
export async function initializeCollection(): Promise<void> {
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
    } else {
      console.log(`✅ Collection ${COLLECTION_NAME} already exists`);
    }
  } catch (error) {
    console.error('❌ Error initializing Qdrant collection:', error);
    throw error;
  }
}

// Store a memory with its embedding
export async function storeMemory(
  memory: MemoryEntry,
  embedding: number[]
): Promise<void> {
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
  } catch (error) {
    console.error('❌ Error storing memory:', error);
    throw error;
  }
}

// Search for relevant memories
export async function searchMemories(
  queryEmbedding: number[],
  options: {
    limit?: number;
    channelId?: string;
    userId?: string;
    scoreThreshold?: number;
  } = {}
): Promise<Array<MemoryEntry & { score: number }>> {
  const client = getQdrantClient();
  const { limit = 10, channelId, userId, scoreThreshold = 0.5 } = options;
  
  try {
    // Build filter conditions
    const mustConditions: any[] = [];
    
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
    
    const searchParams: any = {
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
      content: result.payload?.content as string || '',
      userId: result.payload?.userId as string || '',
      username: result.payload?.username as string || '',
      channelId: result.payload?.channelId as string || '',
      timestamp: result.payload?.timestamp as number || 0,
      messageType: result.payload?.messageType as string || '',
      isBot: result.payload?.isBot as boolean || false,
      score: result.score
    }));
  } catch (error) {
    console.error('❌ Error searching memories:', error);
    return [];
  }
}

// Get recent memories for a channel (sorted by timestamp)
export async function getRecentMemories(
  channelId: string,
  limit: number = 10
): Promise<MemoryEntry[]> {
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
      content: point.payload?.content as string || '',
      userId: point.payload?.userId as string || '',
      username: point.payload?.username as string || '',
      channelId: point.payload?.channelId as string || '',
      timestamp: point.payload?.timestamp as number || 0,
      messageType: point.payload?.messageType as string || '',
      isBot: point.payload?.isBot as boolean || false
    }));
    
    // Sort by timestamp descending
    return memories.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  } catch (error) {
    console.error('❌ Error getting recent memories:', error);
    return [];
  }
}

// Get memories for a specific user
export async function getUserMemories(
  userId: string,
  limit: number = 20
): Promise<MemoryEntry[]> {
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
      content: point.payload?.content as string || '',
      userId: point.payload?.userId as string || '',
      username: point.payload?.username as string || '',
      channelId: point.payload?.channelId as string || '',
      timestamp: point.payload?.timestamp as number || 0,
      messageType: point.payload?.messageType as string || '',
      isBot: point.payload?.isBot as boolean || false
    }));
    
    return memories.sort((a, b) => b.timestamp - a.timestamp);
  } catch (error) {
    console.error('❌ Error getting user memories:', error);
    return [];
  }
}

// Delete old memories (cleanup)
export async function deleteOldMemories(
  olderThanTimestamp: number
): Promise<number> {
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
      points: pointIds as any
    });
    
    console.log(`🗑️ Deleted ${pointIds.length} old memories`);
    return pointIds.length;
  } catch (error) {
    console.error('❌ Error deleting old memories:', error);
    return 0;
  }
}

export { COLLECTION_NAME, VECTOR_SIZE };
