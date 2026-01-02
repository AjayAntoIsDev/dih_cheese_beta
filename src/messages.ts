import { Message, OmitPartialGroupDMChannel, Collection, AttachmentBuilder } from "discord.js";
import { 
  chatCompletion, 
  generateEmbedding,
  generateImage,
  ChatMessage
} from "./pollinations";
import { loadSystemPrompt, getBotName } from "./prompt-loader";
import { addToMemoryBuffer } from "./memory-buffer";
import { getRelationship, RelationshipEntry } from "./relationships";
import { searchMemories, StoredMemory } from "./memory-store";
import { generateQueryEmbedding } from "./voyageai";
import { config } from "./config";
import { logger } from "./logger";
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as os from 'os';

// Discord message length limit
const DISCORD_MESSAGE_LIMIT = 2000;

// Configuration from YAML
const USE_SENDER_PREFIX = config.messages.useSenderPrefix;
const SURFACE_ERRORS = config.messages.surfaceErrors;
const CONTEXT_MESSAGE_COUNT = config.messages.contextMessageCount;
const THREAD_CONTEXT_ENABLED = config.messages.threadContextEnabled;
const THREAD_MESSAGE_LIMIT = config.messages.threadMessageLimit;
const REPLY_IN_THREADS = config.discord.replyInThreads;
const ENABLE_MEMORY = config.memory.enabled;
const MEMORY_SEARCH_LIMIT = config.memory.searchLimit;
const ENABLE_MEMORY_BUFFER = config.memoryBuffer.enabled;
const GENERAL_CHANNEL_ID = config.discord.generalChannelId;
const MEMORY_USER_FACT_COUNT = config.memory.userFactCount;
const MEMORY_SERVER_LORE_COUNT = config.memory.serverLoreCount;

// System prompt - load from files or use environment override
const SYSTEM_PROMPT = loadSystemPrompt();

// Helper function to get dynamic system prompt with line count instruction
function getSystemPromptWithLineCount(): string {
  const random = Math.random();
  const lineInstruction = random < 0.7 
    ? "\n\nTHE REPLY SHOULD BE 1 SINGLE LINE (1 MESSAGE)"
    : "\n\nTHE REPLY SHOULD BE 2 LINES (2 MESSAGES)";
  return SYSTEM_PROMPT + lineInstruction;
}

// Bot name for context
const BOT_NAME = getBotName();

// Response type that includes optional image generation
export interface MessageResponse {
  text: string;
  imagePrompt: string | null;
}

enum MessageType {
  DM = "DM",
  MENTION = "MENTION",
  REPLY = "REPLY",
  GENERIC = "GENERIC"
}

/**
 * Download image from URL to temporary file
 * Returns the path to the downloaded file
 */
async function downloadImage(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const tempDir = os.tmpdir();
    const filename = `image_${Date.now()}_${Math.random().toString(36).substring(7)}.png`;
    const filepath = path.join(tempDir, filename);
    const file = fs.createWriteStream(filepath);
    
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download image: ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        resolve(filepath);
      });
      
      file.on('error', (err) => {
        fs.unlink(filepath, () => {});
        reject(err);
      });
    }).on('error', (err) => {
      fs.unlink(filepath, () => {});
      reject(err);
    });
  });
}

/**
 * Extract image generation prompt from LLM response
 * Looks for [img: ...] syntax
 * Returns { text: string (response without the tag), imagePrompt: string | null }
 */
function extractImagePrompt(response: string): { text: string; imagePrompt: string | null } {
  // Match [img: ...] pattern (case insensitive)
  const imageMatch = response.match(/\[img:\s*(.+?)\]/i);
  
  if (imageMatch) {
    const imagePrompt = imageMatch[1].trim();
    // Remove the image tag from the response text
    const text = response.replace(imageMatch[0], '').trim();
    return { text, imagePrompt };
  }
  
  return { text: response, imagePrompt: null };
}

// Initialize memory system
let memoryInitialized = false;

async function ensureMemoryInitialized(): Promise<void> {
  if (!memoryInitialized && ENABLE_MEMORY) {
    try {
      
      memoryInitialized = true;
    } catch (error) {
      logger.error('Failed to initialize memory system:', error);
    }
  }
}

