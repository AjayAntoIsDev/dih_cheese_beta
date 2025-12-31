/**
 * Memory Store - Qdrant-based vector storage for extracted memories
 * 
 * Stores memories extracted by the Memory Manager LLM with:
 * - Vector embeddings from VoyageAI
 * - Metadata: content, type, importance, user_id, tags, timestamp
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { randomUUID } from 'crypto';
import { generateEmbeddingsBatch } from './voyageai';
import { ExtractedMemory } from './memory-buffer';

// Qdrant configuration
const QDRANT_API_KEY = process.env.QDRANT;
const QDRANT_ENDPOINT = process.env.QDRANT_ENDPOINT;
const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'discord_memories';
const VECTOR_SIZE = parseInt(process.env.QDRANT_VECTOR_SIZE || '1024', 10);

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
    
    console.log(`✅ Qdrant client initialized (collection: ${COLLECTION_NAME}, dim: ${VECTOR_SIZE})`);
  }
  return qdrantClient;
}

// Stored memory structure (what we put in Qdrant)
export interface StoredMemory {
  id: string;
  content: string;
  type: 'user_fact' | 'server_lore';
  importance: number;
  user_id: string | null;
  tags: string[];
  timestamp: number;
  created_at: string;
}

/**
 * Delete and recreate the collection (use when dimension changes)
 */
export async function recreateMemoryCollection(): Promise<void> {
  const client = getQdrantClient();
  
  try {
    console.log(`🗑️ Deleting collection: ${COLLECTION_NAME}`);
    await client.deleteCollection(COLLECTION_NAME);
    console.log(`✅ Collection deleted`);
  } catch (error) {
    console.log(`ℹ️ Collection didn't exist or couldn't be deleted`);
  }
  
  // Now create fresh
  await initializeMemoryCollection();
}

// Initialize collection if it doesn't exist
export async function initializeMemoryCollection(): Promise<void> {
  const client = getQdrantClient();
  
  try {
    const collections = await client.getCollections();
    const exists = collections.collections.some(c => c.name === COLLECTION_NAME);
    
    if (!exists) {
      console.log(`📦 Creating Qdrant collection: ${COLLECTION_NAME} (dim: ${VECTOR_SIZE})`);
      await client.createCollection(COLLECTION_NAME, {
        vectors: {
          size: VECTOR_SIZE,
          distance: 'Cosine'
        }
      });
      
      // Create payload indexes for efficient filtering
      await client.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'user_id',
        field_schema: 'keyword',
        wait: true
      });
      
      await client.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'type',
        field_schema: 'keyword',
        wait: true
      });
      
      await client.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'importance',
        field_schema: 'integer',
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

/**
 * Store multiple extracted memories (batch)
 * Generates embeddings in batch for efficiency
 */
export async function storeMemoriesBatch(memories: ExtractedMemory[]): Promise<void> {
  if (memories.length === 0) {
    console.log('[MEMORY STORE] No memories to store');
    return;
  }
  
  const client = getQdrantClient();
  
  try {
    // Extract content for embedding
    const contents = memories.map(m => m.content);
    
    // Generate embeddings in batch
    console.log(`\n🔄 [MEMORY STORE] Generating embeddings for ${memories.length} memories...`);
    const embeddings = await generateEmbeddingsBatch(contents);
    
    // Prepare points for Qdrant
    const timestamp = Date.now();
    const createdAt = new Date().toISOString();
    
    const points = memories.map((memory, index) => {
      const pointId = randomUUID();
      const payload = {
        id: pointId,
        content: memory.content,
        type: memory.type,
        importance: memory.importance,
        user_id: memory.user_id,
        tags: memory.tags,
        timestamp,
        created_at: createdAt
      };
      
      return {
        id: pointId,
        vector: embeddings[index],
        payload: payload as Record<string, unknown>
      };
    });
    
    // DEBUG: Print what we're storing
    console.log('\n========================================');
    console.log('[MEMORY STORE] DEBUG - Points to store in Qdrant:');
    console.log('----------------------------------------');
    points.forEach((point, i) => {
      const p = point.payload;
      console.log(`\n  Point ${i + 1}:`);
      console.log(`    ID: ${point.id}`);
      console.log(`    Vector: [${point.vector.slice(0, 5).map(v => v.toFixed(4)).join(', ')}... ] (dim: ${point.vector.length})`);
      console.log(`    Payload:`);
      console.log(`      content: "${p.content}"`);
      console.log(`      type: ${p.type}`);
      console.log(`      importance: ${p.importance}`);
      console.log(`      user_id: ${p.user_id || 'null'}`);
      console.log(`      tags: [${(p.tags as string[]).join(', ')}]`);
      console.log(`      timestamp: ${p.timestamp}`);
    });
    console.log('========================================\n');
    
    // Upsert to Qdrant
    await client.upsert(COLLECTION_NAME, {
      wait: true,
      points
    });
    
    console.log(`✅ [MEMORY STORE] Stored ${points.length} memories in Qdrant`);
    
  } catch (error) {
    console.error('❌ [MEMORY STORE] Error storing memories:', error);
    throw error;
  }
}

