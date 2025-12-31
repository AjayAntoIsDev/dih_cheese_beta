/**
 * Relationship Store - JSON-based persistent storage for bot-user relationships
 * 
 * Tracks the bot's sentiment toward users based on their interactions.
 * Sentiment accumulates over time through sentiment_delta updates.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// Configuration
const DATA_DIR = process.env.RELATIONSHIPS_DATA_DIR || join(__dirname, '..', 'data');
const RELATIONSHIPS_FILE = join(DATA_DIR, 'relationships.json');

// Relationship entry structure
export interface RelationshipEntry {
  user_id: string;
  username: string;
  affinity_score: number;
  last_interaction: string;  // ISO date string
  interaction_count: number;
}

// In-memory cache
let relationships: Map<string, RelationshipEntry> = new Map();
let isLoaded = false;

/**
 * Ensure data directory exists
 */
function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Created data directory: ${DATA_DIR}`);
  }
}

/**
 * Load relationships from JSON file
 */
function loadRelationships(): void {
  if (isLoaded) return;
  
  ensureDataDir();
  
  try {
    if (existsSync(RELATIONSHIPS_FILE)) {
      const data = readFileSync(RELATIONSHIPS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      
      // Convert array to Map
      if (Array.isArray(parsed)) {
        relationships = new Map(parsed.map((r: RelationshipEntry) => [r.user_id, r]));
      } else if (typeof parsed === 'object') {
        // Handle object format
        relationships = new Map(Object.entries(parsed));
      }
      
      console.log(`✅ Loaded ${relationships.size} relationships from ${RELATIONSHIPS_FILE}`);
    } else {
      console.log(`📝 No relationships file found, starting fresh`);
      relationships = new Map();
    }
  } catch (error) {
    console.error('❌ Error loading relationships:', error);
    relationships = new Map();
  }
  
  isLoaded = true;
}

/**
 * Save relationships to JSON file
 */
function saveRelationships(): void {
  ensureDataDir();
  
  try {
    const data = Array.from(relationships.values());
    writeFileSync(RELATIONSHIPS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 Saved ${relationships.size} relationships to ${RELATIONSHIPS_FILE}`);
  } catch (error) {
    console.error('❌ Error saving relationships:', error);
  }
}

/**
 * Update sentiment for a user
 * @param userId Discord user ID
 * @param username Display name for reference
 * @param sentimentDelta Change in sentiment (string like "+5" or "-3")
 * @returns New affinity score
 */
export function updateSentiment(
  userId: string,
  username: string,
  sentimentDelta: string
): number {
  loadRelationships();
  
  // Parse sentiment delta (handles "+5", "-3", "0" formats)
  const delta = parseInt(sentimentDelta.replace('+', ''), 10) || 0;
  
  const existing = relationships.get(userId);
  const now = new Date().toISOString();
  
  if (existing) {
    // Update existing relationship
    existing.affinity_score += delta;
    existing.username = username;  // Update username in case it changed
    existing.last_interaction = now;
    existing.interaction_count += 1;
    
    console.log(`🔄 [RELATIONSHIPS] Updated ${username} (${userId}): ${existing.affinity_score - delta} → ${existing.affinity_score} (delta: ${sentimentDelta})`);
  } else {
    // Create new relationship
    const newEntry: RelationshipEntry = {
      user_id: userId,
      username,
      affinity_score: delta,
      last_interaction: now,
      interaction_count: 1
    };
    relationships.set(userId, newEntry);
    
    console.log(`✨ [RELATIONSHIPS] New relationship with ${username} (${userId}): ${delta}`);
  }
  
  // Save to disk
  saveRelationships();
  
  return relationships.get(userId)!.affinity_score;
}

/**
 * Get affinity score for a user
 * @returns Affinity score or 0 if no relationship exists
 */
export function getAffinity(userId: string): number {
  loadRelationships();
  return relationships.get(userId)?.affinity_score || 0;
}

/**
 * Get full relationship entry for a user
 */
export function getRelationship(userId: string): RelationshipEntry | null {
  loadRelationships();
  return relationships.get(userId) || null;
}

/**
 * Get all relationships
 */
export function getAllRelationships(): RelationshipEntry[] {
  loadRelationships();
  return Array.from(relationships.values());
}

/**
 * Get relationships sorted by affinity (highest first)
 */
export function getTopRelationships(limit: number = 10): RelationshipEntry[] {
  loadRelationships();
  return Array.from(relationships.values())
    .sort((a, b) => b.affinity_score - a.affinity_score)
    .slice(0, limit);
}

/**
 * Get relationships sorted by affinity (lowest first) - the bot's "enemies"
 */
export function getBottomRelationships(limit: number = 10): RelationshipEntry[] {
  loadRelationships();
  return Array.from(relationships.values())
    .sort((a, b) => a.affinity_score - b.affinity_score)
    .slice(0, limit);
}

/**
 * Batch update multiple sentiments at once
 */
export function updateSentimentsBatch(
  updates: Array<{ user_id: string; username?: string; sentiment_delta: string }>
): void {
  loadRelationships();
  
  for (const update of updates) {
    const existing = relationships.get(update.user_id);
    const username = update.username || existing?.username || 'Unknown';
    updateSentiment(update.user_id, username, update.sentiment_delta);
  }
}

/**
 * Debug: Print all relationships
 */
export function debugPrintRelationships(): void {
  loadRelationships();
  
  console.log('\n========================================');
  console.log('[RELATIONSHIPS] Current state:');
  console.log('----------------------------------------');
  
  if (relationships.size === 0) {
    console.log('  (no relationships yet)');
  } else {
    const sorted = Array.from(relationships.values())
      .sort((a, b) => b.affinity_score - a.affinity_score);
    
    sorted.forEach((r, i) => {
      const emoji = r.affinity_score > 0 ? '💚' : r.affinity_score < 0 ? '💔' : '🤍';
      console.log(`  ${i + 1}. ${emoji} ${r.username} (${r.user_id}): ${r.affinity_score} | interactions: ${r.interaction_count}`);
    });
  }
  
  console.log('========================================\n');
}
