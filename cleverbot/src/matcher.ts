import { similarity } from "./similarity.js";
import type { TranscriptStore } from "./store.js";
import type { BotConfig, Candidate, TranscriptLine } from "./types.js";

/**
 * Same retrieval idea as the Jabberwacky port - score every past line by
 * relevance, context fit, and recency - but tuned to two documented
 * Cleverbot traits:
 *
 *   - It only ever matches against the *consolidated* pool (see store.ts),
 *     never the current, still-pending conversation.
 *   - Context is weighted more heavily than in Jabberwacky. Cleverbot is
 *     documented as considering more of the preceding exchange, not just
 *     the single last line, which is why it can seem to "remember" a
 *     couple of turns back mid-conversation even though it never learns
 *     within a session.
 *
 * This is our own scoring function inspired by those documented traits -
 * not a reproduction of anything proprietary.
 */
export function findCandidates(store: TranscriptStore, userInput: string, recentContext: string[], config: BotConfig): Candidate[] {
	const pairs = store.withReplies();
	const now = Date.now();
	const scored: Candidate[] = [];

	for (const { line, reply } of pairs) {
		// Never let the bot literally echo the exact line the user just said,
		// and skip degenerate empty matches.
		if (line.text.trim().toLowerCase() === userInput.trim().toLowerCase()) continue;

		const relevance = similarity(userInput, line.text);
		if (relevance < config.minScore) continue;

		const contextFit = scoreContextFit(store, line, recentContext, config.contextWindow);

		const ageMs = now - line.createdAt;
		const ageDays = ageMs / (1000 * 60 * 60 * 24);
		const recencyBonus = 1 / (1 + ageDays / 30); // gentle decay over ~months

		// Context weighted more heavily than the Jabberwacky port (0.45 vs 0.25),
		// reflecting Cleverbot's documented deeper use of prior turns.
		const score = 0.5 * relevance + 0.4 * contextFit + 0.1 * recencyBonus;

		scored.push({ line, reply, score });
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, config.topK);
}

function scoreContextFit(store: TranscriptStore, line: TranscriptLine, recentContext: string[], windowSize: number): number {
	if (recentContext.length === 0) return 0;

	// Walk backwards from `line` through the same session to gather what
	// preceded it, mirroring `recentContext`. Because many different
	// contributors' sessions are interleaved in the corpus, this is what
	// lets a reply from one "personality" get pulled into a conversation
	// shaped by someone else entirely - the source of Cleverbot's famous
	// inconsistency.
	const all = store.consolidatedLines();
	const idx = all.findIndex((l) => l.id === line.id);
	if (idx === -1) return 0;

	const priorTexts: string[] = [];
	for (let i = idx - 1; i >= 0 && priorTexts.length < windowSize; i--) {
		if (all[i].sessionId !== line.sessionId) break;
		priorTexts.unshift(all[i].text);
	}
	if (priorTexts.length === 0) return 0;

	// Compare the two context windows as bags of text.
	const a = recentContext.join(" ");
	const b = priorTexts.join(" ");
	return similarity(a, b);
}

/** Weighted random pick among the top candidates, favoring higher scores. */
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
