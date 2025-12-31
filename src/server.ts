import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, Message, OmitPartialGroupDMChannel, Partials } from 'discord.js';
import { sendMessage, sendTimerMessage, MessageType, splitMessage } from './messages';
import { addToMemoryBuffer } from './memory-buffer';
import { startMemoryCleanupScheduler } from './memory-store';
import { config, getSecrets, printConfig } from './config';
import { logger } from './logger';

logger.info('🚀 Starting Discord bot...');

// Get secrets from environment
const secrets = getSecrets();

logger.info('📋 Secrets check:');
logger.info(`  - DISCORD_TOKEN: ${secrets.discordToken ? '✓ Set' : '✗ Missing'}`);
logger.info(`  - POLLINATIONS_API_KEY: ${secrets.pollinationsApiKey ? '✓ Set' : '✗ Not set (using free tier)'}`);
logger.info(`  - VOYAGEAI_API_KEY: ${secrets.voyageaiApiKey ? '✓ Set' : '✗ Not set'}`);
logger.info(`  - QDRANT_API_KEY: ${secrets.qdrantApiKey ? '✓ Set' : '✗ Not set'}`);
logger.info(`  - QDRANT_ENDPOINT: ${config.qdrant.endpoint ? '✓ Set' : '✗ Missing'}`);

// Print loaded configuration
printConfig();

const app = express();
const PORT = config.server.port;
const RESPOND_TO_DMS = config.discord.respondToDms;
const RESPOND_TO_MENTIONS = config.discord.respondToMentions;
const RESPOND_TO_BOTS = config.discord.respondToBots;
const RESPOND_TO_GENERIC = config.discord.respondToGeneric;
const CHANNEL_ID = config.discord.channelId;
const RESPONSE_CHANNEL_ID = config.discord.responseChannelId;
const TIMER_CHANNEL_ID = config.discord.timerChannelId;
const GENERAL_CHANNEL_ID = config.discord.generalChannelId;
const MESSAGE_REPLY_TRUNCATE_LENGTH = 100;  // how many chars to include
const ENABLE_TIMER = config.timer.enabled;
const TIMER_INTERVAL_MINUTES = config.timer.intervalMinutes;
const FIRING_PROBABILITY = config.timer.firingProbability;
const MESSAGE_BATCH_ENABLED = config.messageBatch.enabled;
const MESSAGE_BATCH_SIZE = config.messageBatch.size;
const MESSAGE_BATCH_TIMEOUT_MS = config.messageBatch.timeoutMs;
const REPLY_IN_THREADS = config.discord.replyInThreads;
const BOT_NAME_TRIGGERS = config.discord.botNameTriggers.map(t => t.toLowerCase());

const ENABLE_MEMORY_BUFFER = config.memoryBuffer.enabled;

function truncateMessage(message: string, maxLength: number): string {
    if (message.length > maxLength) {
        return message.substring(0, maxLength - 3) + '...'; // Truncate and add ellipsis
    }
    return message;
}

logger.discord('Creating Discord client...');
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, // Needed for commands and mentions
    GatewayIntentBits.GuildMessages, // Needed to read messages in servers
    GatewayIntentBits.MessageContent, // Required to read message content
    GatewayIntentBits.DirectMessages, // Needed to receive DMs
  ],
  partials: [Partials.Channel] // Required for handling DMs
});

// Handle process-level errors
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

client.on('error', (error) => {
  logger.error('Discord client error:', error);
});

// Discord Bot Ready Event
client.once('ready', () => {
  logger.success(`Logged in as ${client.user?.tag}!`);
  if (MESSAGE_BATCH_ENABLED) {
    logger.discord(`Message batching enabled: ${MESSAGE_BATCH_SIZE} messages or ${MESSAGE_BATCH_TIMEOUT_MS}ms timeout`);
  }
  
  // Start memory cleanup scheduler if memory is enabled
  if (config.memory.enabled) {
    startMemoryCleanupScheduler(config.memory.cleanupIntervalHours);
  }
});

// Message batching infrastructure
interface BatchedMessage {
  message: OmitPartialGroupDMChannel<Message<boolean>>;
  messageType: MessageType;
  timestamp: number;
}

const channelMessageBuffers = new Map<string, BatchedMessage[]>();
const channelBatchTimers = new Map<string, NodeJS.Timeout>();

