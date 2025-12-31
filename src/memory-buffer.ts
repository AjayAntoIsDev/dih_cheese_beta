/**
 * Memory Buffer System for RAG-based long-term memory
 * 
 * Captures messages and triggers summarization based on:
 * - Silence: 5 minutes of inactivity
 * - Volume: 30 messages accumulated
 * - Token Cap: ~2000 tokens estimated
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { chatCompletion, PollinationsModel } from './pollinations';

// Buffer configuration
const MEMORY_SILENCE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MEMORY_VOLUME_THRESHOLD = 30; // 30 messages
const MEMORY_TOKEN_CAP = 2000; // ~2000 tokens

// Memory Manager LLM configuration
const MEMORY_MANAGER_MODEL = (process.env.MEMORY_MANAGER_MODEL || 'openai-fast') as PollinationsModel;

// Load memory manager prompt
function loadMemoryManagerPrompt(): string {
  const promptsDir = join(__dirname, '..', 'prompts');
  try {
    return readFileSync(join(promptsDir, 'memory-manager.txt'), 'utf-8').trim();
  } catch (error) {
    console.error('❌ Error loading memory-manager.txt:', error);
    throw new Error('Failed to load memory manager prompt');
  }
}

// Message types for categorization
export type MessageType = 'incoming' | 'outgoing' | 'observed';

export interface BufferedMessage {
  content: string;
  userId: string;
  username: string;
  channelId: string;
  timestamp: Date;
  isBot: boolean;
  messageType: MessageType;
}

export type TriggerReason = 'silence' | 'volume' | 'token_cap';

// Memory extraction types
export interface ExtractedMemory {
  content: string;
  type: 'user_fact' | 'server_lore';
  importance: number;
  user_id: string | null;
  tags: string[];
}

export interface RelationshipUpdate {
  user_id: string;
  sentiment_delta: string; // String like "-5" or "+3" for JSON parsing compatibility
  reasoning: string;
}

export interface MemoryExtractionResult {
  memories: ExtractedMemory[];
  relationship_updates: RelationshipUpdate[];
}

// Global buffer (single buffer for all channels)
let globalBuffer: BufferedMessage[] = [];
let silenceTimer: NodeJS.Timeout | null = null;

/**
 * Attempt to repair common JSON issues from LLM output
 */
function repairJson(jsonStr: string): string {
  let repaired = jsonStr;
  
  // Fix unquoted property names (e.g., tags: -> "tags":)
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
  
  // Fix single quotes to double quotes
  repaired = repaired.replace(/'/g, '"');
  
  // Fix missing quotes on string values that look like IDs
  // This handles cases like: user_id: 1234567890 -> user_id: "1234567890"
  repaired = repaired.replace(/"(user_id|sentiment_delta)":\s*([0-9+-]+)([,}\s])/g, '"$1": "$2"$3');
  
  // Fix trailing commas before closing brackets
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
  
  // Fix missing commas between array/object elements
  repaired = repaired.replace(/}(\s*){/g, '},$1{');
  repaired = repaired.replace(/](\s*)\[/g, '],$1[');
  
  return repaired;
}

/**
 * Rough token estimation (~4 chars per token for English text)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Get total estimated tokens in the global buffer
 */
function getBufferTokenCount(): number {
  return globalBuffer.reduce((total, msg) => {
    // Include username and content in token count
    const messageText = `${msg.username}: ${msg.content}`;
    return total + estimateTokens(messageText);
  }, 0);
}

/**
 * Reset the silence timer
 */
function resetSilenceTimer(): void {
  // Clear existing timer
  if (silenceTimer) {
    clearTimeout(silenceTimer);
  }

  // Set new timer
  silenceTimer = setTimeout(() => {
    triggerSummarize('silence');
  }, MEMORY_SILENCE_TIMEOUT_MS);
}

/**
 * Check if buffer should be summarized based on volume or token cap
 */
function checkBufferThresholds(): void {
  const tokenCount = getBufferTokenCount();

  if (globalBuffer.length >= MEMORY_VOLUME_THRESHOLD) {
    triggerSummarize('volume');
  } else if (tokenCount >= MEMORY_TOKEN_CAP) {
    triggerSummarize('token_cap');
  }
}

/**
 * Trigger summarization and clear the buffer
 */
function triggerSummarize(reason: TriggerReason): void {
  if (globalBuffer.length === 0) {
    return;
  }

  // Clear silence timer
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  // Call summarize with the buffer (async, fire and forget)
  summarizeBuffer([...globalBuffer], reason).catch(err => {
    console.error('[MEMORY BUFFER] Summarization error:', err);
  });

  // Clear the buffer
  globalBuffer = [];
}

/**
 * Format buffer messages into chat log format for LLM
 */
function formatBufferForLLM(buffer: BufferedMessage[]): string {
  return buffer.map(msg => {
    const time = msg.timestamp.toISOString();
    const botTag = msg.isBot ? ' [BOT]' : '';
    return `[${time}] ${msg.username} (ID: ${msg.userId})${botTag}: ${msg.content}`;
  }).join('\n');
}

/**
 * Summarize the buffer contents using LLM
 */
