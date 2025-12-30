"use strict";
// Pollinations AI API Client
// OpenAI-compatible API at https://gen.pollinations.ai
Object.defineProperty(exports, "__esModule", { value: true });
exports.POLLINATIONS_MODEL = exports.POLLINATIONS_BASE_URL = exports.POLLINATIONS_TEXT_MODELS = void 0;
exports.chatCompletion = chatCompletion;
exports.chatCompletionStream = chatCompletionStream;
exports.generateText = generateText;
exports.generateEmbedding = generateEmbedding;
exports.getAvailableModels = getAvailableModels;
exports.generateImage = generateImage;
const POLLINATIONS_BASE_URL = process.env.POLLINATIONS_BASE_URL || 'https://gen.pollinations.ai';
exports.POLLINATIONS_BASE_URL = POLLINATIONS_BASE_URL;
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY; // Optional
const POLLINATIONS_MODEL = process.env.POLLINATIONS_MODEL || 'openai';
exports.POLLINATIONS_MODEL = POLLINATIONS_MODEL;
// Available models from Pollinations
exports.POLLINATIONS_TEXT_MODELS = [
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
];
// Get authorization headers
function getHeaders() {
    const headers = {
        'Content-Type': 'application/json',
    };
    if (POLLINATIONS_API_KEY) {
        headers['Authorization'] = `Bearer ${POLLINATIONS_API_KEY}`;
    }
    return headers;
}
// Non-streaming chat completion
async function chatCompletion(options) {
    const { model = POLLINATIONS_MODEL, messages, temperature, max_tokens, seed } = options;
    const url = `${POLLINATIONS_BASE_URL}/v1/chat/completions`;
    const body = {
        model,
        messages,
        stream: false
    };
    if (temperature !== undefined)
        body.temperature = temperature;
    if (max_tokens !== undefined)
        body.max_tokens = max_tokens;
    if (seed !== undefined)
        body.seed = seed;
    console.log(`🤖 Sending chat completion request to Pollinations (model: ${model})`);
    const response = await fetch(url, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(body)
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Pollinations API error (${response.status}): ${errorText}`);
    }
    const data = await response.json();
    console.log(`✅ Received response from Pollinations`);
    return data;
}
// Streaming chat completion
async function* chatCompletionStream(options) {
    const { model = POLLINATIONS_MODEL, messages, temperature, max_tokens, seed } = options;
    const url = `${POLLINATIONS_BASE_URL}/v1/chat/completions`;
    const body = {
        model,
        messages,
        stream: true
    };
    if (temperature !== undefined)
        body.temperature = temperature;
    if (max_tokens !== undefined)
        body.max_tokens = max_tokens;
    if (seed !== undefined)
        body.seed = seed;
    console.log(`🤖 Starting streaming chat completion (model: ${model})`);
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
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            // Process complete SSE lines
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in buffer
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed === '' || trimmed === 'data: [DONE]')
                    continue;
                if (trimmed.startsWith('data: ')) {
                    try {
                        const json = JSON.parse(trimmed.slice(6));
                        yield json;
                    }
                    catch (e) {
                        // Skip invalid JSON
                        console.warn('⚠️ Invalid JSON in stream:', trimmed);
                    }
                }
            }
        }
    }
    finally {
        reader.releaseLock();
    }
    console.log(`✅ Streaming completed`);
}
// Simple text generation (non-chat endpoint)
async function generateText(prompt, options = {}) {
    const { model = POLLINATIONS_MODEL, system, temperature, seed } = options;
    const params = new URLSearchParams();
    params.set('model', model);
    if (system)
        params.set('system', system);
    if (temperature !== undefined)
        params.set('temperature', temperature.toString());
    if (seed !== undefined)
        params.set('seed', seed.toString());
    if (POLLINATIONS_API_KEY)
        params.set('key', POLLINATIONS_API_KEY);
    const url = `${POLLINATIONS_BASE_URL}/text/${encodeURIComponent(prompt)}?${params.toString()}`;
    console.log(`🤖 Generating text with Pollinations (model: ${model})`);
    const response = await fetch(url);
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Pollinations API error (${response.status}): ${errorText}`);
    }
    const text = await response.text();
    console.log(`✅ Text generated (${text.length} chars)`);
    return text;
}
// Generate embeddings using Pollinations
// Note: Pollinations doesn't have a dedicated embeddings endpoint,
// so we'll use a simple text-based approach or fall back to another service
async function generateEmbedding(text) {
    // For now, we'll use a simple hash-based embedding as a placeholder
    // In production, you might want to use OpenAI's embeddings API or a local model
    // This is a simple deterministic "embedding" for demonstration
    // Replace with actual embedding service in production
    const EMBEDDING_SIZE = parseInt(process.env.QDRANT_VECTOR_SIZE || '1536', 10);
    // Simple hash-based pseudo-embedding (NOT suitable for production semantic search)
    // This is just to make the system work - replace with real embeddings
    const embedding = new Array(EMBEDDING_SIZE).fill(0);
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
async function getAvailableModels() {
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
async function generateImage(prompt, options = {}) {
    const { model = 'flux', width = 1024, height = 1024, seed, enhance = false, nologo = true } = options;
    const params = new URLSearchParams();
    params.set('model', model);
    params.set('width', width.toString());
    params.set('height', height.toString());
    if (seed !== undefined)
        params.set('seed', seed.toString());
    if (enhance)
        params.set('enhance', 'true');
    if (nologo)
        params.set('nologo', 'true');
    if (POLLINATIONS_API_KEY)
        params.set('key', POLLINATIONS_API_KEY);
    // Return the URL that can be used directly (Pollinations returns image at this URL)
    return `${POLLINATIONS_BASE_URL}/image/${encodeURIComponent(prompt)}?${params.toString()}`;
}