async function drainMessageBatch(channelId: string) {
  const buffer = channelMessageBuffers.get(channelId);
  const timer = channelBatchTimers.get(channelId);

  if (timer) {
    clearTimeout(timer);
    channelBatchTimers.delete(channelId);
  }

  if (!buffer || buffer.length === 0) {
    return;
  }

  logger.debug(`Draining batch for channel ${channelId}: ${buffer.length} messages`);

  // Get the last message to use as the reply target
  const lastMessage = buffer[buffer.length - 1].message;
  const canRespond = shouldRespondInChannel(lastMessage);

  // Format all messages in batch
  const batchedContent = buffer.map((bm, idx) => {
    const { message, messageType } = bm;
    const username = message.author.username;
    const userId = message.author.id; // User ID really needed?
    const content = message.content;

    let prefix = '';
    if (messageType === MessageType.MENTION) {
      prefix = `[${username} (id=${userId}) mentioned you] >`;
    } else if (messageType === MessageType.REPLY) {
      prefix = `[${username} (id=${userId}) replied to you] >`;
    } else if (messageType === MessageType.DM) {
      prefix = `[${username} (id=${userId}) sent you a DM] >`;
    } else {
      prefix = `[${username} (id=${userId})] >`; // Fallback
    }

    return `${idx + 1}. ${prefix} ${content}`;
  }).join('\n');

  const channelName = 'name' in lastMessage.channel && lastMessage.channel.name
    ? `#${lastMessage.channel.name}`
    : `channel ${channelId}`;

  const batchMessage = `[Batch of ${buffer.length} messages from ${channelName}]\n${batchedContent}`;

  logger.verbose(`Batch content:\n${batchMessage}`);

  try {
    // Send batch to agent using the last message as context
    const msg = await sendMessage(lastMessage, buffer[buffer.length - 1].messageType, canRespond, batchMessage);

    if (msg !== "" && canRespond) {
      await sendSplitReply(lastMessage, msg);
      logger.debug(`Batch response sent (${msg.length} chars)`);
    } else if (msg !== "" && !canRespond) {
      logger.debug(`Agent generated response but not responding (not in response channel): ${msg}`);
    }
  } catch (error) {
    logger.error("Error processing batch:", error);
  }

  // Clear the buffer
  channelMessageBuffers.delete(channelId);
}

function addMessageToBatch(message: OmitPartialGroupDMChannel<Message<boolean>>, messageType: MessageType) {
  const channelId = message.channel.id;

  if (!channelMessageBuffers.has(channelId)) {
    channelMessageBuffers.set(channelId, []);
  }

  const buffer = channelMessageBuffers.get(channelId)!;
  buffer.push({
    message,
    messageType,
    timestamp: Date.now()
  });

  logger.debug(`Added message to batch (${buffer.length}/${MESSAGE_BATCH_SIZE})`);

  // Check if we should drain due to size
  if (buffer.length >= MESSAGE_BATCH_SIZE) {
    logger.debug(`Batch size limit reached, draining...`);
    drainMessageBatch(channelId);
    return;
  }

  // Set/reset the timeout
  if (channelBatchTimers.has(channelId)) {
    clearTimeout(channelBatchTimers.get(channelId)!);
  }

  const timeout = setTimeout(() => {
    logger.debug(`Batch timeout reached, draining...`);
    drainMessageBatch(channelId);
  }, MESSAGE_BATCH_TIMEOUT_MS);

  channelBatchTimers.set(channelId, timeout);
}

// Helper function to check if bot should respond in this channel
function shouldRespondInChannel(message: OmitPartialGroupDMChannel<Message<boolean>>): boolean {
  // If RESPONSE_CHANNEL_ID is not set, respond everywhere
  if (!RESPONSE_CHANNEL_ID) {
    return true;
  }
  
  // For threads, check the parent channel ID
  const channelId = message.channel.isThread() 
    ? message.channel.parentId 
    : message.channel.id;
    
  // If RESPONSE_CHANNEL_ID is set, only respond in that channel
  return channelId === RESPONSE_CHANNEL_ID;
}

// Helper function to send a message, splitting if necessary
async function sendSplitReply(message: OmitPartialGroupDMChannel<Message<boolean>>, content: string) {
  // Split by single newlines to send each line as separate message
  const lines = content.split(/\n/).filter(p => p.trim());
  
  if (REPLY_IN_THREADS && message.guild !== null) {
    let thread;
    
    if (message.channel.isThread()) {
      thread = message.channel;
    } else if (message.hasThread && message.thread) {
      thread = message.thread;
    } else {
      const threadName = message.content.substring(0, 50) || 'Chat';
      thread = await message.startThread({ name: threadName });
    }
    
    if (thread) {
      for (const line of lines) {
        // Split each line if it exceeds Discord's limit
        const chunks = splitMessage(line);
        for (const chunk of chunks) {
          await thread.send(chunk);
        }
      }
    }
  } else {
    let isFirst = true;
    for (const line of lines) {
      // Split each line if it exceeds Discord's limit
      const chunks = splitMessage(line);
      for (const chunk of chunks) {
        if (isFirst) {
          await message.reply(chunk);
          isFirst = false;
        } else {
          await message.channel.send(chunk);
        }
      }
    }
  }
}

