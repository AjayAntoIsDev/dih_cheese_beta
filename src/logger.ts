/**
 * Centralized Logger using Winston
 * 
 * Supports configurable log levels and formatted output
 */

import winston from 'winston';

// Custom format for console output with colors and emojis
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  })
);

// Create winston logger instance with default level (will be updated by initLogger)
const winstonLogger = winston.createLogger({
  level: 'info', // Default level
  transports: [
    new winston.transports.Console({
      format: consoleFormat
    })
  ]
});

/**
 * Initialize logger with config (called after config is loaded)
 */
export function initLogger(loggingConfig: { level: string; fileEnabled: boolean; errorLogFile?: string; combinedLogFile?: string }) {
  // Update log level
  winstonLogger.level = loggingConfig.level;
  
  // Add file logging if enabled
  if (loggingConfig.fileEnabled) {
    winstonLogger.add(new winston.transports.File({
      filename: loggingConfig.errorLogFile || 'logs/error.log',
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      )
    }));
    
    winstonLogger.add(new winston.transports.File({
      filename: loggingConfig.combinedLogFile || 'logs/combined.log',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      )
    }));
  }
}

/**
 * Logger wrapper with emoji prefixes for better visual parsing
 */
export const logger = {
  // Error level - always shown
  error: (message: string, ...meta: any[]) => {
    winstonLogger.error(`❌ ${message}`, ...meta);
  },
  
  // Warning level
  warn: (message: string, ...meta: any[]) => {
    winstonLogger.warn(`⚠️  ${message}`, ...meta);
  },
  
  // Info level - general information
  info: (message: string, ...meta: any[]) => {
    winstonLogger.info(`ℹ️  ${message}`, ...meta);
  },
  
  // Success messages
  success: (message: string, ...meta: any[]) => {
    winstonLogger.info(`✅ ${message}`, ...meta);
  },
  
  // Debug level - detailed debugging
  debug: (message: string, ...meta: any[]) => {
    winstonLogger.debug(`🔍 ${message}`, ...meta);
  },
  
  // Verbose/trace level - very detailed
  verbose: (message: string, ...meta: any[]) => {
    winstonLogger.verbose(`📝 ${message}`, ...meta);
  },
  
  // Special categories with emojis
  discord: (message: string, ...meta: any[]) => {
    winstonLogger.info(`💬 [Discord] ${message}`, ...meta);
  },
  
  memory: (message: string, ...meta: any[]) => {
    winstonLogger.debug(`🧠 [Memory] ${message}`, ...meta);
  },
  
  llm: (message: string, ...meta: any[]) => {
    winstonLogger.debug(`🤖 [LLM] ${message}`, ...meta);
  },
  
  database: (message: string, ...meta: any[]) => {
    winstonLogger.debug(`💾 [Database] ${message}`, ...meta);
  },
  
  http: (message: string, ...meta: any[]) => {
    winstonLogger.debug(`🌐 [HTTP] ${message}`, ...meta);
  },
  
  // Raw winston logger for advanced usage
  raw: winstonLogger
};

export default logger;
