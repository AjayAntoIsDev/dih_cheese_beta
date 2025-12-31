import { Message, OmitPartialGroupDMChannel, Collection } from "discord.js";
import { 
  chatCompletion, 
  generateEmbedding,
  ChatMessage
} from "./pollinations";
import { loadSystemPrompt, getBotName } from "./prompt-loader";
import { addToMemoryBuffer } from "./memory-buffer";
import { getRelationship, RelationshipEntry } from "./relationships";
import { searchMemories, StoredMemory } from "./memory-store";
import { generateQueryEmbedding } from "./voyageai";

// Discord message length limit
const DISCORD_MESSAGE_LIMIT = 2000;

// Configuration
const USE_SENDER_PREFIX = process.env.USE_SENDER_PREFIX === 'true';
const SURFACE_ERRORS = process.env.SURFACE_ERRORS === 'true';
const CONTEXT_MESSAGE_COUNT = parseInt(process.env.CONTEXT_MESSAGE_COUNT || '5', 10);
const THREAD_CONTEXT_ENABLED = process.env.THREAD_CONTEXT_ENABLED !== 'false';
const THREAD_MESSAGE_LIMIT = parseInt(process.env.THREAD_MESSAGE_LIMIT || '50', 10);
const REPLY_IN_THREADS = process.env.REPLY_IN_THREADS === 'true';
const ENABLE_MEMORY = process.env.ENABLE_MEMORY === 'true';
const MEMORY_SEARCH_LIMIT = parseInt(process.env.MEMORY_SEARCH_LIMIT || '5', 10);
const ENABLE_MEMORY_BUFFER = process.env.ENABLE_MEMORY_BUFFER === 'true';
const GENERAL_CHANNEL_ID = process.env.DISCORD_GENERAL_CHANNEL_ID;
const MEMORY_USER_FACT_COUNT = parseInt(process.env.MEMORY_USER_FACT_COUNT || '5', 10);
const MEMORY_SERVER_LORE_COUNT = parseInt(process.env.MEMORY_SERVER_LORE_COUNT || '3', 10);

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

enum MessageType {
  DM = "DM",
  MENTION = "MENTION",
  REPLY = "REPLY",
  GENERIC = "GENERIC"
}

// Initialize memory system
let memoryInitialized = false;

