import { Message, OmitPartialGroupDMChannel, Collection } from "discord.js";
import { 
  chatCompletion, 
  generateEmbedding,
  ChatMessage
} from "./pollinations";
import {
  storeMemory,
  searchMemories,
  getRecentMemories,
  getUserMemories,
  getUserProfile,
  updateUserProfile,
  MemoryEntry,
  UserProfile,
  MemoryCategory,
  MemoryImportance,
  initializeCollection
} from "./qdrant";
import { loadSystemPrompt, getBotName } from "./prompt-loader";

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
      await initializeCollection();
      memoryInitialized = true;
    } catch (error) {
      console.error('❌ Failed to initialize memory system:', error);
    }
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
      const starterContent = starterMessage.content || '[no text content]';
      threadContext += `[Thread started by ${starterAuthor}: "${starterContent}"]\n\n`;
    }

    if (sortedMessages.length > 0) {
      threadContext += `[Thread conversation history:]\n`;
      const historyLines = sortedMessages.map((msg: Message) => {
        const author = msg.author.username;
        const content = msg.content || '[no text content]';
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
      const content = msg.content || '[no text content]';
      return `- ${author}: ${content}`;
    });

    const historyBlock = `[Recent conversation context:]\n${historyLines.join('\n')}\n[End context]\n\n`;
    console.log(`=========================================\n`);
    console.log(historyBlock);
    console.log(`📚 Conversation history formatted`);
    return historyBlock;
  } catch (error) {
    console.error('�� Error fetching conversation history:', error);
    return '';
  }
}

// Fetch relevant memories from Qdrant (enhanced with user context)
async function fetchRelevantMemories(
  message: string,
  channelId: string,
  userId?: string,
  username?: string
): Promise<string> {
  if (!ENABLE_MEMORY) {
    return '';
  }

  await ensureMemoryInitialized();

  try {
    const embedding = await generateEmbedding(message);
    
    // Get semantically relevant memories with user context boosting
    const memories = await searchMemories(embedding, {
      limit: MEMORY_SEARCH_LIMIT,
      channelId,
      userId,
      scoreThreshold: 0.25,
      includeUserContext: true
    });

    // Also get user's past roasts and important moments
    let userContext = '';
    if (userId) {
      const userMemories = await getUserMemories(userId, {
        limit: 3,
        minImportance: MemoryImportance.HIGH,
        categories: [MemoryCategory.ROAST, MemoryCategory.USER_FACT]
      });
      
      if (userMemories.length > 0) {
        const userLines = userMemories
          .filter(m => !memories.some(mem => mem.id === m.id)) // Avoid duplicates
          .map(mem => {
            const category = mem.category === MemoryCategory.ROAST ? '🔥' : '📝';
            return `${category} ${mem.username}: ${mem.content}`;
          });
        
        if (userLines.length > 0) {
          userContext = `[What you know about ${username || 'this user'}:]\n${userLines.join('\n')}\n\n`;
        }
      }
      
      // Get user profile for relationship context
      const profile = await getUserProfile(userId, embedding);
      if (profile && (profile.messageCount > 5 || profile.roastCount > 0)) {
        const traits = profile.traits.length > 0 ? `traits: ${profile.traits.join(', ')}` : '';
        const jokes = profile.runningJokes.length > 0 ? `inside jokes: ${profile.runningJokes.join(', ')}` : '';
        const relationship = profile.relationshipLevel > 0 ? 'homie' : profile.relationshipLevel < 0 ? 'opp' : 'neutral';
        
        userContext += `[User stats: ${profile.messageCount} msgs, ${profile.roastCount} roasts received, relationship: ${relationship}`;
        if (traits) userContext += `, ${traits}`;
        if (jokes) userContext += `, ${jokes}`;
        userContext += ']\n\n';
      }
    }

    if (memories.length === 0 && !userContext) {
      console.log(`🧠 No relevant memories found`);
      return '';
    }

    console.log(`\n========== MEMORIES RETRIEVED ==========`);
    console.log(`Found ${memories.length} relevant memories`);
    
    if (userId) {
      console.log(`User context loaded: ${userContext ? 'YES' : 'NO'}`);
    }

    let memoryBlock = userContext;
    
    if (memories.length > 0) {
      const memoryLines = memories.map(mem => {
        const date = new Date(mem.timestamp).toLocaleDateString();
        const categoryIcon = mem.category === MemoryCategory.ROAST ? '🔥' 
          : mem.category === MemoryCategory.USER_FACT ? '📝'
          : mem.category === MemoryCategory.BOT_RESPONSE ? '🤖'
          : '💬';
        const line = `${categoryIcon} [${date}] ${mem.username}: ${mem.content}`;
        console.log(`  ${line}`);
        return line;
      });

      memoryBlock += `[Relevant past conversations:]\n${memoryLines.join('\n')}\n[End memories]\n\n`;
    }

    console.log(`=========================================\n`);

    return memoryBlock;
  } catch (error) {
    console.error('🧠 Error fetching memories:', error);
    return '';
  }
}

