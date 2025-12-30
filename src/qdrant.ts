import { QdrantClient } from '@qdrant/js-client-rest';
import { randomUUID } from 'crypto';

// Qdrant configuration
const QDRANT_API_KEY = process.env.QDRANT;
const QDRANT_ENDPOINT = process.env.QDRANT_ENDPOINT;
const MEMORIES_COLLECTION = process.env.QDRANT_COLLECTION_NAME || 'discord_memories';
const USER_PROFILES_COLLECTION = 'user_profiles';
const VECTOR_SIZE = parseInt(process.env.QDRANT_VECTOR_SIZE || '1536', 10);

// Memory categories - helps with retrieval and importance
export enum MemoryCategory {
  ROAST = 'roast',           // Sick burns and roasts (high importance)
  USER_FACT = 'user_fact',   // Facts learned about a user
  RUNNING_JOKE = 'joke',     // Inside jokes and recurring themes
  CONVERSATION = 'convo',    // Normal conversation
  BOT_RESPONSE = 'bot',      // What the bot said
  MENTION = 'mention'        // When user mentioned the bot
}

// Importance levels for memory weighting
export enum MemoryImportance {
  LOW = 1,      // Regular chatter
  MEDIUM = 2,   // Interesting exchanges
  HIGH = 3,     // Roasts, important facts
  CRITICAL = 4  // Legendary moments, core lore
}

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

// Enhanced memory entry with categories and importance
export interface MemoryEntry {
  id: string;
  content: string;
  userId: string;
  username: string;
  channelId: string;
  timestamp: number;
  messageType: string;
  isBot: boolean;
  category?: MemoryCategory;
  importance?: MemoryImportance;
  keywords?: string[];        // Extracted keywords for better search
  mentionedUsers?: string[];  // Other users mentioned in this memory
}

// User profile for tracking individuals
export interface UserProfile {
  userId: string;
  username: string;
  firstSeen: number;
  lastSeen: number;
  messageCount: number;
  roastCount: number;         // How many times they've been roasted
  nicknames: string[];        // Nicknames the bot uses for them
  traits: string[];           // Observed traits (e.g., "always asks dumb questions")
  runningJokes: string[];     // Inside jokes with this user
  relationshipLevel: number;  // -10 to 10 (enemy to bestie)
}

// Generate a unique UUID for entries
function generateId(): string {
  return randomUUID();
}

