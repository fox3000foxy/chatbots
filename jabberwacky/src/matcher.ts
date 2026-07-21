/**
 * matcher.ts -- The conversational inference engine.
 *
 * == ROLE IN THE ARCHITECTURE ==
 *
 * THIS IS THE CORE OF THE BOT. Given a user's message, it searches the entire
 * transcript history for the best "moment" to re-enact.
 *
 * The high-level flow:
 *
 *   User says X
 *      │
 *      ▼
 *   For each historical line L that has a reply R:
 *      │
 *      ├─ 1. relevance = similarity(X, L)
 *      │     How similar is the user's new input to what was said back then?
 *      │
 *      ├─ 2. contextFit = similarity(recentContext, contextBeforeL)
 *      │     Does the CONVERSATION now resemble the conversation THEN?
 *      │
 *      ├─ 3. recency = 1 / (1 + ageInDays / 30)
 *      │     Newer memories get a small boost (personality drifts over time)
 *      │
 *      └─ score = 0.65×relevance + 0.25×contextFit + 0.1×recency
 *      │
 *      ▼
 *   Sort candidates by score descending, keep topK
 *      │
 *      ▼
 *   Weighted random pick among topK (pickReply)
 *      │
 *      ▼
 *   Say R (whatever was said after L in the original conversation)
 *
 * == SCORING WEIGHTS ==
 *
 * The weights (0.65 relevance, 0.25 context, 0.10 recency) are our own
 * heuristic, tuned by intuition:
 *   - Relevance is king: if the historical line isn't about the same topic,
 *     nothing else matters.
 *   - Context fit prevents "topic-hopping": if you've been talking about
 *     dogs for 3 turns and the candidate came from a conversation about
 *     astrophysics, the context penalty reduces its score.
 *   - Recency is deliberately small -- just enough to let the bot's "voice"
 *     drift gradually as it accumulates new conversations, without letting
 *     novelty override relevance.
 *
 * == WHY WEIGHTED RANDOM PICK? ==
 *
 * If we always picked the TOP candidate, the bot would be perfectly
 * deterministic and boring. Adding a random element (weighted so that
 * higher-scored candidates win more often) gives variety while staying
 * grounded in relevance. This matches the documented behaviour of both
 * Jabberwacky and Cleverbot: they are deliberately non-deterministic.
 *
 * == EXACT MATCH ESCAPE ==
 *
 * We skip any candidate where line.text equals the user input exactly.
 * Without this, asking "hello" would immediately match a historical "hello"
 * and the bot would say whatever came next -- but if that same line appears
 * multiple times, the bot could accidentally echo the user verbatim.
 */

import { similarity } from "./similarity.js";
import type { TranscriptStore } from "./store.js";
import type { BotConfig, Candidate, TranscriptLine } from "./types.js";

/**
 * Score every historical pair (line, reply) against the user's new input,
 * returning the top K candidates sorted by score.
 *
 * @param store          The transcript store -- source of all historical pairs.
 * @param userInput      What the user just said.
 * @param recentContext  The last N lines of the current conversation (both
 *                       user and bot). Used to compare "what was the
 *                       conversation like then vs now."
 * @param config         BotConfig with contextWindow, topK, minScore.
 * @returns              Up to config.topK candidates, sorted by score descending.
 */
