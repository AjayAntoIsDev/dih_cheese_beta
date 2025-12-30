# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Discord bot that uses **Pollinations AI** for text generation and **Qdrant** for vector-based long-term memory. The bot can interact with Discord channels and DMs, remember past conversations, and respond with context-aware AI responses.

## Development Commands

```bash
# Install dependencies
npm install

# Run in development mode (with auto-reload)
npm run dev

# Run in production mode
npm start

# Build TypeScript to JavaScript
npm run build
```

## Environment Setup

Copy `.env.template` to `.env` and configure:

### Pollinations AI (Text Generation)
- **POLLINATIONS_API_KEY**: Optional API key from https://enter.pollinations.ai (free tier available)
- **POLLINATIONS_BASE_URL**: API endpoint (default: https://gen.pollinations.ai)
- **POLLINATIONS_MODEL**: AI model to use (openai, gemini, claude, deepseek, grok, etc.)

### Qdrant (Vector Memory)
- **QDRANT**: Your Qdrant Cloud API key
- **QDRANT_ENDPOINT**: Your Qdrant Cloud endpoint URL
- **QDRANT_COLLECTION_NAME**: Collection name for memories (default: discord_memories)
- **QDRANT_VECTOR_SIZE**: Vector dimension (default: 1536)

### Bot Configuration
- **SYSTEM_PROMPT**: Defines the bot's personality and behavior
- **BOT_NAME**: Display name for the bot
- **ENABLE_MEMORY**: Enable/disable long-term memory storage
- **MEMORY_SEARCH_LIMIT**: Number of relevant memories to retrieve

### Discord Configuration
- **APP_ID**, **DISCORD_TOKEN**, **PUBLIC_KEY**: Discord app credentials
- **DISCORD_CHANNEL_ID**: Only listen in this channel (optional)
- **DISCORD_RESPONSE_CHANNEL_ID**: Only respond in this channel (optional)

### Behavior Flags
- **RESPOND_TO_DMS**, **RESPOND_TO_MENTIONS**, **RESPOND_TO_BOTS**, **RESPOND_TO_GENERIC**
- **REPLY_IN_THREADS**: Reply in threads instead of channel
- **USE_SENDER_PREFIX**: Include sender info in messages

### Other Features
- **Message Batching**: `MESSAGE_BATCH_ENABLED`, `MESSAGE_BATCH_SIZE`, `MESSAGE_BATCH_TIMEOUT_MS`
- **Timer Feature**: `ENABLE_TIMER`, `TIMER_INTERVAL_MINUTES`, `FIRING_PROBABILITY`

## Architecture

### Core Files

- **src/server.ts**: Main Discord bot server
  - Sets up Express server and Discord client
  - Handles Discord events (`messageCreate`, `ready`)
  - Routes messages based on type (DM, mention, reply, generic)
  - Implements random timer feature
  - Message batching infrastructure

- **src/messages.ts**: Message handling and AI integration
  - Sends messages to Pollinations AI
  - Manages conversation context and history
  - Integrates with Qdrant for memory retrieval/storage
  - Auto-splits long messages for Discord's 2000 character limit

- **src/pollinations.ts**: Pollinations AI API client
  - OpenAI-compatible chat completions endpoint
  - Streaming and non-streaming response handling
  - Simple text generation endpoint
  - Image generation support (bonus feature)
  - Embedding generation (placeholder implementation)

- **src/qdrant.ts**: Qdrant vector database client
  - Collection management (create, check existence)
  - Memory storage with embeddings
  - Semantic search for relevant memories
  - Recent memories retrieval
  - Memory cleanup utilities

### Message Flow

1. Discord message received → `server.ts` filters based on type and configuration
2. Message stored in Qdrant memory (if enabled)
3. Relevant memories fetched from Qdrant via semantic search
4. Recent conversation history fetched from Discord channel
5. Context assembled: memories + history + current message
6. Request sent to Pollinations AI with system prompt
7. Response received and sent to Discord (auto-split if needed)
8. Bot response stored in Qdrant memory (if enabled)

### Memory System

When `ENABLE_MEMORY=true`:
- Each incoming message is embedded and stored in Qdrant
- Bot responses are also stored
- On each new message, relevant past conversations are retrieved
- Memories are filtered by channel for context relevance
- Supports user-specific memory retrieval

### API Endpoints Used

**Pollinations AI:**
- `POST /v1/chat/completions` - OpenAI-compatible chat
- `GET /text/{prompt}` - Simple text generation
- `GET /image/{prompt}` - Image generation

**Qdrant:**
- Collection management (create, list, get)
- Point operations (upsert, search, scroll, delete)
- Payload indexing for efficient filtering