// Initialize collections
export async function initializeCollection(): Promise<void> {
  const client = getQdrantClient();
  
  try {
    const collections = await client.getCollections();
    
    // Initialize memories collection
    const memoriesExists = collections.collections.some(c => c.name === MEMORIES_COLLECTION);
    if (!memoriesExists) {
      console.log(`📦 Creating Qdrant collection: ${MEMORIES_COLLECTION}`);
      await client.createCollection(MEMORIES_COLLECTION, {
        vectors: {
          size: VECTOR_SIZE,
          distance: 'Cosine'
        }
      });
      
      // Create payload indexes for efficient filtering
      const indexes = ['userId', 'channelId', 'category', 'username', 'mentionedUsers'];
      for (const field of indexes) {
        await client.createPayloadIndex(MEMORIES_COLLECTION, {
          field_name: field,
          field_schema: 'keyword',
          wait: true
        });
      }
      
      await client.createPayloadIndex(MEMORIES_COLLECTION, {
        field_name: 'timestamp',
        field_schema: 'integer',
        wait: true
      });
      
      await client.createPayloadIndex(MEMORIES_COLLECTION, {
        field_name: 'importance',
        field_schema: 'integer',
        wait: true
      });
      
      console.log(`✅ Collection ${MEMORIES_COLLECTION} created with indexes`);
    } else {
      console.log(`✅ Collection ${MEMORIES_COLLECTION} already exists`);
      
      // Ensure all required indexes exist (for collections created before index updates)
      console.log(`🔧 Ensuring payload indexes exist...`);
      try {
        const keywordFields = ['userId', 'channelId', 'category', 'username', 'mentionedUsers'];
        for (const field of keywordFields) {
          await client.createPayloadIndex(MEMORIES_COLLECTION, {
            field_name: field,
            field_schema: 'keyword',
            wait: true
          }).catch(() => {}); // Ignore if already exists
        }
        
        await client.createPayloadIndex(MEMORIES_COLLECTION, {
          field_name: 'timestamp',
          field_schema: 'integer',
          wait: true
        }).catch(() => {});
        
        await client.createPayloadIndex(MEMORIES_COLLECTION, {
          field_name: 'importance',
          field_schema: 'integer',
          wait: true
        }).catch(() => {});
        
        console.log(`✅ Payload indexes verified`);
      } catch (err) {
        console.log(`⚠️ Some indexes may already exist (this is OK)`);
      }
    }
    
    // Initialize user profiles collection
    const profilesExists = collections.collections.some(c => c.name === USER_PROFILES_COLLECTION);
    if (!profilesExists) {
      console.log(`📦 Creating Qdrant collection: ${USER_PROFILES_COLLECTION}`);
      await client.createCollection(USER_PROFILES_COLLECTION, {
        vectors: {
          size: VECTOR_SIZE,
          distance: 'Cosine'
        }
      });
      
      await client.createPayloadIndex(USER_PROFILES_COLLECTION, {
        field_name: 'userId',
        field_schema: 'keyword',
        wait: true
      });
      
      console.log(`✅ Collection ${USER_PROFILES_COLLECTION} created`);
    } else {
      console.log(`✅ Collection ${USER_PROFILES_COLLECTION} already exists`);
    }
  } catch (error) {
    console.error('❌ Error initializing Qdrant collections:', error);
    throw error;
  }
}

// Analyze message to determine category and importance
export function analyzeMessage(content: string, isBot: boolean, messageType: string): {
  category: MemoryCategory;
  importance: MemoryImportance;
  keywords: string[];
} {
  const lowerContent = content.toLowerCase();
  let category = MemoryCategory.CONVERSATION;
  let importance = MemoryImportance.LOW;
  const keywords: string[] = [];
  
  // Detect roasts and burns
  const roastIndicators = [
    'roast', 'burn', 'cooked', 'ratio', 'L ', 'mid', 'cringe', 'npc',
    'delulu', 'touch grass', 'cope', 'seethe', '💀', 'clown', 'goofy',
    'bozo', 'trash', 'garbage', 'embarrassing', 'yikes', 'oof', 'womp'
  ];
  
  if (roastIndicators.some(ind => lowerContent.includes(ind))) {
    category = MemoryCategory.ROAST;
    importance = MemoryImportance.HIGH;
    keywords.push('roast');
  }
  
  // Detect personal facts/info
  const factIndicators = [
    'i am', 'i\'m', 'my name', 'i like', 'i hate', 'i love', 'i work',
    'my job', 'my age', 'years old', 'i live', 'from ', 'born in'
  ];
  
  if (factIndicators.some(ind => lowerContent.includes(ind)) && !isBot) {
    category = MemoryCategory.USER_FACT;
    importance = MemoryImportance.HIGH;
    keywords.push('personal_info');
  }
  
  // Detect mentions (user talking to bot)
  if (messageType === 'MENTION' || messageType === 'DM' || messageType === 'REPLY') {
    if (category === MemoryCategory.CONVERSATION) {
      category = MemoryCategory.MENTION;
    }
    importance = Math.max(importance, MemoryImportance.MEDIUM) as MemoryImportance;
  }
  
  // Bot responses
  if (isBot) {
    category = MemoryCategory.BOT_RESPONSE;
    // Bot roasts are important to remember
    if (roastIndicators.some(ind => lowerContent.includes(ind))) {
      importance = MemoryImportance.HIGH;
      keywords.push('bot_roast');
    }
  }
  
  // Extract keywords from slang
  const slangTerms = [
    'rizz', 'aura', 'gyat', 'skibidi', 'sigma', 'alpha', 'beta',
    'bussin', 'cap', 'no cap', 'slay', 'valid', 'based', 'cringe',
    'sus', 'simp', 'goat', 'fire', 'lit', 'bet', 'fr', 'ong'
  ];
  
  slangTerms.forEach(term => {
    if (lowerContent.includes(term)) {
      keywords.push(term);
    }
  });
  
  // Extract mentioned @users
  const mentionMatches = content.match(/<@!?\d+>/g);
  if (mentionMatches) {
    keywords.push('mentions_user');
  }
  
  return { category, importance, keywords };
}

