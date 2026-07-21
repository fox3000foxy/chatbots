/**
 * Cleverbot, like Jabberwacky, has no rule base: the transcript of every
 * conversation it has ever had IS its brain. Two documented details set it
 * apart from Jabberwacky though, and both are modelled here:
 *
 * 1. It learns from *many different people at once*, so the "personality"
 *    answering you is really a blend of whoever said something similar
 *    before - this is why Cleverbot is famous for contradicting itself.
 *    We tag every line with a `contributorId` to represent this.
 *
 * 2. It does NOT learn within the same conversation. Anything you teach it
 *    only becomes available to be matched against in *future* sessions,
 *    after a periodic consolidation pass (publicly described as Cleverbot's
 *    database being reprocessed rather than updated live). We model this
 *    with a `consolidated` flag: new lines start life in a pending state and
 *    only join the searchable pool once `consolidate()` runs.
 */
export interface TranscriptLine {
	id: number;
	speaker: "human" | "bot";
	text: string;
	/** id of the line this one was said in direct response to, if any */
	respondsTo: number | null;
	/** unix ms timestamp */
	createdAt: number;
	/** which conversation/session this line belongs to */
	sessionId: string;
	/** pseudo-identity of whoever contributed this line, for personality blending */
	contributorId: string;
	/** false until a consolidation pass makes this line matchable */
	consolidated: boolean;
}

export interface Candidate {
	line: TranscriptLine;
	/** the line that historically followed `line` - what we'd say back */
	reply: TranscriptLine;
	score: number;
}

export interface BotConfig {
	/** how many previous turns of context to weigh when matching */
	contextWindow: number;
	/** how many top candidates to sample the final reply from */
	topK: number;
	/** minimum similarity score to accept a match at all */
	minScore: number;
}
