# Language Detection — Programmatic Response Language Control

The virtual tutor must respond in the same language the student uses. A student who writes in French should receive French responses; if they switch to English mid-conversation, the tutor should switch too.

This document explains the problem, why previous approaches failed, how the current solution works, and every implementation detail.

---

## Table of Contents

1. [The Problem](#the-problem)
2. [Why Prompt-Only Approaches Fail](#why-prompt-only-approaches-fail)
3. [Solution: Programmatic Language Detection](#solution-programmatic-language-detection)
4. [The tinyld Problem with Short Texts](#the-tinyld-problem-with-short-texts)
5. [The Curated Short Text Map](#the-curated-short-text-map)
6. [Injection Strategy: Two-Point Placement](#injection-strategy-two-point-placement)
7. [Modified Files](#modified-files)
8. [Testing](#testing)

---

## The Problem

The system prompt contains approximately 3000 tokens of context in Spanish: the exercise statement, expert reasoning, netlist, dataset examples, and knowledge graph entries. When the system prompt instructs the LLM to "respond in the same language as the student", the model (qwen2.5) ignores this instruction. It sees overwhelming Spanish context and anchors to Spanish regardless of the student's language.

This is known as **linguistic inertia** — the LLM defaults to the dominant language in its context window rather than following a generic instruction about language adaptation.

---

## Why Prompt-Only Approaches Fail

Three approaches were tried before arriving at the current solution:

### Approach 1: Generic instruction in the system prompt

```
STRICT RULES:
- ALWAYS respond in the EXACT same language the student used in their last message.
```

**Why it fails:** The instruction is generic ("same language") and requires the LLM to detect the student's language on its own. With 3000 tokens of Spanish context and a short student message like "Hello", the LLM lacks the reasoning capacity to override its Spanish inertia.

### Approach 2: Translated hints and guardrails

The RAG augmentation hints and guardrail retry instructions were translated from Spanish to English, reducing the amount of Spanish in the prompt.

**Why it fails partially:** It reduces the Spanish context but does not eliminate it. The exercise statement, expert reasoning, netlist, and dataset examples remain in Spanish and still dominate. When these elements make up 60-70% of the prompt, removing Spanish from the remaining 30% is not enough.

### Approach 3: "IMPORTANT REMINDER" appended to system prompt

```
IMPORTANT REMINDER: ALWAYS respond in the same language the student used in their last message.
```

**Why it fails:** Still generic. The LLM sees "same language" but does not know what that language is. It would need to detect the language itself from the student's message, which it fails to do when the student message is short (e.g., "Hello", "Oui") and surrounded by Spanish context.

### Why a specific, programmatic instruction works

The key insight: the LLM does not need to **detect** the language — we can detect it server-side and tell the LLM **explicitly** which language to use:

```
[LANGUAGE INSTRUCTION]
The student is writing in French. You MUST respond ONLY in French.
```

This works because:
1. The instruction names a specific language ("French"), not a generic rule ("same language")
2. The word "MUST" and "ONLY" are strong constraint tokens that LLMs are trained to follow
3. The instruction is placed at the end of the prompt, maximizing recency bias
4. The LLM does not need to reason about language detection — it just follows an explicit command

---

## Solution: Programmatic Language Detection

The system uses the [`tinyld`](https://www.npmjs.com/package/tinyld) library for language detection. It is a lightweight, zero-dependency, CommonJS-native library that supports 62 languages and works well with texts longer than ~15 characters.

**File:** `backend/src/utils/promptBuilder.js`

**Function:** `getLanguageInstruction(text)`

```javascript
function getLanguageInstruction(text) {
  var trimmed = text.trim();
  var code = SHORT_LANG_MAP[trimmed.toLowerCase()] || detect(trimmed);
  var langName = LANG_NAMES[code];  // e.g., "fr" → "French"
  return "\n\n[LANGUAGE INSTRUCTION]\nThe student is writing in " + langName +
    ". You MUST respond ONLY in " + langName + ".";
}
```

The function takes the student's raw message, detects the language code (e.g., `"fr"`), maps it to a human-readable name (e.g., `"French"`), and returns a formatted instruction string. If detection fails, it returns an empty string and no language instruction is injected (the LLM falls back to its default behavior).

### LANG_NAMES Map

A mapping from ISO 639-1 codes to English language names, covering all 62 languages supported by tinyld:

| Code | Language | Code | Language | Code | Language |
|------|----------|------|----------|------|----------|
| en | English | fr | French | es | Spanish |
| de | German | it | Italian | pt | Portuguese |
| ca | Catalan | nl | Dutch | ru | Russian |
| ja | Japanese | zh | Chinese | ko | Korean |
| ar | Arabic | hi | Hindi | ... | (62 total) |

English names are used instead of ISO codes because the LLM understands "respond in French" better than "respond in fr".

---

## The tinyld Problem with Short Texts

While tinyld works reliably for texts longer than ~15 characters, it produces incorrect or empty results for short inputs — exactly the kind of messages students frequently send:

| Input | tinyld detects | Correct | Issue |
|-------|---------------|---------|-------|
| `"Hello"` | `it` (Italian) | `en` (English) | "Hello" exists in Italian vocabulary |
| `"Hi"` | `` (empty) | `en` (English) | Too short to classify |
| `"Hola"` | `` (empty) | `es` (Spanish) | Too short to classify |
| `"Ciao"` | `` (empty) | `it` (Italian) | Too short to classify |
| `"Oui"` | `pt` (Portuguese) | `fr` (French) | Statistical confusion |
| `"Yes"` | `ber` (Berber) | `en` (English) | Statistical confusion |
| `"Guten Tag"` | `rn` (Kirundi) | `de` (German) | Statistical confusion |
| `"Olá"` | `tr` (Turkish) | `pt` (Portuguese) | Diacritical confusion |

This is a fundamental limitation of n-gram-based language detection: short texts do not contain enough statistical signal for reliable classification.

---

## The Curated Short Text Map

**Solution:** A hand-curated map of ~80 common short phrases in 7 languages. The map is consulted **before** tinyld. If the student's message (lowercased) matches a map entry, that language is used directly. If not, tinyld handles it.

```javascript
var code = SHORT_LANG_MAP[trimmed.toLowerCase()] || detect(trimmed);
```

### Why this order matters

The `||` operator provides clean fallback logic:
1. If the exact lowercased text is in `SHORT_LANG_MAP`, use that language (reliable for known short phrases)
2. If not, fall back to `tinyld` (reliable for longer texts)

### Languages covered in the map

| Language | Example entries |
|----------|----------------|
| English | `hello`, `hi`, `hey`, `yes`, `no`, `ok`, `sure`, `thanks`, `of course`, `i think`, `i don't know`, `why`, `how` |
| French | `bonjour`, `salut`, `oui`, `merci`, `d'accord`, `pourquoi`, `je pense`, `je ne sais pas`, `s'il vous plaît` |
| Spanish | `hola`, `sí`, `si`, `gracias`, `vale`, `bueno`, `claro`, `por qué`, `no sé`, `creo que`, `por favor` |
| German | `hallo`, `guten tag`, `ja`, `nein`, `danke`, `natürlich`, `warum`, `bitte`, `ich denke`, `ich verstehe` |
| Italian | `ciao`, `buongiorno`, `grazie`, `perché`, `certo`, `capisco`, `per favore`, `va bene` |
| Portuguese | `olá`, `obrigado`, `obrigada`, `sim`, `bom dia`, `boa tarde`, `entendo` |
| Catalan | `bon dia`, `gràcies`, `si us plau`, `bona tarda`, `adéu`, `d'acord`, `entenc` |

### Design decisions

**Why not a larger map?** The map only needs to cover phrases that (a) tinyld gets wrong and (b) students actually send. Common greetings, affirmations, negations, and short tutoring phrases cover the vast majority of short student messages. Longer messages (full sentences) are handled reliably by tinyld.

**Why only lowercase matching?** Student input is normalized to lowercase before lookup (`trimmed.toLowerCase()`). This means `"HELLO"`, `"Hello"`, and `"hello"` all match correctly without needing separate entries.

**Why include both `"si"` and `"sí"` for Spanish?** Students may or may not type the accent mark. Both forms are common in informal typing.

**Why is `"no"` mapped to English?** The word "no" exists in Spanish, Italian, and Portuguese as well. English is chosen as the default because: (a) in the tutoring context, a Spanish-speaking student would more likely type a longer affirmation/negation, and (b) the exercise context is already in Spanish, so the system prompt's Spanish context provides a natural fallback. If a Spanish-speaking student types just "no", the language instruction says English, but the 3000 tokens of Spanish context and the conversation history in Spanish will still keep the LLM responding in Spanish. This is an acceptable trade-off — the map optimizes for the cases where tinyld fails catastrophically (e.g., "Hello" → Italian).

---

## Injection Strategy: Two-Point Placement

The language instruction is injected at **two positions** in the message array sent to the LLM:

### Position 1: End of the system prompt

```
[System prompt: ~3000 tokens of exercise context, rules, expert reasoning...]

[LANGUAGE INSTRUCTION]
The student is writing in English. You MUST respond ONLY in English.
```

This ensures the instruction is part of the system prompt, establishing it as a system-level constraint.

### Position 2: Last message in the array (after conversation history)

```
messages = [
  { role: "system",    content: systemPrompt + langInstruction },   // Position 1
  { role: "user",      content: "Bonjour" },                        // history
  { role: "assistant", content: "Bonjour! Où pensez-vous que..." }, // history
  { role: "user",      content: "Hello" },                          // current message
  { role: "system",    content: langInstruction }                    // Position 2
]
```

**Why two positions?** Because the first position alone is not enough. When the conversation history contains multiple turns in a previous language (e.g., French), the LLM sees the system prompt instruction at the top, then several French messages, and anchors to French despite the system instruction. By repeating the instruction as the **last message** in the array, it sits immediately before the LLM generates its response, maximizing recency bias.

**Why this solves the language switching problem:** When a student sends "Bonjour" (French), then "Hello" (English), the conversation history contains French messages. Without Position 2, the LLM sees:

```
system: "...respond in English..." (buried at top)
user: "Bonjour"
assistant: "Bonjour! Où pensez-vous..."
user: "Hello"
→ LLM generates in French (anchored to history)
```

With Position 2:

```
system: "...respond in English..." (Position 1)
user: "Bonjour"
assistant: "Bonjour! Où pensez-vous..."
user: "Hello"
system: "respond ONLY in English" (Position 2 — right before generation)
→ LLM generates in English
```

---

## Modified Files

### 1. `backend/package.json` — New dependency

```
"tinyld": "^1.3.4"
```

Zero-dependency, CommonJS-native library. 62 language support. ~200KB installed size.

### 2. `backend/src/utils/promptBuilder.js` — Detection logic

| Change | Description |
|--------|-------------|
| Added `require("tinyld")` | Import the `detect` function |
| Added `LANG_NAMES` | ISO 639-1 → English name mapping (62 languages) |
| Added `SHORT_LANG_MAP` | Curated map of ~80 short phrases in 7 languages |
| Added `getLanguageInstruction(text)` | Main detection function: map lookup → tinyld fallback → formatted instruction |
| Updated `module.exports` | Export `getLanguageInstruction` alongside `buildTutorSystemPrompt` |

### 3. `backend/src/rag/ragMiddleware.js` — RAG route injection (6 points)

| Injection point | What is injected |
|-----------------|------------------|
| After `var text = userMessage.trim()` | Compute `langInstruction` once for the request |
| Deterministic finish system prompt | `buildSystemPrompt(ejercicio) + langInstruction` |
| Deterministic finish messages | Push `langInstruction` as last system message |
| Main RAG prompt | `basePrompt + ragAugmentation + langInstruction` + last system message after history |
| Guardrail retry (leak) | `strongerPrompt + langInstruction` + last system message |
| Guardrail retry (false confirmation) | `confirmPrompt + langInstruction` + last system message |
| Guardrail retry (state reveal) | `statePrompt + langInstruction` + last system message |

### 4. `backend/src/routes/ollamaChatRoutes.js` — Non-RAG route injection (4 points)

| Injection point | What is injected |
|-----------------|------------------|
| After `const text = userMessage.trim()` | Compute `langInstruction` once for the request |
| Deterministic finish on stream | System prompt + langInstruction + last system message |
| Main streaming handler | Replaces the old generic `IMPORTANT REMINDER` with specific language instruction + last system message |
| Start-exercise | System prompt + langInstruction for first message + last system message |

**What was removed:** The generic string `"\n\nIMPORTANT REMINDER: ALWAYS respond in the same language the student used in their last message."` was replaced entirely by the programmatic language instruction.

### 5. `backend/tests/testLanguageDetection.js` — Unit tests (new file)

43 test cases covering:

- **Phase 1 (32 tests):** Short text detection via curated map — verifies that every problematic input tinyld gets wrong is handled correctly by the map
- **Phase 2 (6 tests):** Longer text detection via tinyld — verifies tinyld works for sentence-length inputs in 6 languages
- **Phase 3 (5 tests):** Edge cases — empty string, null, single character, output format validation

---

## Testing

```bash
cd backend
node tests/testLanguageDetection.js
```

Expected output: `Passed: 43/43`

### What the tests verify

| Test type | What it catches |
|-----------|----------------|
| Short text map (32 tests) | tinyld misdetections for "Hello", "Hi", "Hola", etc. |
| tinyld fallback (6 tests) | Regression if tinyld stops working for longer texts |
| Edge cases (5 tests) | Null/empty inputs that could crash the server |
