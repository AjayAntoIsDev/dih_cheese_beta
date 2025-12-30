"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageType = void 0;
exports.sendMessage = sendMessage;
exports.sendTimerMessage = sendTimerMessage;
exports.splitMessage = splitMessage;
const pollinations_1 = require("./pollinations");
const qdrant_1 = require("./qdrant");
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
// System prompt for the AI
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || `You are a helpful AI assistant in a Discord server. You are friendly, engaging, and helpful. You remember context from the conversation and respond appropriately. Keep your responses concise but informative.`;
// Bot name for context
const BOT_NAME = process.env.BOT_NAME || 'AI Assistant';
var MessageType;
(function (MessageType) {
    MessageType["DM"] = "DM";
    MessageType["MENTION"] = "MENTION";
    MessageType["REPLY"] = "REPLY";
    MessageType["GENERIC"] = "GENERIC";
})(MessageType || (exports.MessageType = MessageType = {}));
// Initialize memory system
let memoryInitialized = false;
async function ensureMemoryInitialized() {
    if (!memoryInitialized && ENABLE_MEMORY) {
        try {
            await (0, qdrant_1.initializeCollection)();
            memoryInitialized = true;
        }
        catch (error) {
            console.error('❌ Failed to initialize memory system:', error);
        }
    }
}
// Helper function to split text that doesn't contain code blocks
function splitText(text, limit) {
    if (text.length <= limit) {
        return [text];
    }
    const chunks = [];
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
        }
        else {
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
function splitCodeBlock(block, limit) {
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
    const chunks = [];
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
function splitMessage(content, limit = DISCORD_MESSAGE_LIMIT) {
    if (content.length <= limit) {
        return [content];
    }
    const result = [];
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
async function fetchThreadContext(discordMessageObject) {
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
        const fetchOptions = {};
        if (THREAD_MESSAGE_LIMIT > 0) {
            fetchOptions.limit = THREAD_MESSAGE_LIMIT;
        }
        else {
            fetchOptions.limit = 100;
        }
        const messages = await channel.messages.fetch(fetchOptions);
        console.log(`🧵 Fetched ${messages.size} thread messages`);
        const sortedMessages = Array.from(messages.values())
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .filter((msg) => msg.id !== discordMessageObject.id)
            .filter((msg) => !msg.content.startsWith('!'));
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
            const historyLines = sortedMessages.map((msg) => {
                const author = msg.author.username;
                const content = msg.content || '[no text content]';
                return `- ${author}: ${content}`;
            });
            threadContext += historyLines.join('\n') + '\n';
        }
        threadContext += `[End thread context]\n\n`;
        console.log(`🧵 Thread context formatted`);
        return threadContext;
    }
    catch (error) {
        console.error('🧵 Error fetching thread context:', error);
        return '';
    }
}
// Helper function to fetch and format conversation history
async function fetchConversationHistory(discordMessageObject) {
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
            const author = msg.author.username;
            const content = msg.content || '[no text content]';
            return `- ${author}: ${content}`;
        });
        const historyBlock = `[Recent conversation context:]\n${historyLines.join('\n')}\n[End context]\n\n`;
        console.log(`📚 Conversation history formatted`);
        return historyBlock;
    }
    catch (error) {
        console.error('�� Error fetching conversation history:', error);
        return '';
    }
}
// Fetch relevant memories from Qdrant
async function fetchRelevantMemories(message, channelId) {
    if (!ENABLE_MEMORY) {
        return '';
    }
    await ensureMemoryInitialized();
    try {
        const embedding = await (0, pollinations_1.generateEmbedding)(message);
        const memories = await (0, qdrant_1.searchMemories)(embedding, {
            limit: MEMORY_SEARCH_LIMIT,
            channelId,
            scoreThreshold: 0.3
        });
        if (memories.length === 0) {
            console.log(`🧠 No relevant memories found`);
            return '';
        }
        console.log(`🧠 Found ${memories.length} relevant memories`);
        const memoryLines = memories.map(mem => {
            const date = new Date(mem.timestamp).toLocaleDateString();
            return `- [${date}] ${mem.username}: ${mem.content}`;
        });
        return `[Relevant past conversations:]\n${memoryLines.join('\n')}\n[End memories]\n\n`;
    }
    catch (error) {
        console.error('🧠 Error fetching memories:', error);
        return '';
    }
}
// Store a message in memory
async function storeMessageInMemory(message, messageType) {
    if (!ENABLE_MEMORY) {
        return;
    }
    await ensureMemoryInitialized();
    try {
        const content = message.content;
        if (!content || content.startsWith('!')) {
            return;
        }
        const embedding = await (0, pollinations_1.generateEmbedding)(content);
        const memoryEntry = {
            id: message.id,
            content,
            userId: message.author.id,
            username: message.author.username,
            channelId: message.channel.id,
            timestamp: message.createdTimestamp,
            messageType,
            isBot: message.author.bot
        };
        await (0, qdrant_1.storeMemory)(memoryEntry, embedding);
    }
    catch (error) {
        console.error('🧠 Error storing message in memory:', error);
    }
}
// Store bot response in memory
async function storeBotResponseInMemory(response, channelId, botUserId) {
    if (!ENABLE_MEMORY || !response) {
        return;
    }
    await ensureMemoryInitialized();
    try {
        const embedding = await (0, pollinations_1.generateEmbedding)(response);
        const memoryEntry = {
            id: `bot-${Date.now()}`,
            content: response,
            userId: botUserId,
            username: BOT_NAME,
            channelId,
            timestamp: Date.now(),
            messageType: 'BOT_RESPONSE',
            isBot: true
        };
        await (0, qdrant_1.storeMemory)(memoryEntry, embedding);
    }
    catch (error) {
        console.error('🧠 Error storing bot response in memory:', error);
    }
}
// Send timer message (for scheduled events)
async function sendTimerMessage(channel) {
    const timerPrompt = `[SYSTEM EVENT] This is an automated timed event. You may use this opportunity to share a thought, ask an engaging question, or simply reflect. Keep it brief and natural for a Discord chat.`;
    try {
        console.log(`🛜 Sending timer message to Pollinations`);
        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: timerPrompt }
        ];
        const response = await (0, pollinations_1.chatCompletion)({ messages });
        if (response.choices && response.choices.length > 0) {
            return response.choices[0].message.content || '';
        }
        return '';
    }
    catch (error) {
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
async function sendMessage(discordMessageObject, messageType, shouldRespond = true, batchedMessage) {
    const { author: { username: senderName, id: senderId }, content: message, channel, guild } = discordMessageObject;
    // Store incoming message in memory
    await storeMessageInMemory(discordMessageObject, messageType);
    // Fetch conversation history
    const conversationHistory = await fetchConversationHistory(discordMessageObject);
    // Fetch relevant memories
    const relevantMemories = await fetchRelevantMemories(message, channel.id);
    // Get channel context
    let channelContext = '';
    if (guild === null) {
        channelContext = '';
        console.log(`📍 Channel context: DM (no channel name)`);
    }
    else if ('name' in channel && channel.name) {
        channelContext = ` in #${channel.name}`;
        console.log(`📍 Channel context: #${channel.name}`);
    }
    else {
        channelContext = ` in channel (id=${channel.id})`;
        console.log(`📍 Channel context: channel ID ${channel.id}`);
    }
    const senderNameReceipt = `${senderName} (id=${senderId})`;
    // Build the message content
    let messageContent;
    if (batchedMessage) {
        messageContent = batchedMessage;
        if (!shouldRespond && channelContext) {
            messageContent += `\n\n[IMPORTANT: You are only observing these messages. You cannot respond in this channel.]`;
        }
        else if (shouldRespond) {
            messageContent += `\n\n[You CAN respond to these messages.]`;
        }
    }
    else if (USE_SENDER_PREFIX) {
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
        messageContent = relevantMemories + conversationHistory + currentMessagePrefix + responseNotice;
    }
    else {
        messageContent = relevantMemories + conversationHistory + message;
    }
    // Build chat messages for Pollinations
    const chatMessages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: messageContent }
    ];
    // Typing indicator
    let typingInterval;
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
        console.log(`�� Sending message to Pollinations`);
        console.log(`📝 User message preview: ${messageContent.substring(0, 200)}...`);
        const response = await (0, pollinations_1.chatCompletion)({ messages: chatMessages });
        if (response.choices && response.choices.length > 0) {
            const assistantMessage = response.choices[0].message.content || '';
            // Store bot response in memory
            if (shouldRespond && assistantMessage) {
                await storeBotResponseInMemory(assistantMessage, channel.id, discordMessageObject.client.user?.id || 'bot');
            }
            return assistantMessage;
        }
        return '';
    }
    catch (error) {
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
    }
    finally {
        if (typingInterval) {
            clearInterval(typingInterval);
        }
    }
}
