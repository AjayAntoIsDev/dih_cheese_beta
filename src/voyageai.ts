/**
 * VoyageAI Client for generating text embeddings
 */

import { VoyageAIClient } from 'voyageai';
import { config, getSecrets } from './config';
import { logger } from './logger';

// Configuration from YAML config and secrets
const secrets = getSecrets();
const VOYAGEAI_API_KEY = secrets.voyageaiApiKey;
const VOYAGEAI_MODEL = config.voyageai.model;

// Initialize client
let voyageClient: VoyageAIClient | null = null;

function getVoyageClient(): VoyageAIClient {
  if (!voyageClient) {
    if (!VOYAGEAI_API_KEY) {
      throw new Error('VOYAGEAI_API_KEY is not set in environment');
    }
    voyageClient = new VoyageAIClient({ apiKey: VOYAGEAI_API_KEY });
    logger.database(`VoyageAI client initialized (model: ${VOYAGEAI_MODEL})`);
  }
  return voyageClient;
}

/**
 * Generate embedding for a single text
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const client = getVoyageClient();
  
  try {
    const result = await client.embed({
      input: text,
      model: VOYAGEAI_MODEL,
      inputType: 'document'
    });
    
    if (!result.data || result.data.length === 0 || !result.data[0].embedding) {
      throw new Error('No embedding returned from VoyageAI');
    }
    
    return result.data[0].embedding;
  } catch (error) {
    logger.error('VoyageAI embedding error:', error);
    throw error;
  }
}

/**
 * Generate embeddings for multiple texts (batch)
 * More efficient than calling generateEmbedding multiple times
 */
export async function generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  
  const client = getVoyageClient();
  
  try {
    logger.database(`Generating embeddings for ${texts.length} texts...`);
    
    const result = await client.embed({
      input: texts,
      model: VOYAGEAI_MODEL,
      inputType: 'document'
    });
    
    if (!result.data || result.data.length !== texts.length) {
      throw new Error(`Expected ${texts.length} embeddings, got ${result.data?.length || 0}`);
    }
    
    // Sort by index to ensure correct order
    const sorted = [...result.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const embeddings = sorted.map(d => {
      if (!d.embedding) {
        throw new Error('Missing embedding in VoyageAI response');
      }
      return d.embedding;
    });
    
    logger.success(`Generated ${embeddings.length} embeddings (dim: ${embeddings[0]?.length || 0})`);
    
    return embeddings;
  } catch (error) {
    logger.error('VoyageAI batch embedding error:', error);
    throw error;
  }
}

/**
 * Generate embedding for a search query
 * Uses inputType: 'query' for better search results
 */
export async function generateQueryEmbedding(query: string): Promise<number[]> {
  const client = getVoyageClient();
  
  try {
    const result = await client.embed({
      input: query,
      model: VOYAGEAI_MODEL,
      inputType: 'query'  // Use 'query' for search queries
    });
    
    if (!result.data || result.data.length === 0 || !result.data[0].embedding) {
      throw new Error('No embedding returned from VoyageAI');
    }
    
    return result.data[0].embedding;
  } catch (error) {
    logger.error('VoyageAI query embedding error:', error);
    throw error;
  }
}

export { VOYAGEAI_MODEL };