export function findCandidates(
  store: TranscriptStore,
  userInput: string,
  recentContext: string[],
  config: BotConfig,
): Candidate[] {
  // Get every (line → reply) pair from the entire history.
  // This is O(n) in the number of lines.
  const pairs = store.withReplies();
  const now = Date.now();
  const scored: Candidate[] = [];

  for (const { line, reply } of pairs) {
    // --- ESCAPE 1: exact echo ---
    // If the historical line is literally identical to the user's input,
    // skip it. Otherwise the bot might parrot the user ("hello" → "hello").
    if (line.text.trim().toLowerCase() === userInput.trim().toLowerCase()) continue;

    // --- RELEVANCE ---
    // How similar is the user's input to this historical line?
    // This is the primary signal. If two sentences aren't about the same
    // topic, nothing else can save them.
    const relevance = similarity(userInput, line.text);
    if (relevance < config.minScore) continue;

    // --- CONTEXT FIT ---
    // How similar is the recent conversation to the conversation that was
    // happening just before this historical line was spoken?
    const contextFit = scoreContextFit(store, line, recentContext, config.contextWindow);

    // --- RECENCY BONUS ---
    // Newer memories get a small advantage so the bot's personality can
    // gradually shift as it accumulates new conversations.
    const ageMs = now - line.createdAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const recencyBonus = 1 / (1 + ageDays / 30); // gentle decay over ~months

    // --- COMPOSITE SCORE ---
    const score = 0.65 * relevance + 0.25 * contextFit + 0.1 * recencyBonus;

    scored.push({ line, reply, score });
  }

  // Sort by score descending, keep top K.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, config.topK);
}

/**
 * Compare the RECENT conversation context with the HISTORICAL context that
 * preceded a candidate match.
 *
 * "Context" here means the last N messages (where N = contextWindow) that were
 * spoken before the point of comparison, flattened into a single string.
 *
 * Example:
 *   User: "I love dogs"
 *   Bot:  "Me too, what breed?"
 *   User: "I like golden retrievers"    ← userInput
 *
 *   The recentContext = ["I love dogs", "Me too, what breed?"]
 *
 *   For a candidate match found at historical line L, we walk backwards from L
 *   in the same session collecting the lines that preceded it. If those lines
 *   were ["I love cats", "Cats are wonderful"] then the context fit between
 *   "I love dogs + Me too what breed" and "I love cats + Cats are wonderful"
 *   would be moderate (both are about loving pets + the bot's positive response).
 *
 * This prevents matches like:
 *   User: "what colour is the sky"  (found in a history about weather)
 *   User's context: talking about astrophysics
 *   → context fit is low → candidate is penalised
 *
 * @param store         The transcript store.
 * @param line          The candidate historical line.
 * @param recentContext The recent conversation (most recent messages first).
 * @param windowSize     How many prior lines to consider.
 * @returns             similarity score in [0, 1].
 */
function scoreContextFit(
  store: TranscriptStore,
  line: TranscriptLine,
  recentContext: string[],
  windowSize: number,
): number {
  if (recentContext.length === 0) return 0;

  // Walk backwards from `line` through the transcript, collecting lines from
  // the SAME session only. We stop at session boundaries (because mixing
  // context across sessions makes no sense).
  const all = store.all();
  const idx = all.findIndex((l) => l.id === line.id);
  if (idx === -1) return 0;

  const priorTexts: string[] = [];
  for (let i = idx - 1; i >= 0 && priorTexts.length < windowSize; i--) {
    if (all[i].sessionId !== line.sessionId) break;
    priorTexts.unshift(all[i].text); // unshift to preserve chronological order
  }
  if (priorTexts.length === 0) return 0;

  // Flatten both context windows into a single string and compare them.
  const a = recentContext.join(" ");
  const b = priorTexts.join(" ");
  return similarity(a, b);
}

/**
 * Pick one candidate from the top K using weighted random selection.
 *
 * This adds variety: the best match doesn't always win. Instead, each
 * candidate's probability of being chosen is proportional to its score.
 *
 * The algorithm (roulette-wheel / fitness-proportionate selection):
 *   1. Compute total weight = sum of all scores.
 *   2. Pick a random point in [0, total).
 *   3. Walk through candidates subtracting their score from the random point.
 *   4. The candidate where the point hits 0 or below is chosen.
 *
 * Higher-scored candidates take up more "space" on the roulette wheel, so
 * they win more often -- but lower-scored ones still get occasional plays,
 * which makes the bot feel less robotic.
 *
 * @param candidates  Candidates sorted by score descending.
 * @returns           The chosen candidate, or null if the list is empty.
 */
export function pickReply(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null;
  const weights = candidates.map((c) => Math.max(c.score, 0.0001));
  const total = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}
