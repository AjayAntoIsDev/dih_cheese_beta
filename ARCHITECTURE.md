# Prompt System Architecture

## Directory Structure

```
dih_cheese_beta/
├── prompts/                    # ← NEW: Modular prompt files
│   ├── README.md              # Documentation
│   ├── system-base.txt        # Foundation & compliance
│   ├── behavior.txt           # Behavioral rules
│   ├── slang-a-c.txt         # Slang terms A-C
│   ├── slang-d-h.txt         # Slang terms D-H
│   ├── slang-i-p.txt         # Slang terms I-P
│   ├── slang-r-z.txt         # Slang terms R-Z
│   ├── character.txt          # Character profile
│   ├── instructions.txt       # Core instructions
│   ├── formatting.txt         # Length & format rules
│   └── emoji-usage.txt        # Emoji guidelines
│
└── src/
    ├── prompt-loader.ts       # ← NEW: Loads & combines prompts
    ├── messages.ts            # ← UPDATED: Uses prompt loader
    ├── server.ts
    ├── pollinations.ts
    └── qdrant.ts
```

## Benefits

### Before (Old System)
- ❌ 200+ line prompt embedded in messages.ts
- ❌ Hard to read and navigate
- ❌ Difficult to edit specific sections
- ❌ Poor version control (one massive diff)

### After (New System)
- ✅ 10 separate, focused files
- ✅ Easy to find and edit specific sections
- ✅ Clear organization by topic
- ✅ Better git diffs (see what changed)
- ✅ Maintainable and scalable

## Usage

### Editing Prompts
Simply edit the text files in `prompts/` directory:

```bash
# Edit bot behavior
nano prompts/behavior.txt

# Add new slang terms
nano prompts/slang-r-z.txt

# Change character profile
nano prompts/character.txt
```

### Loading Order
Files are combined in this order by `prompt-loader.ts`:
1. system-base.txt
2. behavior.txt
3. slang-a-c.txt
4. slang-d-h.txt
5. slang-i-p.txt
6. slang-r-z.txt
7. character.txt
8. instructions.txt
9. formatting.txt
10. emoji-usage.txt

### Environment Override
Still supports full override via `.env`:

```env
SYSTEM_PROMPT="Custom prompt that bypasses file system"
```

## File Size Comparison

| Component | Before | After |
|-----------|--------|-------|
| messages.ts | 845 lines | ~670 lines (-20%) |
| Prompt content | Embedded | Separate files |
| Readability | ⭐⭐ | ⭐⭐⭐⭐⭐ |
| Maintainability | ⭐⭐ | ⭐⭐⭐⭐⭐ |