/**
 * Search for relevant memories using semantic similarity
 */
export async function searchMemories(
  queryEmbedding: number[],
  options: {
    limit?: number;
    userId?: string;
    type?: 'user_fact' | 'server_lore';
    minImportance?: number;
    scoreThreshold?: number;
  } = {}
): Promise<Array<StoredMemory & { score: number }>> {
  const client = getQdrantClient();
  const { 
    limit = 10, 
    userId, 
    type, 
    minImportance,
    scoreThreshold = 0.5 
  } = options;
  
  try {
    // Build filter conditions
    const mustConditions: any[] = [];
    
    if (userId) {
      mustConditions.push({
        key: 'user_id',
        match: { value: userId }
      });
    }
    
    if (type) {
      mustConditions.push({
        key: 'type',
        match: { value: type }
      });
    }
    
    if (minImportance !== undefined) {
      mustConditions.push({
        key: 'importance',
        range: { gte: minImportance }
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
      id: result.payload?.id as string || String(result.id),
      content: result.payload?.content as string || '',
      type: result.payload?.type as 'user_fact' | 'server_lore' || 'server_lore',
      importance: result.payload?.importance as number || 0,
      user_id: result.payload?.user_id as string | null || null,
      tags: result.payload?.tags as string[] || [],
      timestamp: result.payload?.timestamp as number || 0,
      created_at: result.payload?.created_at as string || '',
      score: result.score
    }));
  } catch (error) {
    console.error('❌ [MEMORY STORE] Error searching memories:', error);
    return [];
  }
}

/**
 * Get memories for a specific user
 */
export async function getUserMemories(
  userId: string,
  limit: number = 20
): Promise<StoredMemory[]> {
  const client = getQdrantClient();
  
  try {
    const result = await client.scroll(COLLECTION_NAME, {
      filter: {
        must: [
          {
            key: 'user_id',
            match: { value: userId }
          }
        ]
      },
      limit,
      with_payload: true,
      with_vector: false
    });
    
    const memories = result.points.map(point => ({
      id: point.payload?.id as string || String(point.id),
      content: point.payload?.content as string || '',
      type: point.payload?.type as 'user_fact' | 'server_lore' || 'server_lore',
      importance: point.payload?.importance as number || 0,
      user_id: point.payload?.user_id as string | null || null,
      tags: point.payload?.tags as string[] || [],
      timestamp: point.payload?.timestamp as number || 0,
      created_at: point.payload?.created_at as string || ''
    }));
    
    // Sort by importance then timestamp
    return memories.sort((a, b) => {
      if (b.importance !== a.importance) {
        return b.importance - a.importance;
      }
      return b.timestamp - a.timestamp;
    });
  } catch (error) {
    console.error('❌ [MEMORY STORE] Error getting user memories:', error);
    return [];
  }
}

/**
 * Get recent memories (all types)
 */
export async function getRecentMemories(limit: number = 20): Promise<StoredMemory[]> {
  const client = getQdrantClient();
  
  try {
    const result = await client.scroll(COLLECTION_NAME, {
      limit,
      with_payload: true,
      with_vector: false
    });
    
    const memories = result.points.map(point => ({
      id: point.payload?.id as string || String(point.id),
      content: point.payload?.content as string || '',
      type: point.payload?.type as 'user_fact' | 'server_lore' || 'server_lore',
      importance: point.payload?.importance as number || 0,
      user_id: point.payload?.user_id as string | null || null,
      tags: point.payload?.tags as string[] || [],
      timestamp: point.payload?.timestamp as number || 0,
      created_at: point.payload?.created_at as string || ''
    }));
    
    // Sort by timestamp descending
    return memories.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  } catch (error) {
    console.error('❌ [MEMORY STORE] Error getting recent memories:', error);
    return [];
  }
}

/**
 * Get high-importance memories (importance >= threshold)
 */
export async function getImportantMemories(
  minImportance: number = 7,
  limit: number = 20
): Promise<StoredMemory[]> {
  const client = getQdrantClient();
  
  try {
    const result = await client.scroll(COLLECTION_NAME, {
      filter: {
        must: [
          {
            key: 'importance',
            range: { gte: minImportance }
          }
        ]
      },
      limit,
      with_payload: true,
      with_vector: false
    });
    
    const memories = result.points.map(point => ({
      id: point.payload?.id as string || String(point.id),
      content: point.payload?.content as string || '',
      type: point.payload?.type as 'user_fact' | 'server_lore' || 'server_lore',
      importance: point.payload?.importance as number || 0,
      user_id: point.payload?.user_id as string | null || null,
      tags: point.payload?.tags as string[] || [],
      timestamp: point.payload?.timestamp as number || 0,
      created_at: point.payload?.created_at as string || ''
    }));
    
    // Sort by importance descending
    return memories.sort((a, b) => b.importance - a.importance);
  } catch (error) {
    console.error('❌ [MEMORY STORE] Error getting important memories:', error);
    return [];
  }
}

export { COLLECTION_NAME, VECTOR_SIZE };
