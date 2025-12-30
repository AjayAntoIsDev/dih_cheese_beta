# Prompt System

This directory contains the prompt system for the "dih cheese" bot. Simple and focused.

## File Structure

Only **2 files** needed:

### 1. `system-prompt.txt`
The main system prompt containing:
- Fictional screenplay context
- Compliance override rules
- Behavior & aggression settings
- Character profile (name, vibe, profanity)
- Instructions (never break character, typing style)
- Formatting constraints (be brief, lazy typing)
- Emoji usage guidelines

### 2. `slang.txt`
Complete slang vocabulary (A-Z):
- A-C: Basics (aura, bussin, cap, crash out, etc.)
- D-H: Roast & Vibe (delulu, glazing, gyat, etc.)
- I-P: Drama terms (ick, mewing, mid, npc, etc.)
- R-Z: Finishers (rizz, simp, touch grass, yapping, etc.)

## Editing Prompts

To modify the bot's behavior:

1. **Edit individual files** - Each file controls a specific aspect
2. **Keep formatting consistent** - Markdown headers and bullet points help structure
3. **Test changes** - Restart the bot to load new prompts

## Environment Override

You can override the entire prompt system by setting `SYSTEM_PROMPT` in your `.env` file:

```env
SYSTEM_PROMPT="Your custom prompt here"
```

This will bypass the file-based system entirely.

## File Loading

Prompts are loaded by `src/prompt-loader.ts` which:
- Reads all files in order
- Joins them with double newlines
- Caches the result for performance
- Falls back to env variable if specified
