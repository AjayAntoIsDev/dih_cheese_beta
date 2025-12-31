// Pollinations AI API Client
// OpenAI-compatible API at https://gen.pollinations.ai

import { config, getSecrets } from './config';
import { logger } from './logger';

const secrets = getSecrets();
const POLLINATIONS_BASE_URL = config.pollinations.baseUrl;
const POLLINATIONS_API_KEY = secrets.pollinationsApiKey;
const POLLINATIONS_MODEL = config.pollinations.model;
const FREQUENCY_PENALTY = config.pollinations.frequencyPenalty;
const PRESENCE_PENALTY = config.pollinations.presencePenalty;

// Available models from Pollinations
export const POLLINATIONS_TEXT_MODELS = [
  'openai',
  'openai-fast',
  'openai-large',
  'qwen-coder',
  'mistral',
  'openai-audio',
  'gemini',
  'gemini-fast',
  'deepseek',
  'grok',
  'gemini-search',
  'claude-fast',
  'claude',
  'claude-large',
  'perplexity-fast',
  'perplexity-reasoning',
  'kimi-k2-thinking',
  'gemini-large',
  'nova-micro'
] as const;

export type PollinationsModel = typeof POLLINATIONS_TEXT_MODELS[number];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  model?: PollinationsModel;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  seed?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }>;
}

// Get authorization headers
function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  if (POLLINATIONS_API_KEY) {
    headers['Authorization'] = `Bearer ${POLLINATIONS_API_KEY}`;
  }
  
  return headers;
}

// Non-streaming chat completion with retry logic
export async function chatCompletion(
  options: ChatCompletionOptions
): Promise<ChatCompletionResponse> {
  const { 
    model = POLLINATIONS_MODEL as PollinationsModel, 
    messages, 
    temperature, 
    max_tokens, 
    seed,
    frequency_penalty = FREQUENCY_PENALTY,
    presence_penalty = PRESENCE_PENALTY
  } = options;
  
  const url = `${POLLINATIONS_BASE_URL}/v1/chat/completions`;
  
  const body: any = {
    model,
    messages,
    stream: false
  };
  
  if (temperature !== undefined) body.temperature = temperature;
  if (max_tokens !== undefined) body.max_tokens = max_tokens;
  if (seed !== undefined) body.seed = seed;
  if (frequency_penalty !== 0) body.frequency_penalty = frequency_penalty;
  if (presence_penalty !== 0) body.presence_penalty = presence_penalty;
  
  const MAX_RETRIES = 3;
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.llm(`Sending chat completion request to Pollinations (model: ${model})${attempt > 1 ? ` [Attempt ${attempt}/${MAX_RETRIES}]` : ''}`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(body)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`Pollinations API error (${response.status}): ${errorText}`);
        
        // Retry on 429 (rate limit) or 5xx (server errors)
        if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
          logger.warn(`Request failed with status ${response.status}, retrying in ${attempt * 2} seconds...`);
          await new Promise(resolve => setTimeout(resolve, attempt * 2000)); // Exponential backoff
          lastError = error;
          continue;
        }
        
        throw error;
      }
      
      const data = await response.json() as ChatCompletionResponse;
      logger.success('Received response from Pollinations');
      
      return data;
    } catch (error) {
      lastError = error as Error;
      
      // Only retry on network errors or if we haven't exhausted retries
      if (attempt < MAX_RETRIES && (error as any).code !== 'ABORT_ERR') {
        logger.warn(`Request failed: ${(error as Error).message}, retrying in ${attempt * 2} seconds...`);
        await new Promise(resolve => setTimeout(resolve, attempt * 2000));
        continue;
      }
      
      throw error;
    }
  }
  
  // Should never reach here, but just in case
  throw lastError || new Error('Max retries exceeded');
}