// Store a memory with enhanced metadata
export async function storeMemory(
  memory: MemoryEntry,
  embedding: number[]
): Promise<void> {
  const client = getQdrantClient();
  
  try {
    // Auto-analyze if category not provided
    if (!memory.category) {
      const analysis = analyzeMessage(memory.content, memory.isBot, memory.messageType);
      memory.category = analysis.category;
      memory.importance = analysis.importance;
      memory.keywords = analysis.keywords;
    }
    
    const pointId = generateId();
    
    await client.upsert(MEMORIES_COLLECTION, {
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
            isBot: memory.isBot,
            category: memory.category,
            importance: memory.importance || MemoryImportance.LOW,
            keywords: memory.keywords || [],
            mentionedUsers: memory.mentionedUsers || []
          }
        }
      ]
    });
    
    console.log(`📝 Stored ${memory.category} memory (importance: ${memory.importance}): ${memory.content.substring(0, 40)}...`);
  } catch (error) {
    console.error('❌ Error storing memory:', error);
    throw error;
  }
}

// Enhanced search with importance weighting and user focus
export async function searchMemories(
  queryEmbedding: number[],
  options: {
    limit?: number;
    channelId?: string;
    userId?: string;           // Prioritize memories about this user
    categories?: MemoryCategory[];
    minImportance?: MemoryImportance;
    scoreThreshold?: number;
    includeUserContext?: boolean;  // Also get memories ABOUT the user
  } = {}
): Promise<Array<MemoryEntry & { score: number }>> {
  const client = getQdrantClient();
  const { 
    limit = 10, 
    channelId, 
    userId, 
    categories,
    minImportance,
    scoreThreshold = 0.3,
    includeUserContext = true
  } = options;
  
  try {
    const mustConditions: any[] = [];
    const shouldConditions: any[] = [];
    
    // Filter by channel if specified
    if (channelId) {
      mustConditions.push({
        key: 'channelId',
        match: { value: channelId }
      });
    }
    
    // Filter by categories
    if (categories && categories.length > 0) {
      mustConditions.push({
        key: 'category',
        match: { any: categories }
      });
    }
    
    // Filter by minimum importance
    if (minImportance) {
      mustConditions.push({
        key: 'importance',
        range: { gte: minImportance }
      });
    }
    
    // Build user context - get memories FROM and ABOUT this user
    if (userId && includeUserContext) {
      shouldConditions.push({
        key: 'userId',
        match: { value: userId }
      });
      shouldConditions.push({
        key: 'mentionedUsers',
        match: { any: [userId] }
      });
    }
    
    const searchParams: any = {
      vector: queryEmbedding,
      limit: limit * 2, // Fetch extra for post-processing
      with_payload: true,
      score_threshold: scoreThreshold
    };
    
    if (mustConditions.length > 0 || shouldConditions.length > 0) {
      searchParams.filter = {};
      if (mustConditions.length > 0) {
        searchParams.filter.must = mustConditions;
      }
      if (shouldConditions.length > 0) {
        searchParams.filter.should = shouldConditions;
      }
    }
    
    const results = await client.search(MEMORIES_COLLECTION, searchParams);
    
    // Process and re-rank results
    let memories = results.map(result => ({
      id: String(result.id),
      content: result.payload?.content as string || '',
      userId: result.payload?.userId as string || '',
      username: result.payload?.username as string || '',
      channelId: result.payload?.channelId as string || '',
      timestamp: result.payload?.timestamp as number || 0,
      messageType: result.payload?.messageType as string || '',
      isBot: result.payload?.isBot as boolean || false,
      category: result.payload?.category as MemoryCategory || MemoryCategory.CONVERSATION,
      importance: result.payload?.importance as MemoryImportance || MemoryImportance.LOW,
      keywords: result.payload?.keywords as string[] || [],
      mentionedUsers: result.payload?.mentionedUsers as string[] || [],
      score: result.score
    }));
    
    // Boost score based on importance
    memories = memories.map(mem => ({
      ...mem,
      score: mem.score * (1 + (mem.importance || 1) * 0.1)
    }));
    
    // Boost score for user-relevant memories
    if (userId) {
      memories = memories.map(mem => ({
        ...mem,
        score: mem.userId === userId || mem.mentionedUsers?.includes(userId) 
          ? mem.score * 1.3 
          : mem.score
      }));
    }
    
    // Re-sort by adjusted score and limit
    memories.sort((a, b) => b.score - a.score);
    
    return memories.slice(0, limit);
  } catch (error) {
    console.error('❌ Error searching memories:', error);
    return [];
  }
}