/**
 * Calculate weighted memory score with soft-forgetting for low-importance old memories
 * Score = (similarity × 0.55) + (normalizedImportance × 0.25) + (recencyScore × 0.20) × penalty
 */
function calculateMemoryScore(
  similarity: number,
  importance: number,
  timestamp: number
): number {
  const now = Date.now();
  const ageDays = (now - timestamp) / (1000 * 60 * 60 * 24);
  
  // Recency score: 1.0 for brand new, 0 after 30 days
  const recencyScore = Math.max(0, 1 - ageDays / 30);
  
  // Normalized importance: importance is 1-10, normalize to 0-1
  const normalizedImportance = importance / 10;
  
  // Soft-forgetting penalty: importance 5-6 and age >= 3 days → multiply by 0.1
  const isForgotten = importance >= 5 && importance <= 6 && ageDays >= 3;
  const penalty = isForgotten ? 0.1 : 1.0;
  
  const score = ((similarity * 0.55) + (normalizedImportance * 0.25) + (recencyScore * 0.20)) * penalty;
  
  return score;
}

/**
 * Format relative time (e.g., "2d ago", "5h ago")
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMins > 0) return `${diffMins}m ago`;
  return 'just now';
}

/**
 * Build memory context for the prompt
 * Retrieves relationship status, user memories, and server lore
 */
async function buildMemoryContext(userId: string, queryText: string): Promise<string> {
  if (!ENABLE_MEMORY) {
    return '';
  }
  
  try {
    const sections: string[] = [];
    
    // 1. Get relationship status (omit if null)
    const relationship = getRelationship(userId);
    if (relationship) {
      const lastInteractionDate = new Date(relationship.last_interaction);
      const lastInteractionRelative = formatRelativeTime(lastInteractionDate.getTime());
      
      sections.push(
        `[RELATIONSHIP STATUS]\n` +
        `Affinity: ${relationship.affinity_score} | Interactions: ${relationship.interaction_count} | Last: ${lastInteractionRelative}`
      );
    }
    
    // 2. Generate query embedding for semantic search
    logger.memory('Generating query embedding for memory context...');
    const queryEmbedding = await generateQueryEmbedding(queryText);
    
    // 3. Search for user_fact memories (no userId filter to include info from other users)
    const userFactResults = await searchMemories(queryEmbedding, {
      limit: MEMORY_USER_FACT_COUNT * 2, // Get more to re-score
      type: 'user_fact',
      scoreThreshold: 0.3 // Lower threshold, we'll re-score
    });
    
    // 4. Search for server_lore memories
    const serverLoreResults = await searchMemories(queryEmbedding, {
      limit: MEMORY_SERVER_LORE_COUNT * 2,
      type: 'server_lore',
      scoreThreshold: 0.3
    });
    
    // 5. Re-score and sort user_fact memories
    const rescoredUserFacts = userFactResults
      .map(memory => ({
        ...memory,
        weightedScore: calculateMemoryScore(memory.score, memory.importance, memory.timestamp)
      }))
      .sort((a, b) => b.weightedScore - a.weightedScore)
      .slice(0, MEMORY_USER_FACT_COUNT);
    
    // 6. Re-score and sort server_lore memories
    const rescoredServerLore = serverLoreResults
      .map(memory => ({
        ...memory,
        weightedScore: calculateMemoryScore(memory.score, memory.importance, memory.timestamp)
      }))
      .sort((a, b) => b.weightedScore - a.weightedScore)
      .slice(0, MEMORY_SERVER_LORE_COUNT);
    
    // 7. Format user memories section
    if (rescoredUserFacts.length > 0) {
      const memoriesFormatted = rescoredUserFacts
        .map(m => `• [imp:${m.importance}] ${m.content} (${formatRelativeTime(m.timestamp)})`)
        .join('\n');
      sections.push(`[MEMORY OF THIS USER]\n${memoriesFormatted}`);
    }
    
    // 8. Format server lore section
    if (rescoredServerLore.length > 0) {
      const loreFormatted = rescoredServerLore
        .map(m => `• [imp:${m.importance}] ${m.content} (${formatRelativeTime(m.timestamp)})`)
        .join('\n');
      sections.push(`[RELEVANT SERVER LORE]\n${loreFormatted}`);
    }
    
    // Log debug info
    logger.memory(`Found ${rescoredUserFacts.length} user facts, ${rescoredServerLore.length} server lore`);
    if (sections.length > 0) {
      logger.memory(`Memory context built:\n${sections.join('\n\n')}`);
    }
    
    return sections.length > 0 ? '\n\n' + sections.join('\n\n') : '';
    
  } catch (error) {
    logger.error('Error building memory context:', error);
    return ''; // Graceful fallback - continue without memory
  }
}