async function ensureMemoryInitialized(): Promise<void> {
  if (!memoryInitialized && ENABLE_MEMORY) {
    try {
      
      memoryInitialized = true;
    } catch (error) {
      console.error('❌ Failed to initialize memory system:', error);
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
    console.log(`🔍 [MEMORY CONTEXT] Generating query embedding...`);
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
    console.log(`📝 [MEMORY CONTEXT] Found ${rescoredUserFacts.length} user facts, ${rescoredServerLore.length} server lore`);
    if (sections.length > 0) {
      console.log(`📝 [MEMORY CONTEXT] Memory context built:\n${sections.join('\n\n')}`);
    }
    
    return sections.length > 0 ? '\n\n' + sections.join('\n\n') : '';
    
  } catch (error) {
    console.error('❌ [MEMORY CONTEXT] Error building memory context:', error);
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
    console.log(`🧵 Thread context disabled`);
    return '';
  }

  const channel = discordMessageObject.channel;

  if (!('isThread' in channel) || !channel.isThread()) {
    console.log(`🧵 Not in a thread, skipping thread context`);
    return '';
  }

  console.log(`🧵 Fetching thread context (limit: ${THREAD_MESSAGE_LIMIT || 'unlimited'})`);

  try {
    const starterMessage = await channel.fetchStarterMessage();

    const fetchOptions: any = {};
    if (THREAD_MESSAGE_LIMIT > 0) {
      fetchOptions.limit = THREAD_MESSAGE_LIMIT;
    } else {
      fetchOptions.limit = 100;
    }

    const messages = await channel.messages.fetch(fetchOptions) as unknown as Collection<string, Message>;

    console.log(`🧵 Fetched ${messages.size} thread messages`);

    const sortedMessages = Array.from(messages.values())
      .sort((a: Message, b: Message) => a.createdTimestamp - b.createdTimestamp)
      .filter((msg: Message) => msg.id !== discordMessageObject.id)
      .filter((msg: Message) => !msg.content.startsWith('!'));

    console.log(`🧵 ${sortedMessages.length} messages after filtering`);

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

    console.log(`🧵 Thread context formatted`);
    return threadContext;
  } catch (error) {
    console.error('🧵 Error fetching thread context:', error);
    return '';
  }
}

// Helper function to fetch and format conversation history
async function fetchConversationHistory(
  discordMessageObject: OmitPartialGroupDMChannel<Message<boolean>>
): Promise<string> {
  console.log(`📚 CONTEXT_MESSAGE_COUNT: ${CONTEXT_MESSAGE_COUNT}`);

  const channel = discordMessageObject.channel;
  if ('isThread' in channel && channel.isThread() && THREAD_CONTEXT_ENABLED) {
    console.log(`📚 In a thread, using thread context instead of conversation history`);
    return fetchThreadContext(discordMessageObject);
  }

  if (CONTEXT_MESSAGE_COUNT <= 0) {
    console.log(`�� Conversation history disabled (CONTEXT_MESSAGE_COUNT=${CONTEXT_MESSAGE_COUNT})`);
    return '';
  }

  try {
    const messages = await discordMessageObject.channel.messages.fetch({
      limit: CONTEXT_MESSAGE_COUNT + 1,
      before: discordMessageObject.id
    });

    console.log(`📚 Fetched ${messages.size} messages for conversation history`);

    if (messages.size === 0) {
      console.log(`📚 No messages found for conversation history`);
      return '';
    }

    const sortedMessages = Array.from(messages.values())
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .filter(msg => !msg.content.startsWith('!'));

    console.log(`📚 ${sortedMessages.length} messages after filtering (excluded ! commands)`);

    if (sortedMessages.length === 0) {
      console.log(`📚 No messages remaining after filtering`);
      return '';
    }

    const historyLines = sortedMessages.map(msg => {
      const author = msg.member?.displayName || msg.author.username;
      const content = (msg.content || '[no text content]').replace(/\n/g, ' ');
      return `- ${author}: ${content}`;
    });

    const historyBlock = `\n [Recent conversation context:]\n${historyLines.join('\n')}\n[End context]\n\n`;
    console.log(`=========================================\n`);
    console.log(historyBlock);
    console.log(`📚 Conversation history formatted`);
    return historyBlock;
  } catch (error) {
    console.error('�� Error fetching conversation history:', error);
    return '';
  }
}

// Send timer message (for scheduled events)
async function sendTimerMessage(channel?: { send: (content: string) => Promise<any> }): Promise<string> {
  const timerPrompt = `[SYSTEM EVENT] This is an automated timed event. You may use this opportunity to share a thought, ask an engaging question, or simply reflect. Keep it brief and natural for a Discord chat.`;

  try {
    console.log(`🛜 Sending timer message to Pollinations`);
    
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
      console.error('⚠️ Request timed out.');
      return SURFACE_ERRORS
        ? 'Beep boop. I timed out ⏰ – please try again.'
        : '';
    }
    console.error(error);
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
): Promise<string> {
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

    // 🔍 DEBUG: Log received message
    console.log(`\n${"=".repeat(60)}`);
    console.log(`📩 MESSAGE RECEIVED`);
    console.log(
        `  👤 From: ${senderDisplayName} (@${senderUsername}, id: ${senderId})`
    );
    if (senderNickname) {
        console.log(`  🏷️  Nickname: ${senderNickname}`);
    }
    console.log(
        `  💬 Content: ${message.substring(0, 100)}${
            message.length > 100 ? "..." : ""
        }`
    );
    console.log(`  📝 Type: ${messageType}`);
    console.log(`${"=".repeat(60)}`);

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
        console.log(`📍 Channel context: DM (no channel name)`);
    } else if ("name" in channel && channel.name) {
        channelContext = ` in #${channel.name}`;
        console.log(`📍 Channel context: #${channel.name}`);
    } else {
        channelContext = ` in channel (id=${channel.id})`;
        console.log(`📍 Channel context: channel ID ${channel.id}`);
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
            console.error('❌ Failed to build memory context:', error);
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
        console.log(`⌨️ Starting typing indicator`);
        void discordMessageObject.channel.sendTyping();
        typingInterval = setInterval(() => {
            void discordMessageObject.channel
                .sendTyping()
                .catch((err) =>
                    console.error("Error refreshing typing indicator:", err)
                );
        }, 8000);
    }

    try {
        console.log(`🛜 Sending message to Pollinations`);
        console.log(
            `📝 User message preview: ${messageContent.substring(0, 200)}...`
        );

        console.log(`\n========== CHAT MESSAGES SENT ==========\n`);
        chatMessages.forEach((msg, index) => {
            console.log(`  [${msg.role.toUpperCase()}] ${msg.content}`);
        });
        console.log(`\n=========================================\n`);

        const response = await chatCompletion({ messages: chatMessages });

        if (response.choices && response.choices.length > 0) {
            const assistantMessage = response.choices[0].message.content || "";

            // Parse thought and reply sections
            const { thought, reply } = parseThoughtAndReply(assistantMessage);

            // 🔍 DEBUG: Log bot response
            console.log(`\n${"=".repeat(60)}`);
            console.log(`🤖 BOT RESPONSE`);

            if (thought) {
                console.log(`\n💭 THOUGHT PROCESS:`);
                // Log each line of thought separately
                thought.split("\n").forEach((line) => {
                    if (line.trim()) {
                        console.log(`  ${line.trim()}`);
                    }
                });
            }

            console.log(`\n💬 REPLY (sent to Discord):`);
            // Log each line of reply separately
            reply.split("\n").forEach((line) => {
                if (line.trim()) {
                    console.log(`  ${line.trim()}`);
                }
            });

            console.log(`\n📏 Length: ${reply.length} chars`);
            console.log(`${"=".repeat(60)}\n`);

            // Capture bot response to memory buffer
            if (ENABLE_MEMORY_BUFFER && reply) {
                const botId = discordMessageObject.client.user?.id || "bot";
                const botName = BOT_NAME;
                addToMemoryBuffer(
                    reply,
                    botId,
                    botName,
                    channel.id,
                    true,
                    "outgoing"
                );
            }

            return reply; // Return only the reply part
        }

        return "";
    } catch (error) {
        if (error instanceof Error && /timeout/i.test(error.message)) {
            console.error("⚠️ Request timed out.");
            return SURFACE_ERRORS
                ? "Beep boop. I timed out ⏰ - please try again."
                : "";
        }
        console.error(error);
        return SURFACE_ERRORS
            ? "Beep boop. An error occurred. Please message me again later 👾"
            : "";
    } finally {
        if (typingInterval) {
            clearInterval(typingInterval);
        }
    }
}

export { sendMessage, sendTimerMessage, MessageType, splitMessage };
