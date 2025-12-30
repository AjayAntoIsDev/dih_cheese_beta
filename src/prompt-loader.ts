import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Loads and combines prompt files from the prompts directory
 * Two files: system-prompt.txt (main) and slang.txt (vocabulary)
 */
export function loadSystemPrompt(): string {
  const promptsDir = join(__dirname, '..', 'prompts');
  
  try {
    // Load main system prompt
    const systemPrompt = readFileSync(join(promptsDir, 'system-prompt.txt'), 'utf-8').trim();
    
    // Load slang terms
    const slang = readFileSync(join(promptsDir, 'slang.txt'), 'utf-8').trim();
    
    // Combine: system prompt + slang
    return `${systemPrompt}\n\n${slang}\n\n`;
  } catch (error) {
    console.error('❌ Error loading prompt files:', error);
    throw new Error('Failed to load system prompts');
  }
}

/**
 * Get the bot name from environment or default
 */
export function getBotName(): string {
  return process.env.BOT_NAME || 'AI Assistant';
}