// Helper function to parse thought and reply from bot response
function parseThoughtAndReply(response: string): { thought: string | null; reply: string } {
  // Check if response contains "Thought:" and "Reply:" pattern
  const thoughtMatch = response.match(/\*\*Thought:\*\*\s*(.*?)(?=Reply:|$)/is);
  const replyMatch = response.match(/Reply:\s*([\s\S]*?)$/i);
  
  if (thoughtMatch && replyMatch) {
    const thought = thoughtMatch[1].trim();
    const reply = replyMatch[1].trim();
    return { thought, reply };
  }
  
  // Alternative pattern without bold markers
  const altThoughtMatch = response.match(/Thought:\s*(.*?)(?=Reply:|$)/is);
  const altReplyMatch = response.match(/Reply:\s*([\s\S]*?)$/i);
  
  if (altThoughtMatch && altReplyMatch) {
    const thought = altThoughtMatch[1].trim();
    const reply = altReplyMatch[1].trim();
    return { thought, reply };
  }
  
  // No pattern found, return full response as reply
  return { thought: null, reply: response };
}

// Helper function to split text that doesn't contain code blocks
function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = limit;
    const lastNewline = remaining.lastIndexOf('\n', splitIndex);
    if (lastNewline > splitIndex * 0.5) {
      splitIndex = lastNewline + 1;
    } else {
      const lastSpace = remaining.lastIndexOf(' ', splitIndex);
      if (lastSpace > splitIndex * 0.5) {
        splitIndex = lastSpace + 1;
      }
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex);
  }

  return chunks;
}

// Helper function to split a single code block if it's too large
function splitCodeBlock(block: string, limit: number): string[] {
  if (block.length <= limit) {
    return [block];
  }

  const openMatch = block.match(/^```(\w*)\n?/);
  const openTag = openMatch ? openMatch[0] : '```\n';
  const closeTag = '```';
  
  const innerContent = block.substring(openTag.length, block.length - closeTag.length);
  const overhead = openTag.length + closeTag.length;
  const maxInnerLength = limit - overhead;

  if (maxInnerLength <= 0) {
    return [block];
  }

  const chunks: string[] = [];
  let remaining = innerContent;

  while (remaining.length > 0) {
    if (remaining.length <= maxInnerLength) {
      chunks.push(openTag + remaining + closeTag);
      break;
    }

    let splitIndex = maxInnerLength;
    const lastNewline = remaining.lastIndexOf('\n', splitIndex);
    if (lastNewline > splitIndex * 0.5) {
      splitIndex = lastNewline + 1;
    }

    chunks.push(openTag + remaining.substring(0, splitIndex) + closeTag);
    remaining = remaining.substring(splitIndex);
  }

  return chunks;
}

// Helper function to split long messages into chunks that fit Discord's limit
function splitMessage(content: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] {
  if (content.length <= limit) {
    return [content];
  }

  const result: string[] = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const textBefore = content.substring(lastIndex, match.index);
    if (textBefore.trim()) {
      result.push(...splitText(textBefore, limit));
    }

    const codeBlock = match[0];
    result.push(...splitCodeBlock(codeBlock, limit));

    lastIndex = match.index + match[0].length;
  }

  const textAfter = content.substring(lastIndex);
  if (textAfter.trim()) {
    result.push(...splitText(textAfter, limit));
  }

  return result.length > 0 ? result : [content];
}