async function summarizeBuffer(buffer: BufferedMessage[], reason: TriggerReason): Promise<void> {
  console.log('\n========================================');
  console.log(`[MEMORY BUFFER] Summarization triggered!`);
  console.log(`Reason: ${reason}`);
  console.log(`Message count: ${buffer.length}`);
  console.log(`Estimated tokens: ${buffer.reduce((t, m) => t + estimateTokens(`${m.username}: ${m.content}`), 0)}`);
  
  // Show unique channels in this buffer
  const uniqueChannels = [...new Set(buffer.map(m => m.channelId))];
  console.log(`Channels: ${uniqueChannels.length} (${uniqueChannels.join(', ')})`);
  console.log(`Model: ${MEMORY_MANAGER_MODEL}`);
  
  console.log('----------------------------------------');
  console.log('Buffer contents:');
  
  buffer.forEach((msg, index) => {
    const time = msg.timestamp.toISOString();
    const type = msg.messageType.toUpperCase().padEnd(8);
    const bot = msg.isBot ? '[BOT]' : '     ';
    console.log(`  ${index + 1}. [${time}] ${type} ${bot} #${msg.channelId.slice(-4)} ${msg.username}: ${msg.content.substring(0, 100)}${msg.content.length > 100 ? '...' : ''}`);
  });
  
  console.log('----------------------------------------');
  console.log('Sending to LLM for memory extraction...');

  try {
    const systemPrompt = loadMemoryManagerPrompt();
    const chatLogs = formatBufferForLLM(buffer);
    
    const response = await chatCompletion({
      model: MEMORY_MANAGER_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analyze these chat logs and extract memories:\n\n${chatLogs}` }
      ],
      temperature: 0.3, // Lower temperature for more consistent structured output
    });

    const assistantMessage = response.choices[0]?.message?.content;
    
    if (!assistantMessage) {
      console.error('[MEMORY BUFFER] No response from LLM');
      return;
    }

    console.log('\n[MEMORY BUFFER] LLM Response:');
    console.log(assistantMessage);

    // Parse JSON response
    try {
      // Try to extract JSON from response (handle potential markdown code blocks)
      let jsonStr = assistantMessage.trim();
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.slice(7);
      } else if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.slice(3);
      }
      if (jsonStr.endsWith('```')) {
        jsonStr = jsonStr.slice(0, -3);
      }
      jsonStr = jsonStr.trim();

      // Attempt to repair common JSON issues from LLM output
      jsonStr = repairJson(jsonStr);

      const result: MemoryExtractionResult = JSON.parse(jsonStr);
      
      console.log('\n[MEMORY BUFFER] Extracted memories:');
      console.log(`  - ${result.memories.length} memories`);
      console.log(`  - ${result.relationship_updates.length} relationship updates`);
      
      if (result.memories.length > 0) {
        console.log('\nMemories:');
        result.memories.forEach((mem, i) => {
          console.log(`  ${i + 1}. [${mem.type}] (importance: ${mem.importance}) ${mem.content}`);
          console.log(`     Tags: ${mem.tags.join(', ')} | User: ${mem.user_id || 'N/A'}`);
        });
      }
      
      if (result.relationship_updates.length > 0) {
        console.log('\nRelationship Updates:');
        result.relationship_updates.forEach((rel, i) => {
          console.log(`  ${i + 1}. User ${rel.user_id}: ${rel.sentiment_delta} - ${rel.reasoning}`);
        });
      }

      // TODO: Store memories in vector database (Qdrant)
      // TODO: Update user relationship scores in database
      
    } catch (parseError) {
      console.error('[MEMORY BUFFER] Failed to parse LLM response as JSON:', parseError);
      console.log('Raw response:', assistantMessage);
    }

  } catch (error) {
    console.error('[MEMORY BUFFER] LLM request failed:', error);
  }
  
  console.log('========================================\n');
}

/**
 * Add a message to the buffer
 */
export function addToMemoryBuffer(
  content: string,
  userId: string,
  username: string,
  channelId: string,
  isBot: boolean,
  messageType: MessageType
): void {
  const message: BufferedMessage = {
    content,
    userId,
    username,
    channelId,
    timestamp: new Date(),
    isBot,
    messageType,
  };

  // Add to global buffer
  globalBuffer.push(message);

  console.log(`[MEMORY BUFFER] Added ${messageType} message from ${username} (${globalBuffer.length} msgs, ~${getBufferTokenCount()} tokens)`);

  // Reset silence timer
  resetSilenceTimer();

  // Check if we need to summarize due to volume or tokens
  checkBufferThresholds();
}

/**
 * Get the current buffer (for debugging)
 */
export function getMemoryBuffer(): BufferedMessage[] {
  return [...globalBuffer];
}

/**
 * Get buffer stats
 */
export function getBufferStats(): {
  messageCount: number;
  tokenCount: number;
  oldestMessage: Date | null;
  newestMessage: Date | null;
  uniqueChannels: string[];
} {
  return {
    messageCount: globalBuffer.length,
    tokenCount: getBufferTokenCount(),
    oldestMessage: globalBuffer.length > 0 ? globalBuffer[0].timestamp : null,
    newestMessage: globalBuffer.length > 0 ? globalBuffer[globalBuffer.length - 1].timestamp : null,
    uniqueChannels: [...new Set(globalBuffer.map(m => m.channelId))],
  };
}

/**
 * Force flush the buffer (for manual triggering)
 */
export function flushMemoryBuffer(): void {
  triggerSummarize('volume'); // Use 'volume' as generic manual trigger
}

/**
 * Clear the buffer without summarizing
 */
export function clearMemoryBuffer(): void {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  globalBuffer = [];
  console.log(`[MEMORY BUFFER] Cleared global buffer`);
}
