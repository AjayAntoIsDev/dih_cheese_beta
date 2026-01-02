# Lil Dih

**The most human chatbot that remembers**

The most human-like Discord bot with human-like memory and personality.

---

## Features

- **Long-term Memory** — Remembers users, drama, and inside jokes using vectors
- **Relationships** — Tracks how it feels about each user 
- **Image Generation** — Has the ability to generate images
- **Personality** — Responds like a real person (maybe a bit brain-rotted)

---

## Getting Started

### 1. Clone and install
```bash
git clone https://github.com/AjayAntoIsDev/dih_cheese_beta.git
cd dih_cheese_beta
npm install
```

### 2. Config files
```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

### 3. Set up your `.env`
```env
DISCORD_TOKEN=your_discord_bot_token
VOYAGEAI_API_KEY=your_voyageai_key       # For embeddings
QDRANT_API_KEY=your_qdrant_key           # For vector storage
QDRANT_ENDPOINT=https://xxx.qdrant.io    # Your Qdrant cluster URL
```

### 4. Edit `config.yaml`
- Config is pretty self-explanatory

### 5. Run it
```bash
npm run dev
```

---

## Workflow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         MESSAGE COMES IN                                │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  1. CONTEXT GATHERING                                                   │
│     • Grab last N messages from the channel                             │
│     • Look up relationship                                              │
│     • Search vector DB for memories about this user                     │
│     • Search for relevant "server lore" (shared memories)               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  2. PROMPT CONSTRUCTION                                                 │
│     • Personality + behavior rules                                      │
│     • Current date/time                                                 │
│     • Relationship status                                               │
│     • Relevant memories:                                                │
│     • Server lore:                                                      │
│     • Recent conversation context                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  3. LLM GENERATES RESPONSE                                              │
│     Pollinations API with free models like grok, openai, claude         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  4. SEND TO DISCORD                                                     │
│     • Parse response, extract image prompts if any                      │
│     • Generate image if requested                                       │
│     • Send message(s) to Discord                                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  5. MEMORY BUFFER                                                       │
│     Triggers:                                                           │
│     • Silence (5 min no activity)                                       │
│     • Volume (30+ messages)                                             │
│     • Token cap reached                                                 │
│                                                                         │
│     LLM extracts:                                                       │
│     • User facts                                                        │
│     • Server lore                                                       │
│     • Relationship updates                                              │
│                                                                         │
│     They get embedded (VoyageAI) and stored in Qdrant                   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## The Memory System

The bot uses **Retrieval-Augmented Generation (RAG)** for memory:

### Generation:
1. Messages are stored in a buffer as people chat
2. When triggered (silence/volume/tokens), A smaller LLM reads through the conversation
3. It extracts important facts and assigns importance scores (1-10)
4. Memories get converted to vector embeddings using VoyageAI
5. Stored in Qdrant (vector db) with metadata

### Retrieval:
2. Cosine similarity to find relevant memories
3. Memories are scored by: `(similarity × 0.55) + (importance × 0.25) + (recency × 0.20)`
4. Top memories are injected into the system prompt

---

## Relationships

```json
{
  "user_id": "123456789",
  "username": "CoolGuy",
  "affinity_score": 7,
  "last_interaction": "2026-01-02T15:30:00Z",
  "interaction_count": 42
}
```
- The bot's will behave differently according to the affinity (nicer to friends, pettier to enemies)
---

## License

MIT

---