// Get recent memories (for immediate context)
export async function getRecentMemories(
  channelId: string,
  limit: number = 10
): Promise<MemoryEntry[]> {
  const client = getQdrantClient();
  
  try {
    const result = await client.scroll(MEMORIES_COLLECTION, {
      filter: {
        must: [
          {
            key: 'channelId',
            match: { value: channelId }
          }
        ]
      },
      limit: limit * 2,
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
      isBot: point.payload?.isBot as boolean || false,
      category: point.payload?.category as MemoryCategory,
      importance: point.payload?.importance as MemoryImportance,
      keywords: point.payload?.keywords as string[] || []
    }));
    
    return memories.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  } catch (error) {
    console.error('❌ Error getting recent memories:', error);
    return [];
  }
}

// Get all important memories about a user (for building context)
export async function getUserMemories(
  userId: string,
  options: {
    limit?: number;
    minImportance?: MemoryImportance;
    categories?: MemoryCategory[];
  } = {}
): Promise<MemoryEntry[]> {
  const client = getQdrantClient();
  const { limit = 20, minImportance, categories } = options;
  
  try {
    const mustConditions: any[] = [
      {
        key: 'userId',
        match: { value: userId }
      }
    ];
    
    if (minImportance) {
      mustConditions.push({
        key: 'importance',
        range: { gte: minImportance }
      });
    }
    
    if (categories && categories.length > 0) {
      mustConditions.push({
        key: 'category',
        match: { any: categories }
      });
    }
    
    const result = await client.scroll(MEMORIES_COLLECTION, {
      filter: { must: mustConditions },
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
      isBot: point.payload?.isBot as boolean || false,
      category: point.payload?.category as MemoryCategory,
      importance: point.payload?.importance as MemoryImportance,
      keywords: point.payload?.keywords as string[] || []
    }));
    
    // Sort by importance then timestamp
    return memories.sort((a, b) => {
      const impDiff = (b.importance || 1) - (a.importance || 1);
      if (impDiff !== 0) return impDiff;
      return b.timestamp - a.timestamp;
    });
  } catch (error) {
    console.error('❌ Error getting user memories:', error);
    return [];
  }
}

