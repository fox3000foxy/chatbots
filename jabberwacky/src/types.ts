/**
 * types.ts -- Core data model for the Jabberwacky-style chatbot.
 *
 * == ARCHITECTURAL OVERVIEW ==
 *
 * Jabberwacky (1997–2008) was an AI chatbot by Rollo Carpenter that pioneered
 * an approach radically different from ELIZA or ALICE: instead of hand-written
 * pattern-matching rules, it stored EVERY line ever spoken to it in a giant
 * flat transcript, and answered new input by finding the most similar moment
 * in its history and reusing whatever was said next on that earlier occasion.
 *
 *   User: "hello"
 *     ↓
 *   Find: has anyone ever said "hello" before? Yes, in session #3 on line 14.
 *     ↓
 *   What happened next in that session? The bot replied "hi there, who are you?"
 *     ↓
 *   Reply: "hi there, who are you?"
 *
 * This means:
 *   - There is NO rule base. No grammar. No templates. No AIML.
 *   - The entire "brain" is just a list of (context → response) pairs drawn
 *     from real conversations.
 *   - The bot learns organically: every conversation it has is appended to
 *     the transcript, so over time the pool of possible matches grows.
 *   - Personality emerges from the aggregate of everything people have said
 *     to it -- the bot is literally a "remix" of past conversations.
 *
 * Cleverbot (launched 2008) is the direct descendant -- it uses the exact same
 * idea at scale (hundreds of millions of lines), with more sophisticated
 * scoring heuristics.
 *
 * This implementation reproduces that architecture:
 *
 *   TranscriptStore  ←  all lines ever, persisted to JSON on disk
 *         ↓
 *   similarity()     ←  compare two strings (Jaccard + bigram overlap)
 *         ↓
 *   findCandidates() ←  scan history for similar moments, score them
 *         ↓
 *   pickReply()      ←  weighted random selection among top candidates
 *
 * == TRANSCRIPT LINE MODEL ==
 *
 * Every line spoken by ANY speaker (human or bot) is one TranscriptLine.
 * Lines are linked via respondsTo: line B has respondsTo = A's id if B was
 * spoken directly after A. This lets the matcher walk backward to see what
 * conversation preceded a given line.
 */

/**
 * A single utterance -- one line of dialogue in any conversation the bot has
 * ever witnessed. The flat, ever-growing array of these IS the "brain".
 */
export interface TranscriptLine {
  /** Monotonically increasing unique ID. The store uses this for respondsTo links. */
  id: number;
  /** Who said it. The bot stores its own replies alongside human input. */
  speaker: "human" | "bot";
  /** The raw text that was said. */
  text: string;
  /**
   * The ID of the TranscriptLine this one was said in direct response to.
   * null if it's the start of a conversation (no prior line to respond to).
   *
   * This is how we build pairs: if line L has respondsTo = K, then L is the
   * "reply" to K. The scoring algorithm finds lines that resemble the user's
   * new input, then returns whatever was said after them.
   */
  respondsTo: number | null;
  /** Unix millisecond timestamp of when this line was created. Used for recency scoring. */
  createdAt: number;
  /**
   * Which conversation/session this line belongs to. When walking backward
   * from a line to gather context, we stop at session boundaries -- context
   * from a completely different conversation shouldn't mix with this one.
   */
  sessionId: string;
}

/**
 * A candidate match found by the scoring engine.
 * - `line` is the historical line that resembles the user's new input
 * - `reply` is what was actually said after `line` in the original conversation
 * - `score` is the composite score (0..1, higher = better match)
 */
export interface Candidate {
  line: TranscriptLine;
  /** The line that historically followed `line` -- this is what we'll say back. */
  reply: TranscriptLine;
  score: number;
}

/**
 * Tunable parameters that control the matching behaviour.
 *
 * These exist because the original Jabberwacky's exact scoring heuristics
 * were never published. We expose the knobs so you can experiment with
 * different trade-offs between relevance, context sensitivity, and novelty.
 */
export interface BotConfig {
  /**
   * How many previous turns of conversation to consider when scoring context fit.
   * e.g. 2 means "compare the user's last 2 messages + the bot's last 2 replies
   * against the conversation that preceded each candidate match."
   * Higher values make the bot more sensitive to topic continuity but require
   * more data to find good context matches.
   */
  contextWindow: number;
  /**
   * After scoring all candidates, keep only the top K and pick one at random
   * (weighted by score). Higher values = more variety, but lower-quality replies
   * occasionally slip through. Lower values = more conservative, always picking
   * the best match.
   */
  topK: number;
  /**
   * Absolute minimum similarity score (0..1) for a candidate to be considered
   * at all. This prevents the bot from replying with complete non-sequiturs
   * when it has no good match. If no candidates pass this threshold, the bot
   * falls back to a generic "I have no idea what to say" message.
   */
  minScore: number;
}