// Helper function to send a message to a channel, splitting if necessary
async function sendSplitMessage(channel: { send: (content: string) => Promise<any> }, content: string) {
  // Split by single newlines to send each line as separate message
  const lines = content.split(/\n/).filter(p => p.trim());
  for (const line of lines) {
    const chunks = splitMessage(line);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  }
}

// Helper function to send a message and receive a response
async function processAndSendMessage(message: OmitPartialGroupDMChannel<Message<boolean>>, messageType: MessageType) {
  // If batching is enabled, add to batch instead of processing immediately
  if (MESSAGE_BATCH_ENABLED) {
    addMessageToBatch(message, messageType);
    return;
  }

  // Otherwise, process immediately (original behavior)
  try {
    const canRespond = shouldRespondInChannel(message);
    const msg = await sendMessage(message, messageType, canRespond);
    if (msg !== "" && canRespond) {
      await sendSplitReply(message, msg);
      logger.info(`Message sent (${msg.length} chars)`);
    } else if (msg !== "" && !canRespond) {
      logger.debug(`Agent generated response but not responding (not in response channel): ${msg}`);
    }
  } catch (error) {
    logger.error("Error processing and sending message:", error);
  }
}


// Function to start a randomized event timer with improved timing
async function startRandomEventTimer() {
  if (!ENABLE_TIMER) {
      logger.info("Timer feature is disabled.");
      return;
  }

  // Set a minimum delay to prevent too-frequent firing (at least 1 minute)
  const minMinutes = 1;
  // Generate random minutes between minMinutes and TIMER_INTERVAL_MINUTES
  const randomMinutes = minMinutes + Math.floor(Math.random() * (TIMER_INTERVAL_MINUTES - minMinutes));
  
  // Log the next timer interval for debugging
  logger.debug(`Timer scheduled to fire in ${randomMinutes} minutes`);
  
  const delay = randomMinutes * 60 * 1000; // Convert minutes to milliseconds

  setTimeout(async () => {
      logger.debug(`Timer fired after ${randomMinutes} minutes`);
      
      // Determine if the event should fire based on the probability
      if (Math.random() < FIRING_PROBABILITY) {
          logger.info(`Random event triggered (${FIRING_PROBABILITY * 100}% chance)`);

          // Get the channel if available
          let channel: { send: (content: string) => Promise<any> } | undefined = undefined;
          if (TIMER_CHANNEL_ID) {
              try {
                  const fetchedChannel = await client.channels.fetch(TIMER_CHANNEL_ID);
                  if (fetchedChannel && 'send' in fetchedChannel) {
                      channel = fetchedChannel as any;
                  } else {
                      logger.warn("Channel not found or is not a text channel.");
                  }
              } catch (error) {
                  logger.error("Error fetching channel:", error);
              }
          }

          // Generate the response via the API, passing the channel for async messages
          const msg = await sendTimerMessage(channel);

          // Send the final assistant message if there is one
          if (msg !== "" && channel) {
              try {
                  await sendSplitMessage(channel, msg);
                  logger.info(`Timer message sent to channel (${msg.length} chars)`);
              } catch (error) {
                  logger.error("Error sending timer message:", error);
              }
          } else if (!channel) {
              logger.debug("No TIMER_CHANNEL_ID defined or channel not available; message not sent.");
          }
      } else {
          logger.debug(`Random event not triggered (${(1 - FIRING_PROBABILITY) * 100}% chance)`);
      }
      
      // Schedule the next timer with a small delay to prevent immediate restarts
      setTimeout(() => {
          startRandomEventTimer(); 
      }, 1000); // 1 second delay before scheduling next timer
  }, delay);
}