// Store a message in memory (enhanced with user profile updates)
async function storeMessageInMemory(
  message: OmitPartialGroupDMChannel<Message<boolean>>,
  messageType: string,
  displayName?: string
): Promise<void> {
  if (!ENABLE_MEMORY) {
    return;
  }

  await ensureMemoryInitialized();

  try {
    const content = message.content;
    if (!content || content.startsWith('!')) {
      return;
    }

    const embedding = await generateEmbedding(content);
    
    // Extract mentioned users from the message
    const mentionedUsers = message.mentions.users.map(u => u.id);
    
    // Use displayName (nickname) if provided, otherwise fall back to username
    const username = displayName || message.member?.displayName || message.author.username;
    
    const memoryEntry: MemoryEntry = {
      id: message.id,
      content,
      userId: message.author.id,
      username,  // Now stores displayName/nickname
      channelId: message.channel.id,
      timestamp: message.createdTimestamp,
      messageType,
      isBot: message.author.bot,
      mentionedUsers
    };

    // 🔍 DEBUG: Log memory storage
    console.log(`\n📦 STORING MEMORY`);
    console.log(`  👤 User: ${username} (id: ${message.author.id})`);
    console.log(`  💬 Content: ${content.substring(0, 80)}${content.length > 80 ? '...' : ''}`);
    console.log(`  🏷️  Category: auto-detected`);

    await storeMemory(memoryEntry, embedding);
    
    // Update user profile (track their activity)
    if (!message.author.bot) {
      await updateUserProfile({
        userId: message.author.id,
        username  // Store displayName in profile too
      }, embedding);
    }
  } catch (error) {
    console.error('🧠 Error storing message in memory:', error);
  }
}

