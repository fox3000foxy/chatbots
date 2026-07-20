/**
 * A single line ever spoken in any conversation the bot has seen,
 * in chronological order. This flat, ever-growing transcript IS the
 * bot's "brain" - there is no separate rule base.
 *
 * This mirrors the publicly documented description of Jabberwacky:
 * it stores every conversation it has ever had, and answers new input
 * by finding a similar moment in that history and reusing whatever
 * was said next on that earlier occasion.
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