// Streaming chat completion
export async function* chatCompletionStream(
  options: ChatCompletionOptions
): AsyncGenerator<StreamChunk, void, unknown> {
  const { 
    model = POLLINATIONS_MODEL as PollinationsModel, 
    messages, 
    temperature, 
    max_tokens, 
    seed,
    frequency_penalty = FREQUENCY_PENALTY,
    presence_penalty = PRESENCE_PENALTY
  } = options;
  
  const url = `${POLLINATIONS_BASE_URL}/v1/chat/completions`;
  
  const body: any = {
    model,
    messages,
    stream: true
  };
  
  if (temperature !== undefined) body.temperature = temperature;
  if (max_tokens !== undefined) body.max_tokens = max_tokens;
  if (seed !== undefined) body.seed = seed;
  if (frequency_penalty !== 0) body.frequency_penalty = frequency_penalty;
  if (presence_penalty !== 0) body.presence_penalty = presence_penalty;
  
  logger.llm(`Starting streaming chat completion (model: ${model})`);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body)
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Pollinations API error (${response.status}): ${errorText}`);
  }
  
  if (!response.body) {
    throw new Error('No response body for streaming');
  }
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      
      // Process complete SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer
      
      for (const line of lines) {
        const trimmed = line.trim();
        
        if (trimmed === '' || trimmed === 'data: [DONE]') continue;
        
        if (trimmed.startsWith('data: ')) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            yield json as StreamChunk;
          } catch (e) {
            // Skip invalid JSON
            logger.warn('Invalid JSON in stream:', trimmed);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  
  logger.success('Streaming completed');
}

// Simple text generation (non-chat endpoint)
export async function generateText(
  prompt: string,
  options: {
    model?: PollinationsModel;
    system?: string;
    temperature?: number;
    seed?: number;
  } = {}
): Promise<string> {
  const { model = POLLINATIONS_MODEL as PollinationsModel, system, temperature, seed } = options;
  
  const params = new URLSearchParams();
  params.set('model', model);
  if (system) params.set('system', system);
  if (temperature !== undefined) params.set('temperature', temperature.toString());
  if (seed !== undefined) params.set('seed', seed.toString());
  if (POLLINATIONS_API_KEY) params.set('key', POLLINATIONS_API_KEY);
  
  const url = `${POLLINATIONS_BASE_URL}/text/${encodeURIComponent(prompt)}?${params.toString()}`;
  
  logger.llm(`Generating text with Pollinations (model: ${model})`);
  
  const response = await fetch(url);
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Pollinations API error (${response.status}): ${errorText}`);
  }
  
  const text = await response.text();
  logger.success(`Text generated (${text.length} chars)`);
  
  return text;
}

// Generate embeddings using Pollinations
// Note: Pollinations doesn't have a dedicated embeddings endpoint,
// so we'll use a simple text-based approach or fall back to another service
export async function generateEmbedding(text: string): Promise<number[]> {
  // For now, we'll use a simple hash-based embedding as a placeholder
  // In production, you might want to use OpenAI's embeddings API or a local model
  
  // This is a simple deterministic "embedding" for demonstration
  // Replace with actual embedding service in production
  const EMBEDDING_SIZE = config.qdrant.vectorSize;
  
  // Simple hash-based pseudo-embedding (NOT suitable for production semantic search)
  // This is just to make the system work - replace with real embeddings
  const embedding: number[] = new Array(EMBEDDING_SIZE).fill(0);
  
  // Use text characters to generate deterministic values
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    const idx = i % EMBEDDING_SIZE;
    embedding[idx] = (embedding[idx] + charCode / 256) % 1;
  }
  
  // Normalize the vector
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= magnitude;
    }
  }
  
  return embedding;
}

// Get list of available models
export async function getAvailableModels(): Promise<any> {
  const url = `${POLLINATIONS_BASE_URL}/v1/models`;
  
  const response = await fetch(url, {
    headers: getHeaders()
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status}`);
  }
  
  return response.json();
}

// Generate image (bonus feature)
export async function generateImage(
  prompt: string,
  options: {
    model?: 'flux' | 'turbo' | 'gptimage' | 'kontext' | 'seedream';
    width?: number;
    height?: number;
    seed?: number;
    enhance?: boolean;
    nologo?: boolean;
  } = {}
): Promise<string> {
  const { model = 'flux', width = 1024, height = 1024, seed, enhance = false, nologo = true } = options;
  
  const params = new URLSearchParams();
  params.set('model', model);
  params.set('width', width.toString());
  params.set('height', height.toString());
  if (seed !== undefined) params.set('seed', seed.toString());
  if (enhance) params.set('enhance', 'true');
  if (nologo) params.set('nologo', 'true');
  if (POLLINATIONS_API_KEY) params.set('key', POLLINATIONS_API_KEY);
  
  // Return the URL that can be used directly (Pollinations returns image at this URL)
  return `${POLLINATIONS_BASE_URL}/image/${encodeURIComponent(prompt)}?${params.toString()}`;
}

export { POLLINATIONS_BASE_URL, POLLINATIONS_MODEL };