// Store bot response in memory (enhanced with roast detection)
async function storeBotResponseInMemory(
  response: string,
  channelId: string,
  botUserId: string,
  targetUserId?: string,
  targetUsername?: string
): Promise<void> {
  if (!ENABLE_MEMORY || !response) {
    return;
  }

  await ensureMemoryInitialized();

  try {
    const embedding = await generateEmbedding(response);
    
    // Detect if this was a roast and track mentioned users
    const mentionedUsers = targetUserId ? [targetUserId] : [];
    
    const memoryEntry: MemoryEntry = {
      id: `bot-${Date.now()}`,
      content: response,
      userId: botUserId,
      username: BOT_NAME,
      channelId,
      timestamp: Date.now(),
      messageType: 'BOT_RESPONSE',
      isBot: true,
      mentionedUsers
    };

    console.log(`\n📦 STORING BOT RESPONSE MEMORY`);
    console.log(`  🤖 Bot: ${BOT_NAME}`);
    console.log(`  💬 Response: ${response.substring(0, 80)}${response.length > 80 ? '...' : ''}`);
    if (targetUsername) {
      console.log(`  🎯 Target: ${targetUsername}`);
    }

    await storeMemory(memoryEntry, embedding);
    
    // If this was a roast, update the target user's roast count
    if (targetUserId && targetUsername) {
      const lowerResponse = response.toLowerCase();
      const roastIndicators = [
        'roast', 'burn', 'cooked', 'ratio', 'L ', 'mid', 'cringe', 'npc',
        'delulu', 'touch grass', 'cope', 'seethe', '💀', 'clown', 'goofy',
        'bozo', 'trash', 'garbage', 'embarrassing', 'yikes', 'oof', 'womp'
      ];
      
      if (roastIndicators.some(ind => lowerResponse.includes(ind))) {
        const profile = await getUserProfile(targetUserId, embedding);
        await updateUserProfile({
          userId: targetUserId,
          username: targetUsername,
          roastCount: (profile?.roastCount || 0) + 1
        }, embedding);
        console.log(`🔥 Roast detected! ${targetUsername} has been roasted ${(profile?.roastCount || 0) + 1} times`);
      }
    }
  } catch (error) {
    console.error('🧠 Error storing bot response in memory:', error);
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
  const { author: { username: senderUsername, id: senderId }, content: message, channel, guild, member } = discordMessageObject;
  
  // Get display name (nickname if available, otherwise username)
  // In guilds, member.displayName returns nickname or falls back to username
  // In DMs, we only have username
  const senderDisplayName = member?.displayName || senderUsername;
  const senderNickname = member?.nickname || null;
  
  // 🔍 DEBUG: Log received message
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📩 MESSAGE RECEIVED`);
  console.log(`  👤 From: ${senderDisplayName} (@${senderUsername}, id: ${senderId})`);
  if (senderNickname) {
    console.log(`  🏷️  Nickname: ${senderNickname}`);
  }
  console.log(`  💬 Content: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`);
  console.log(`  📝 Type: ${messageType}`);
  console.log(`${'='.repeat(60)}`);

  // Store incoming message in memory (use displayName for better context)
  // await storeMessageInMemory(discordMessageObject, messageType, senderDisplayName);

  // Fetch conversation history
  const conversationHistory = await fetchConversationHistory(discordMessageObject);

  // Fetch relevant memories (with user context)
  // const relevantMemories = await fetchRelevantMemories(message, channel.id, senderId, senderDisplayName);

  // Get channel context
  let channelContext = '';
  if (guild === null) {
    channelContext = '';
    console.log(`📍 Channel context: DM (no channel name)`);
  } else if ('name' in channel && channel.name) {
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
    const currentMessagePrefix = messageType === MessageType.MENTION
      ? `[${senderNameReceipt} sent a message${channelContext} mentioning you] ${message}`
      : messageType === MessageType.REPLY
        ? `[${senderNameReceipt} replied to you${channelContext}] ${message}`
        : messageType === MessageType.DM
          ? `[${senderNameReceipt} sent you a direct message] ${message}`
          : `[${senderNameReceipt} sent a message${channelContext}] ${message}`;

    const responseNotice = !shouldRespond && channelContext
      ? `\n\n[IMPORTANT: You are only observing this message. You cannot respond in this channel.]`
      : shouldRespond
        ? `\n\n[You CAN respond to this message.]`
        : '';

    // messageContent = relevantMemories + conversationHistory + currentMessagePrefix + responseNotice;
    messageContent = conversationHistory + currentMessagePrefix + responseNotice;
  } else {
    // messageContent = relevantMemories + conversationHistory + message;
    messageContent = conversationHistory + message;
  }

  // Build chat messages for Pollinations
  const chatMessages: ChatMessage[] = [
    { role: 'system', content: getSystemPromptWithLineCount() },
    { role: 'user', content: messageContent }
  ];

  // Typing indicator
  let typingInterval: NodeJS.Timeout | undefined;
  if (shouldRespond) {
    console.log(`⌨️ Starting typing indicator`);
    void discordMessageObject.channel.sendTyping();
    typingInterval = setInterval(() => {
      void discordMessageObject.channel
        .sendTyping()
        .catch(err => console.error('Error refreshing typing indicator:', err));
    }, 8000);
  }

  try {
    console.log(`🛜 Sending message to Pollinations`);
    console.log(`📝 User message preview: ${messageContent.substring(0, 200)}...`);
    

    console.log(`\n========== CHAT MESSAGES SENT ==========\n`);
    chatMessages.forEach((msg, index) => {
      console.log(`  [${msg.role.toUpperCase()}] ${msg.content}`);
    });
    console.log(`\n=========================================\n`);

    const response = await chatCompletion({ messages: chatMessages });
    
    
    if (response.choices && response.choices.length > 0) {
      const assistantMessage = response.choices[0].message.content || '';
      
      // Parse thought and reply sections
      const { thought, reply } = parseThoughtAndReply(assistantMessage);
      
      // 🔍 DEBUG: Log bot response
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🤖 BOT RESPONSE`);
      
      if (thought) {
        console.log(`\n💭 THOUGHT PROCESS:`);
        // Log each line of thought separately
        thought.split('\n').forEach(line => {
          if (line.trim()) {
            console.log(`  ${line.trim()}`);
          }
        });
      }
      
      console.log(`\n💬 REPLY (sent to Discord):`);
      // Log each line of reply separately
      reply.split('\n').forEach(line => {
        if (line.trim()) {
          console.log(`  ${line.trim()}`);
        }
      });
      
      console.log(`\n📏 Length: ${reply.length} chars`);
      console.log(`${'='.repeat(60)}\n`);
      
      // // Store bot response in memory (with target user for roast tracking)
      // if (shouldRespond && assistantMessage) {
      //   await storeBotResponseInMemory(
      //     assistantMessage,
      //     channel.id,
      //     discordMessageObject.client.user?.id || 'bot',
      //     senderId,
      //     senderDisplayName
      //   );
      // }
      
      return reply;  // Return only the reply part
    }

    return '';
  } catch (error) {
    if (error instanceof Error && /timeout/i.test(error.message)) {
      console.error('⚠️ Request timed out.');
      return SURFACE_ERRORS
        ? 'Beep boop. I timed out ⏰ - please try again.'
        : '';
    }
    console.error(error);
    return SURFACE_ERRORS
      ? 'Beep boop. An error occurred. Please message me again later 👾'
      : '';
  } finally {
    if (typingInterval) {
      clearInterval(typingInterval);
    }
  }
}

export { sendMessage, sendTimerMessage, MessageType, splitMessage };
