/**
 * index.ts -- Main entry point: REPL chat loop for the Jabberwacky bot.
 *
 * == WHAT THIS DOES ==
 *
 * 1. Loads the transcript from data/transcript.json (or starts fresh).
 * 2. Seeds it with hand-written seed conversations if empty (first run).
 * 3. Enters a read-eval-print loop where every user message:
 *    a. Is appended to the transcript
 *    b. Triggers candidate search in matcher.ts
 *    c. A reply is selected and printed
 *    d. The reply is also appended to the transcript
 *    e. The entire transcript is saved to disk
 * 4. On /quit, saves one last time and exits.
 *
 * == THE COMPLETE PIPELINE (visual) ==
 *
 *   ┌─────────────┐
 *   │ User types   │
 *   │ "hello"      │
 *   └──────┬──────┘
 *          ▼
 *   ┌──────────────────────────────────────┐
 *   │ store.append("human", "hello", ...)  │  ← record input
 *   └──────────────────────────────────────┘
 *          ▼
 *   ┌──────────────────────────────────────┐
 *   │ findCandidates(store, "hello",       │
 *   │   recentContext, config)             │  ← search history
 *   └──────────────────────────────────────┘
 *          ▼
 *   ┌──────────────────────────────────────┐
 *   │ pickReply(candidates)                │  ← weighted random pick
 *   └──────────────────────────────────────┘
 *          ▼
 *   ┌──────────────────────────────────────┐
 *   │ store.append("bot", reply,           │
 *   │   userLine.id, sessionId)            │  ← record reply
 *   │ console.log("Bot: " + reply)         │  ← show user
 *   └──────────────────────────────────────┘
 *          ▼
 *   ┌──────────────────────────────────────┐
 *   │ store.save()                         │  ← persist to disk
 *   └──────────────────────────────────────┘
 *          ▼
 *   ┌──────────────────────────────────────┐
 *   │ Wait for next user input             │  ← loop
 *   └──────────────────────────────────────┘
 *
 * == SESSION MODEL ==
 *
 * Each run creates one sessionId = `session_${Date.now()}`. All lines spoken
 * during this run share that sessionId. This matters for context scoring:
 * when scoreContextFit() walks backwards from a historical line, it only
 * looks at lines within the same session -- it never mixes contexts across
 * different conversations.
 *
 * The seed corpus has its own sessionId `__seed__`, so seed lines are
 * isolated from real conversations for context-scoring purposes.
 *
 * == CONTEXT WINDOW MANAGEMENT ==
 *
 * recentContext is an array of the last N lines of dialogue (where N =
 * config.contextWindow * 2). It's trimmed after each turn to stay within
 * that size. This prevents the context from growing unbounded during a
 * long session and keeps the similarity comparison focused on the most
 * recent exchanges.
 *
 * == FALLBACK BEHAVIOUR ==
 *
 * If no candidate passes minScore, the bot says:
 *   "I have no idea what to say to that yet."
 *
 * This IS recorded in the transcript, so if another user (or the same user)
 * says something similar later, that fallback itself becomes a candidate
 * reply. This is how the bot learns from its own failures -- exactly the
 * same bootstrapping dynamic that let the original Jabberwacky grow from
 * 20,000 hand-made exchanges to millions.
 */

import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { findCandidates, pickReply } from "./matcher.js";
import { SEED_CONVERSATIONS } from "./seed.js";
import { TranscriptStore } from "./store.js";
import type { BotConfig } from "./types.js";

// Construct an absolute path to data/transcript.json relative to this source file.
// __dirname isn't available in ES modules, so we derive it from import.meta.url.
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "..", "data", "transcript.json");

/**
 * Default configuration. These are good starting values; tweak as the corpus grows.
 *
 *   contextWindow: 2 → look at the last 4 lines of conversation (2 user + 2 bot)
 *                      when scoring context fit.
 *   topK: 20        → keep the 20 best candidates, then pick one at random.
 *   minScore: 0.08  → anything below 8% similarity is a non-sequitur.
 */