// Helper function to fetch and format thread context
async function fetchThreadContext(
  discordMessageObject: OmitPartialGroupDMChannel<Message<boolean>>
): Promise<string> {
  if (!THREAD_CONTEXT_ENABLED) {
    logger.discord('Thread context disabled');
    return '';
  }

  const channel = discordMessageObject.channel;

  if (!('isThread' in channel) || !channel.isThread()) {
    logger.discord('Not in a thread, skipping thread context');
    return '';
  }

  logger.discord(`Fetching thread context (limit: ${THREAD_MESSAGE_LIMIT || 'unlimited'})`);

  try {
    const starterMessage = await channel.fetchStarterMessage();

    const fetchOptions: any = {};
    if (THREAD_MESSAGE_LIMIT > 0) {
      fetchOptions.limit = THREAD_MESSAGE_LIMIT;
    } else {
      fetchOptions.limit = 100;
    }

    const messages = await channel.messages.fetch(fetchOptions) as unknown as Collection<string, Message>;

    logger.discord(`Fetched ${messages.size} thread messages`);

    const sortedMessages = Array.from(messages.values())
      .sort((a: Message, b: Message) => a.createdTimestamp - b.createdTimestamp)
      .filter((msg: Message) => msg.id !== discordMessageObject.id)
      .filter((msg: Message) => !msg.content.startsWith('!'));

    logger.discord(`${sortedMessages.length} messages after filtering`);

    const threadName = channel.name || 'Unnamed thread';
    let threadContext = `[Thread: "${threadName}"]\n`;

    if (starterMessage) {
      const starterAuthor = starterMessage.author.username;
      const starterContent = (starterMessage.content || '[no text content]').replace(/\n/g, ' ');
      threadContext += `[Thread started by ${starterAuthor}: "${starterContent}"]\n\n`;
    }

    if (sortedMessages.length > 0) {
      threadContext += `[Thread conversation history:]\n`;
      const historyLines = sortedMessages.map((msg: Message) => {
        const author = msg.author.username;
        const content = (msg.content || '[no text content]').replace(/\n/g, ' ');
        return `- ${author}: ${content}`;
      });
      threadContext += historyLines.join('\n') + '\n';
    }

    threadContext += `[End thread context]\n\n`;

    logger.discord('Thread context formatted');
    return threadContext;
  } catch (error) {
    logger.error('Error fetching thread context:', error);
    return '';
  }
}

// Helper function to fetch and format conversation history
async function fetchConversationHistory(
  discordMessageObject: OmitPartialGroupDMChannel<Message<boolean>>
): Promise<string> {
  logger.debug(`CONTEXT_MESSAGE_COUNT: ${CONTEXT_MESSAGE_COUNT}`);

  const channel = discordMessageObject.channel;
  if ('isThread' in channel && channel.isThread() && THREAD_CONTEXT_ENABLED) {
    logger.discord('In a thread, using thread context instead of conversation history');
    return fetchThreadContext(discordMessageObject);
  }

  if (CONTEXT_MESSAGE_COUNT <= 0) {
    logger.debug(`Conversation history disabled (CONTEXT_MESSAGE_COUNT=${CONTEXT_MESSAGE_COUNT})`);
    return '';
  }

  try {
    const messages = await discordMessageObject.channel.messages.fetch({
      limit: CONTEXT_MESSAGE_COUNT + 1,
      before: discordMessageObject.id
    });

    logger.discord(`Fetched ${messages.size} messages for conversation history`);

    if (messages.size === 0) {
      logger.discord('No messages found for conversation history');
      return '';
    }

    const sortedMessages = Array.from(messages.values())
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .filter(msg => !msg.content.startsWith('!'));

    logger.discord(`${sortedMessages.length} messages after filtering (excluded ! commands)`);

    if (sortedMessages.length === 0) {
      logger.discord('No messages remaining after filtering');
      return '';
    }

    const historyLines = sortedMessages.map(msg => {
      const author = msg.member?.displayName || msg.author.username;
      const content = (msg.content || '[no text content]').replace(/\n/g, ' ');
      return `- ${author}: ${content}`;
    });

    const historyBlock = `\n [Recent conversation context:]\n${historyLines.join('\n')}\n[End context]\n\n`;
    logger.discord('=========================================\n');
    logger.discord(historyBlock);
    logger.discord('Conversation history formatted');
    return historyBlock;
  } catch (error) {
    logger.error('Error fetching conversation history:', error);
    return '';
  }
}

