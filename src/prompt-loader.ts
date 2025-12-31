import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from './config';

/**
 * Replace template placeholders in prompt text
 */
function replacePlaceholders(text: string): string {
  return text.replace(/\{\{BOT_NAME\}\}/g, config.bot.name);
}

/**
 * Loads and combines prompt files from the prompts directory
 * Two files: system-prompt.txt (main) and slang.txt (vocabulary)
 * Replaces {{BOT_NAME}} placeholder with actual bot name from config
 */
export function loadSystemPrompt(): string {
  const promptsDir = join(__dirname, '..', 'prompts');
  
  try {
    // Load main system prompt
    const systemPrompt = readFileSync(join(promptsDir, 'system-prompt.txt'), 'utf-8').trim();
    
    // Load slang terms
    const slang = readFileSync(join(promptsDir, 'slang.txt'), 'utf-8').trim();
    
    // Combine and replace placeholders
    const combined = `${systemPrompt}\n\n${slang}\n\n`;
    return replacePlaceholders(combined);
  } catch (error) {
    console.error('❌ Error loading prompt files:', error);
    throw new Error('Failed to load system prompts');
  }
}

/**
 * Get the bot name from config
 */
export function getBotName(): string {
  return config.bot.name;
}