// Get or create user profile
export async function getUserProfile(
  userId: string,
  embedding: number[]
): Promise<UserProfile | null> {
  const client = getQdrantClient();
  
  try {
    const result = await client.scroll(USER_PROFILES_COLLECTION, {
      filter: {
        must: [{ key: 'userId', match: { value: userId } }]
      },
      limit: 1,
      with_payload: true,
      with_vector: false
    });
    
    if (result.points.length > 0) {
      const p = result.points[0].payload;
      return {
        userId: p?.userId as string || userId,
        username: p?.username as string || 'unknown',
        firstSeen: p?.firstSeen as number || Date.now(),
        lastSeen: p?.lastSeen as number || Date.now(),
        messageCount: p?.messageCount as number || 0,
        roastCount: p?.roastCount as number || 0,
        nicknames: p?.nicknames as string[] || [],
        traits: p?.traits as string[] || [],
        runningJokes: p?.runningJokes as string[] || [],
        relationshipLevel: p?.relationshipLevel as number || 0
      };
    }
    
    return null;
  } catch (error) {
    console.error('❌ Error getting user profile:', error);
    return null;
  }
}

// Update or create user profile
export async function updateUserProfile(
  profile: Partial<UserProfile> & { userId: string; username: string },
  embedding: number[]
): Promise<void> {
  const client = getQdrantClient();
  
  try {
    // Get existing profile
    const existing = await getUserProfile(profile.userId, embedding);
    
    const updated: UserProfile = {
      userId: profile.userId,
      username: profile.username,
      firstSeen: existing?.firstSeen || Date.now(),
      lastSeen: Date.now(),
      messageCount: (existing?.messageCount || 0) + 1,
      roastCount: profile.roastCount ?? existing?.roastCount ?? 0,
      nicknames: [...new Set([...(existing?.nicknames || []), ...(profile.nicknames || [])])],
      traits: [...new Set([...(existing?.traits || []), ...(profile.traits || [])])],
      runningJokes: [...new Set([...(existing?.runningJokes || []), ...(profile.runningJokes || [])])],
      relationshipLevel: profile.relationshipLevel ?? existing?.relationshipLevel ?? 0
    };
    
    // Delete old profile if exists
    if (existing) {
      await client.delete(USER_PROFILES_COLLECTION, {
        wait: true,
        filter: {
          must: [{ key: 'userId', match: { value: profile.userId } }]
        }
      });
    }
    
    // Insert updated profile
    await client.upsert(USER_PROFILES_COLLECTION, {
      wait: true,
      points: [{
        id: generateId(),
        vector: embedding,
        payload: updated as unknown as Record<string, unknown>
      }]
    });
    
    console.log(`👤 Updated profile for ${profile.username}`);
  } catch (error) {
    console.error('❌ Error updating user profile:', error);
  }
}

// Get best roasts for a user (for callback roasts)
export async function getUserRoasts(
  userId: string,
  limit: number = 5
): Promise<MemoryEntry[]> {
  return getUserMemories(userId, {
    limit,
    categories: [MemoryCategory.ROAST],
    minImportance: MemoryImportance.MEDIUM
  });
}

// Delete old low-importance memories (cleanup)
export async function deleteOldMemories(
  olderThanTimestamp: number,
  maxImportance: MemoryImportance = MemoryImportance.LOW
): Promise<number> {
  const client = getQdrantClient();
  
  try {
    const result = await client.scroll(MEMORIES_COLLECTION, {
      filter: {
        must: [
          { key: 'timestamp', range: { lt: olderThanTimestamp } },
          { key: 'importance', range: { lte: maxImportance } }
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
    
    await client.delete(MEMORIES_COLLECTION, {
      wait: true,
      points: pointIds as any
    });
    
    console.log(`🗑️ Deleted ${pointIds.length} old low-importance memories`);
    return pointIds.length;
  } catch (error) {
    console.error('❌ Error deleting old memories:', error);
    return 0;
  }
}

// Backwards compatibility aliases
const COLLECTION_NAME = MEMORIES_COLLECTION;
const VECTOR_SIZE_EXPORT = VECTOR_SIZE;

export { MEMORIES_COLLECTION as COLLECTION_NAME, VECTOR_SIZE as VECTOR_SIZE_EXPORT };
