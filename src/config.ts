/**
 * Centralized Configuration System
 * 
 * Loads configuration from:
 * 1. config.yaml (main configuration)
 * 2. Environment variables (for secrets only - overrides yaml for sensitive data)
 * 
 * Secrets that should stay in .env:
 * - DISCORD_TOKEN
 * - POLLINATIONS_API_KEY
 * - VOYAGEAI_API_KEY
 * - QDRANT (api key)
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

// Config file path
const CONFIG_PATH = process.env.CONFIG_PATH || join(__dirname, '..', 'config.yaml');

// TypeScript interfaces for configuration
export interface DiscordConfig {
  channelId?: string;
  responseChannelId?: string;
  timerChannelId?: string;
  generalChannelId?: string;
  respondToDms: boolean;
  respondToMentions: boolean;
  respondToBots: boolean;
  respondToGeneric: boolean;
  replyInThreads: boolean;
  botNameTriggers: string[];
}

export interface ServerConfig {
  port: number;
}

export interface PollinationsConfig {
  baseUrl: string;
  model: string;
  imageModel: string;
  imageGenerationEnabled: boolean;
  includePromptInImage: boolean;
  frequencyPenalty: number;
  presencePenalty: number;
}

export interface TimerConfig {
  enabled: boolean;
  intervalMinutes: number;
  firingProbability: number;
}

export interface MessageBatchConfig {
  enabled: boolean;
  size: number;
  timeoutMs: number;
}

export interface MessagesConfig {
  useSenderPrefix: boolean;
  surfaceErrors: boolean;
  contextMessageCount: number;
  threadContextEnabled: boolean;
  threadMessageLimit: number;
}

export interface MemoryBufferConfig {
  enabled: boolean;
  silenceTimeoutMs: number;
  volumeThreshold: number;
  tokenCap: number;
  managerModel: string;
}

export interface MemoryConfig {
  enabled: boolean;
  searchLimit: number;
  userFactCount: number;
  serverLoreCount: number;
  cleanupIntervalHours: number;
  retention: {
    lowImportanceHours: number;   // importance 1-4
    medImportanceHours: number;   // importance 5-7
    highImportanceHours: number;  // importance 8-9
    // importance 10 = permanent
  };
}

export interface QdrantConfig {
  endpoint?: string;
  collectionName: string;
  vectorSize: number;
}

export interface VoyageAIConfig {
  model: string;
}

export interface BotConfig {
  name: string;
}

export interface RelationshipsConfig {
  dataDir: string;
}

export interface LoggingConfig {
  level: 'error' | 'warn' | 'info' | 'debug' | 'verbose';
  fileEnabled: boolean;
  errorLogFile: string;
  combinedLogFile: string;
}

export interface AppConfig {
  bot: BotConfig;
  server: ServerConfig;
  discord: DiscordConfig;
  pollinations: PollinationsConfig;
  timer: TimerConfig;
  messageBatch: MessageBatchConfig;
  messages: MessagesConfig;
  memoryBuffer: MemoryBufferConfig;
  memory: MemoryConfig;
  qdrant: QdrantConfig;
  voyageai: VoyageAIConfig;
  relationships: RelationshipsConfig;
  logging: LoggingConfig;
}

// Default configuration
const defaultConfig: AppConfig = {
  bot: {
    name: 'dih cheese'
  },
  server: {
    port: 3001
  },
  discord: {
    respondToDms: false,
    respondToMentions: true,
    respondToBots: false,
    respondToGeneric: false,
    replyInThreads: false,
    botNameTriggers: ['dih cheese']
  },
  pollinations: {
    baseUrl: 'https://gen.pollinations.ai',
    model: 'openai',
    imageModel: 'turbo',
    imageGenerationEnabled: true,
    includePromptInImage: true,
    frequencyPenalty: 0,
    presencePenalty: 0
  },
  timer: {
    enabled: false,
    intervalMinutes: 15,
    firingProbability: 0.1
  },
  messageBatch: {
    enabled: false,
    size: 10,
    timeoutMs: 30000
  },
  messages: {
    useSenderPrefix: true,
    surfaceErrors: false,
    contextMessageCount: 5,
    threadContextEnabled: true,
    threadMessageLimit: 50
  },
  memoryBuffer: {
    enabled: false,
    silenceTimeoutMs: 300000,  // 5 minutes
    volumeThreshold: 30,
    tokenCap: 2000,
    managerModel: 'openai-fast'
  },
  memory: {
    enabled: false,
    searchLimit: 5,
    userFactCount: 5,
    serverLoreCount: 3,
    cleanupIntervalHours: 6,
    retention: {
      lowImportanceHours: 24,     // 1 day for importance 1-4
      medImportanceHours: 168,    // 1 week for importance 5-7
      highImportanceHours: 504    // 3 weeks for importance 8-9
    }
  },
  qdrant: {
    collectionName: 'discord_memories',
    vectorSize: 1024
  },
  voyageai: {
    model: 'voyage-3-large'
  },
  relationships: {
    dataDir: join(__dirname, '..', 'data')
  },
  logging: {
    level: 'info',
    fileEnabled: false,
    errorLogFile: 'logs/error.log',
    combinedLogFile: 'logs/combined.log'
  }
};

// Deep merge helper
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  
  for (const key in source) {
    if (source[key] !== undefined) {
      if (
        typeof source[key] === 'object' &&
        source[key] !== null &&
        !Array.isArray(source[key]) &&
        typeof target[key] === 'object' &&
        target[key] !== null
      ) {
        result[key] = deepMerge(target[key], source[key] as any);
      } else {
        result[key] = source[key] as any;
      }
    }
  }
  
  return result;
}

// Load and parse config
function loadConfig(): AppConfig {
  let fileConfig: Partial<AppConfig> = {};
  
  // Try to load YAML config
  if (existsSync(CONFIG_PATH)) {
    try {
      const fileContent = readFileSync(CONFIG_PATH, 'utf-8');
      fileConfig = yaml.load(fileContent) as Partial<AppConfig> || {};
      console.log(`ℹ️  Loaded configuration from ${CONFIG_PATH}`);
    } catch (error) {
      console.error('❌ Error loading config.yaml:', error);
      console.log('ℹ️  Using default configuration');
    }
  } else {
    console.log(`ℹ️  No config.yaml found at ${CONFIG_PATH}, using defaults`);
  }
  
  // Merge with defaults
  const config = deepMerge(defaultConfig, fileConfig);
  
  // Override with environment variables for secrets (these should NOT be in yaml)
  // Discord token is handled separately in server.ts
  
  // Qdrant endpoint (can be in yaml or env)
  if (process.env.QDRANT_ENDPOINT) {
    config.qdrant.endpoint = process.env.QDRANT_ENDPOINT;
  }
  
  return config;
}

// Secrets that must come from environment (not in config)
export interface Secrets {
  discordToken?: string;
  pollinationsApiKey?: string;
  voyageaiApiKey?: string;
  qdrantApiKey?: string;
}

export function getSecrets(): Secrets {
  return {
    discordToken: process.env.DISCORD_TOKEN,
    pollinationsApiKey: process.env.POLLINATIONS_API_KEY,
    voyageaiApiKey: process.env.VOYAGEAI_API_KEY,
    qdrantApiKey: process.env.QDRANT
  };
}

// Export singleton config
export const config: AppConfig = loadConfig();

// Initialize logger after config is loaded
import { initLogger } from './logger';
initLogger(config.logging);

// Helper to print config (without secrets)
export function printConfig(): void {
  console.log('\n⚙️  Configuration:');
  console.log('  Bot:');
  console.log(`    - name: ${config.bot.name}`);
  console.log('  Server:');
  console.log(`    - port: ${config.server.port}`);
  console.log('  Discord:');
  console.log(`    - respondToDms: ${config.discord.respondToDms}`);
  console.log(`    - respondToMentions: ${config.discord.respondToMentions}`);
  console.log(`    - respondToGeneric: ${config.discord.respondToGeneric}`);
  console.log(`    - replyInThreads: ${config.discord.replyInThreads}`);
  console.log(`    - botNameTriggers: ${config.discord.botNameTriggers.join(', ')}`);
  console.log('  Pollinations:');
  console.log(`    - model: ${config.pollinations.model}`);
  console.log('  Timer:');
  console.log(`    - enabled: ${config.timer.enabled}`);
  console.log(`    - intervalMinutes: ${config.timer.intervalMinutes}`);
  console.log('  Message Batch:');
  console.log(`    - enabled: ${config.messageBatch.enabled}`);
  console.log('  Memory:');
  console.log(`    - enabled: ${config.memory.enabled}`);
  console.log(`    - bufferEnabled: ${config.memoryBuffer.enabled}`);
  console.log('  Qdrant:');
  console.log(`    - endpoint: ${config.qdrant.endpoint ? '✓ Set' : '✗ Not set'}`);
  console.log(`    - collection: ${config.qdrant.collectionName}`);
  console.log(`    - vectorSize: ${config.qdrant.vectorSize}`);
  console.log('  Logging:');
  console.log(`    - level: ${config.logging.level}`);
  console.log(`    - fileEnabled: ${config.logging.fileEnabled}`);
}

// Re-export for convenience
export default config;
