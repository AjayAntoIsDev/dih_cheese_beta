/**
 * Memory Buffer System for RAG-based long-term memory
 * 
 * Captures messages and triggers summarization based on:
 * - Silence: 5 minutes of inactivity
 * - Volume: 30 messages accumulated
 * - Token Cap: ~2000 tokens estimated
 */

// Buffer configuration
const MEMORY_SILENCE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MEMORY_VOLUME_THRESHOLD = 30; // 30 messages
const MEMORY_TOKEN_CAP = 2000; // ~2000 tokens

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

// Global buffer (single buffer for all channels)
let globalBuffer: BufferedMessage[] = [];
let silenceTimer: NodeJS.Timeout | null = null;

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

  // Call summarize with the buffer
  summarizeBuffer([...globalBuffer], reason);

  // Clear the buffer
  globalBuffer = [];
}

/**
 * Summarize the buffer contents
 * TODO: Implement actual LLM summarization and vector storage
 * For now, just console.log the buffer
 */
function summarizeBuffer(buffer: BufferedMessage[], reason: TriggerReason): void {
  console.log('\n========================================');
  console.log(`[MEMORY BUFFER] Summarization triggered!`);
  console.log(`Reason: ${reason}`);
  console.log(`Message count: ${buffer.length}`);
  console.log(`Estimated tokens: ${buffer.reduce((t, m) => t + estimateTokens(`${m.username}: ${m.content}`), 0)}`);
  
  // Show unique channels in this buffer
  const uniqueChannels = [...new Set(buffer.map(m => m.channelId))];
  console.log(`Channels: ${uniqueChannels.length} (${uniqueChannels.join(', ')})`);
  
  console.log('----------------------------------------');
  console.log('Buffer contents:');
  
  buffer.forEach((msg, index) => {
    const time = msg.timestamp.toISOString();
    const type = msg.messageType.toUpperCase().padEnd(8);
    const bot = msg.isBot ? '[BOT]' : '     ';
    console.log(`  ${index + 1}. [${time}] ${type} ${bot} #${msg.channelId.slice(-4)} ${msg.username}: ${msg.content.substring(0, 100)}${msg.content.length > 100 ? '...' : ''}`);
  });
  
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