// Send timer message (for scheduled events)
async function sendTimerMessage(channel?: { send: (content: string) => Promise<any> }): Promise<string> {
  const timerPrompt = `[SYSTEM EVENT] This is an automated timed event. You may use this opportunity to share a thought, ask an engaging question, or simply reflect. Keep it brief and natural for a Discord chat.`;

  try {
    logger.llm('Sending timer message to Pollinations');
    
    const messages: ChatMessage[] = [
      { role: 'system', content: getSystemPromptWithLineCount() },
      { role: 'user', content: timerPrompt }
    ];

    const response = await chatCompletion({ messages });
    
    if (response.choices && response.choices.length > 0) {
      return response.choices[0].message.content || '';
    }

    return '';
  } catch (error) {
    if (error instanceof Error && /timeout/i.test(error.message)) {
      logger.error('Request timed out.');
      return SURFACE_ERRORS
        ? 'Beep boop. I timed out ⏰ – please try again.'
        : '';
    }
    logger.error('Timer message error:', error);
    return SURFACE_ERRORS
      ? 'Beep boop. An error occurred. Please message me again later 👾'
      : '';
  }
}

// Main send message function
async function sendMessage(
  discordMessageObject: OmitPartialGroupDMChannel<Message<boolean>>,
  messageType: MessageType,
  shouldRespond: boolean = true,
  batchedMessage?: string
): Promise<MessageResponse> {
    const {
        author: { username: senderUsername, id: senderId },
        content: message,
        channel,
        guild,
        member,
    } = discordMessageObject;

    // Get display name (nickname if available, otherwise username)
    // In guilds, member.displayName returns nickname or falls back to username
    // In DMs, we only have username
    const senderDisplayName = member?.displayName || senderUsername;
    const senderNickname = member?.nickname || null;

    // DEBUG: Log received message
    logger.discord(`\n${"=".repeat(60)}`);
    logger.discord('MESSAGE RECEIVED');
    logger.discord(
        `  From: ${senderDisplayName} (@${senderUsername}, id: ${senderId})`
    );
    if (senderNickname) {
        logger.discord(`  Nickname: ${senderNickname}`);
    }
    logger.discord(
        `  Content: ${message.substring(0, 100)}${
            message.length > 100 ? "..." : ""
        }`
    );
    logger.discord(`  Type: ${messageType}`);
    logger.discord(`${"=".repeat(60)}`);

    // Capture incoming user message to memory buffer (for messages the bot responds to)
    if (ENABLE_MEMORY_BUFFER) {
        addToMemoryBuffer(
            message,
            senderId,
            senderDisplayName,
            channel.id,
            false,
            "incoming"
        );
    }


    // Fetch conversation history
    const conversationHistory = await fetchConversationHistory(
        discordMessageObject
    );


    // Get channel context
    let channelContext = "";
    if (guild === null) {
        channelContext = "";
        logger.discord(`Channel context: DM (no channel name)`);
    } else if ("name" in channel && channel.name) {
        channelContext = ` in #${channel.name}`;
        logger.discord(`Channel context: #${channel.name}`);
    } else {
        channelContext = ` in channel (id=${channel.id})`;
        logger.discord(`Channel context: channel ID ${channel.id}`);
    }

    const senderNameReceipt = `${senderDisplayName} (id=${senderId})`;

    // Build the message content
    let messageContent: string;

    if (batchedMessage) {
        messageContent = batchedMessage;
        if (!shouldRespond && channelContext) {
            messageContent += `\n\n[IMPORTANT: You are only observing these messages. You cannot respond in this channel.]`;
        } else if (shouldRespond) {
            messageContent += `\n\n[You CAN respond to these messages.]`;
        }
    } else if (USE_SENDER_PREFIX) {
        const currentMessagePrefix =
            messageType === MessageType.MENTION
                ? `[${senderNameReceipt} sent a message${channelContext} mentioning you] ${message}`
                : messageType === MessageType.REPLY
                ? `[${senderNameReceipt} replied to you${channelContext}] ${message}`
                : messageType === MessageType.DM
                ? `[${senderNameReceipt} sent you a direct message] ${message}`
                : `[${senderNameReceipt} sent a message${channelContext}] ${message}`;

        const responseNotice =
            !shouldRespond && channelContext
                ? `\n\n[IMPORTANT: You are only observing this message. You cannot respond in this channel.]`
                : shouldRespond
                ? `\n\n[You CAN respond to this message.]`
                : "";

        messageContent =
            conversationHistory + currentMessagePrefix + responseNotice;
    } else {
        messageContent = conversationHistory + message;
    }

    // Build memory context (relationship status, user memories, server lore)
    let memoryContext = '';
    if (ENABLE_MEMORY) {
        try {
            memoryContext = await buildMemoryContext(senderId, message);
        } catch (error) {
            logger.error('Failed to build memory context:', error);
        }
    }

    // Build chat messages for Pollinations
    const systemPromptWithMemory = getSystemPromptWithLineCount() + memoryContext;
    const chatMessages: ChatMessage[] = [
        { role: "system", content: systemPromptWithMemory },
        { role: "user", content: messageContent },
    ];

    // Typing indicator
    let typingInterval: NodeJS.Timeout | undefined;
    if (shouldRespond) {
        logger.discord('Starting typing indicator');
        void discordMessageObject.channel.sendTyping();
        typingInterval = setInterval(() => {
            void discordMessageObject.channel
                .sendTyping()
                .catch((err) =>
                    logger.error('Error refreshing typing indicator:', err)
                );
        }, 8000);
    }

    try {
        logger.llm('Sending message to Pollinations');
        logger.debug(
            `User message preview: ${messageContent.substring(0, 200)}...`
        );

        logger.debug('\n========== CHAT MESSAGES SENT ==========\n');
        chatMessages.forEach((msg, index) => {
            logger.debug(`  [${msg.role.toUpperCase()}] ${msg.content}`);
        });
        logger.debug(`\n=========================================\n`);

        const response = await chatCompletion({ messages: chatMessages });

        if (response.choices && response.choices.length > 0) {
            const assistantMessage = response.choices[0].message.content || "";

            logger.debug(`Assistant message preview: ${assistantMessage.substring(0, 200)}...`);

            // Parse thought and reply sections
            const { thought, reply } = parseThoughtAndReply(assistantMessage);
            
            // Extract image prompt from reply if present
            const { text: replyText, imagePrompt } = extractImagePrompt(reply);

            // DEBUG: Log bot response
            logger.debug(`\n${"=".repeat(60)}`);
            logger.debug('BOT RESPONSE');

            if (thought) {
                logger.debug('\nTHOUGHT PROCESS:');
                // Log each line of thought separately
                thought.split("\n").forEach((line) => {
                    if (line.trim()) {
                        logger.debug(`  ${line.trim()}`);
                    }
                });
            }

            logger.debug('\nREPLY (sent to Discord):');
            // Log each line of reply separately
            replyText.split("\n").forEach((line) => {
                if (line.trim()) {
                    logger.debug(`  ${line.trim()}`);
                }
            });
            
            if (imagePrompt) {
                logger.debug(`\nIMAGE PROMPT: ${imagePrompt}`);
            }

            logger.debug(`\nLength: ${replyText.length} chars`);
            logger.debug(`${"=".repeat(60)}\n`);

            // Capture bot response to memory buffer
            if (ENABLE_MEMORY_BUFFER && replyText) {
                const botId = discordMessageObject.client.user?.id || "bot";
                const botName = BOT_NAME;
                addToMemoryBuffer(
                    replyText,
                    botId,
                    botName,
                    channel.id,
                    true,
                    "outgoing"
                );
            }

            return { text: replyText, imagePrompt }; // Return text and optional image prompt
        }

        return { text: "", imagePrompt: null };
    } catch (error) {
        if (error instanceof Error && /timeout/i.test(error.message)) {
            logger.error('Request timed out.');
            return {
                text: SURFACE_ERRORS ? "Beep boop. I timed out ⏰ - please try again." : "",
                imagePrompt: null
            };
        }
        logger.error('Message send error:', error);
        return {
            text: SURFACE_ERRORS ? "Beep boop. An error occurred. 👾" : "",
            imagePrompt: null
        };
    } finally {
        if (typingInterval) {
            clearInterval(typingInterval);
        }
    }
}

export { sendMessage, sendTimerMessage, MessageType, splitMessage };