const config: BotConfig = {
  contextWindow: 2,
  topK: 20,
  minScore: 0.08,
};

/**
 * Load the seed corpus into an empty store.
 *
 * Each SEED_CONVERSATIONS entry is an alternating string array:
 *   [human_1, bot_1, human_2, bot_2, ...]
 *
 * We convert this into TranscriptLine objects, chaining each to the previous
 * via respondsTo. The first line has respondsTo = null (it starts a new
 * conversation). All seed lines share sessionId = "__seed__" so they're
 * isolated from real conversations for context scoring.
 *
 * This only runs ONCE -- on subsequent launches, store.size() > 0 because
 * the transcript file already exists, and we skip seeding.
 */
function seedStore(store: TranscriptStore): void {
  if (store.size() > 0) return;
  const sessionId = "__seed__";
  for (const conv of SEED_CONVERSATIONS) {
    let prevId: number | null = null;
    for (let i = 0; i < conv.length; i++) {
      const speaker = i % 2 === 0 ? "human" : "bot";
      const line = store.append(speaker, conv[i], prevId, sessionId);
      prevId = line.id;
    }
  }
  store.save();
  console.log(`Seeded ${store.size()} lines from corpus.`);
}

/**
 * Main REPL loop.
 *
 * Flow (per turn):
 *   1. Read user input
 *   2. Append to transcript (as "human" speaker)
 *   3. Push to recentContext
 *   4. Search for candidates with findCandidates()
 *   5. Pick one with pickReply() (or use fallback)
 *   6. Append the reply to transcript (as "bot" speaker)
 *   7. Push reply to recentContext
 *   8. Trim recentContext to keep it bounded
 *   9. Save transcript to disk
 *   10. Loop back to step 1
 */
async function main() {
  // Initialise the store -- loads existing transcript or starts empty.
  const store = new TranscriptStore(DATA_PATH);

  // Seed on first run only.
  seedStore(store);

  // Context: the last few lines of this conversation, used for context-fit scoring.
  const recentContext: string[] = [];

  // All lines spoken during THIS session share one sessionId.
  const sessionId = `session_${Date.now()}`;

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("\nJabberwacky -- starting conversation (type /quit to exit).\n");

  // Wrapper to convert readline.question callback into a Promise for await.
  const ask = (): Promise<string> =>
    new Promise((resolve) => rl.question("You:  ", resolve));

  let input = await ask();

  while (input.trim().toLowerCase() !== "/quit") {
    // Skip empty lines without recording them.
    if (!input.trim()) {
      input = await ask();
      continue;
    }

    // --- RECORD USER INPUT ---
    const userLine = store.append("human", input.trim(), null, sessionId);
    recentContext.push(input.trim());

    // --- FIND AND PICK A REPLY ---
    const candidates = findCandidates(store, input.trim(), recentContext, config);
    const pick = pickReply(candidates);

    if (pick) {
      // --- RECORD AND DISPLAY THE CHOSEN REPLY ---
      store.append("bot", pick.reply.text, userLine.id, sessionId);
      console.log(`Bot:  ${pick.reply.text}`);
      recentContext.push(pick.reply.text);
    } else {
      // --- FALLBACK: no candidate passed minScore ---
      const fallback = "I have no idea what to say to that yet.";
      store.append("bot", fallback, userLine.id, sessionId);
      console.log(`Bot:  ${fallback}`);
      recentContext.push(fallback);
    }

    // --- TRIM CONTEXT: keep only the last N messages ---
    if (recentContext.length > config.contextWindow * 2) {
      recentContext.splice(0, recentContext.length - config.contextWindow * 2);
    }

    // --- PERSIST EVERYTHING TO DISK ---
    store.save();

    // --- NEXT TURN ---
    input = await ask();
  }

  // --- CLEAN SHUTDOWN ---
  store.save();
  rl.close();
  console.log(`\nSaved ${store.size()} lines. Goodbye.`);
}

main().catch(console.error);