// Handle messages mentioning the bot
client.on('messageCreate', async (message) => {
  // Capture message to memory buffer for GENERAL_CHANNEL_ID
  // This runs before any filtering so we capture all messages in the target channel
  if (ENABLE_MEMORY_BUFFER && GENERAL_CHANNEL_ID && message.channel.id === GENERAL_CHANNEL_ID) {
    const isBot = message.author.bot;
    const isSelf = message.author.id === client.user?.id;
    const displayName = message.member?.displayName || message.author.username;
    
    // Add to memory buffer (observed messages from others, outgoing if from bot)
    addToMemoryBuffer(
      message.content,
      message.author.id,
      displayName,
      message.channel.id,
      isBot,
      isSelf ? 'outgoing' : 'observed'
    );
  }

  if (CHANNEL_ID && message.channel.id !== CHANNEL_ID) {
    // Ignore messages from other channels
    logger.verbose(`Ignoring message from other channels (only listening on channel=${CHANNEL_ID})...`);
    return;
  }

  if (message.author.id === client.user?.id) {
    // Ignore messages from the bot itself
    logger.verbose(`Ignoring message from myself...`);
    return;
  }

  if (message.author.bot && !RESPOND_TO_BOTS) {
    // Ignore other bots
    logger.verbose(`Ignoring other bot...`);
    return;
  }

  // Ignore messages that start with !
  if (message.content.startsWith('!')) {
    logger.verbose(`Ignoring message that starts with !...`);
    return;
  }

  // 📨 Handle Direct Messages (DMs)
  if (message.guild === null) { // If no guild, it's a DM
    logger.discord(`Received DM from ${message.author.username}: ${message.content}`);
    if (RESPOND_TO_DMS) {
      processAndSendMessage(message, MessageType.DM);
    } else {
      logger.debug(`Ignoring DM...`);
    }
    return;
  }

  // Check if the bot is mentioned or if the message is a reply to the bot
  const isMention = message.mentions.has(client.user || '');
  const containsBotName = BOT_NAME_TRIGGERS.some(trigger => 
    message.content.toLowerCase().includes(trigger)
  );
  let isReplyToBot = false;
  
  // If it's a reply, check if it's to the bot
  if (message.reference && message.reference.messageId) {
    try {
      const originalMessage = await message.channel.messages.fetch(message.reference.messageId);
      isReplyToBot = originalMessage.author.id === client.user?.id;
    } catch (error) {
      logger.warn(`Could not fetch referenced message: ${error instanceof Error ? error.message : error}`);
    }
  }
  
  if (RESPOND_TO_MENTIONS && (isMention || isReplyToBot || containsBotName)) {
    logger.info(`Received message from ${message.author.username}: ${message.content}${containsBotName && !isMention ? ' (triggered by bot)' : ''}`);

    // Check if we can respond in this channel before showing typing indicator
    const canRespond = shouldRespondInChannel(message);
    logger.debug(`Can respond in this channel: ${canRespond} (channel=${message.channel.id}, responseChannel=${RESPONSE_CHANNEL_ID || 'any'})`);
    if (canRespond) {
      logger.debug(`Sending typing indicator...`);
      if (REPLY_IN_THREADS && message.guild !== null) {
        if (message.channel.isThread()) {
          await message.channel.sendTyping();
        } else if (message.hasThread) {
          await message.thread!.sendTyping();
        } else {
          await message.channel.sendTyping();
        }
      } else {
        await message.channel.sendTyping();
      }
    } else {
      logger.debug(`Skipping typing indicator (observation-only channel)`);
    }

    let msgContent = message.content;
    let messageType = MessageType.MENTION; // Default to mention

    // If it's a reply to the bot, update message type and content
    if (isReplyToBot && message.reference && message.reference.messageId) {
      try {
        const originalMessage = await message.channel.messages.fetch(message.reference.messageId);
        messageType = MessageType.REPLY;
        msgContent = `[Replying to previous message: "${truncateMessage(originalMessage.content, MESSAGE_REPLY_TRUNCATE_LENGTH)}"] ${msgContent}`;
      } catch (error) {
        logger.warn(`Could not fetch referenced message content: ${error instanceof Error ? error.message : error}`);
      }
    }

    // If batching is enabled, add to batch instead of processing immediately
    if (MESSAGE_BATCH_ENABLED) {
      addMessageToBatch(message, messageType);
      return;
    }

    // Otherwise, process immediately (original behavior)
    const msg = await sendMessage(message, messageType, canRespond);
    if (msg !== "" && canRespond) {
      await sendSplitReply(message, msg);
    } else if (msg !== "" && !canRespond) {
      logger.debug(`Agent generated response but not responding (not in response channel): ${msg}`);
    }
    return;
  }

  // Catch-all, generic non-mention message
  if (RESPOND_TO_GENERIC) {
    logger.info(`Received (non-mention) message from ${message.author.username}: ${message.content}`);
    processAndSendMessage(message, MessageType.GENERIC);
    return;
  }
});

// Start the Discord bot
logger.http(`Starting Express server on port ${PORT}...`);
app.listen(PORT, async () => {
  logger.success(`Express server listening on port ${PORT}`);
  
  if (!secrets.discordToken) {
    logger.error('DISCORD_TOKEN not set! Cannot login to Discord.');
    process.exit(1);
  }
  
  try {
    logger.info('Attempting Discord login...');
    await client.login(secrets.discordToken);
    logger.success('Discord login successful');
    startRandomEventTimer();
  } catch (error) {
    logger.error('Discord login failed:', error);
    process.exit(1);
  }
});