/**
 * store.ts -- Persistent transcript store.
 *
 * == ROLE IN THE ARCHITECTURE ==
 *
 * The TranscriptStore is the BOT'S BRAIN on disk. It contains every line of
 * dialogue the bot has ever seen or produced, in strict chronological order.
 * There is no separate database, no index, no cache -- just a flat JSON array.
 *
 * This is intentional and mirrors the original Jabberwacky design:
 *   - All knowledge is in the sequence of exchanges
 *   - Nothing is abstracted, summarized, or hand-coded
 *   - The store is append-only (lines are never deleted or modified)
 *
 * == STORAGE FORMAT ==
 *
 * The file is a JSON array of TranscriptLine objects. On startup we read it
 * whole (it's not meant to be huge -- our seed is ~330 lines). In production,
 * Cleverbot presumably uses a distributed database, but the logical model is
 * the same: find candidate lines by scanning, score them, pick one.
 *
 * == NEXT-ID TRACKING ==
 *
 * Each line gets a monotonically increasing integer ID. On load, we scan for
 * the highest existing ID and start from there. This ensures that IDs are
 * globally unique even across restarts, which is important because respondsTo
 * references are by ID.
 *
 * == SAVE STRATEGY ==
 *
 * save() is called after EVERY turn (both user input and bot reply). This is
 * simple and safe for a single-user REPL. For a server handling many
 * concurrent sessions you'd want batching or a proper append-a-log approach.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { TranscriptLine } from "./types";

/**
 * Manages the flat, ever-growing transcript that serves as the bot's memory.
 *
 * Lines are persisted to a JSON file between runs so the bot accumulates
 * knowledge over time -- exactly like the original Jabberwacky.
 */
export class TranscriptStore {
  /**
   * The entire transcript, held in memory as a flat array in insertion order.
   * When searching for candidates (in matcher.ts), we iterate over this array
   * checking every line that has a known reply.
   */
  private lines: TranscriptLine[] = [];

  /**
   * The next unique line ID to assign. Initialised to 1 on empty store, or
   * max(existing IDs) + 1 on load.
   */
  private nextId = 1;

  /**
   * @param filePath  Path to the JSON file where the transcript is persisted.
   *                  If the file already exists, it is loaded into memory.
   *                  If it doesn't, we start with an empty transcript and
   *                  create the file on the first call to save().
   */
  constructor(private filePath: string) {
    if (existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, "utf-8")) as TranscriptLine[];
      this.lines = raw;
      this.nextId = raw.length ? Math.max(...raw.map((l) => l.id)) + 1 : 1;
    }
  }

  /**
   * Returns all lines in the store.
   * This is the full "brain" -- matcher.ts iterates it to find candidates.
   */
  all(): readonly TranscriptLine[] {
    return this.lines;
  }

  /**
   * Returns every line that has a known reply -- i.e. pairs of the form
   * { line: L, reply: R } where R.respondsTo === L.id.
   *
   * This is the primary data structure for matching: given user input,
   * we score every L against it, and if L passes, we return R as the candidate
   * reply.
   *
   * -- How it works --
   * 1. Build a reverse map: respondsTo ID → TranscriptLine.
   *    Any line whose respondsTo is not null is a "reply" to something.
   * 2. For every line in the store, look up whether a reply exists for it.
   *    If yes, emit { line, reply }.
   *
   * This is O(n) in the number of lines. With our seed corpus of ~330 lines
   * this is instant. For hundreds of thousands of lines you'd need indexing.
   */
  withReplies(): { line: TranscriptLine; reply: TranscriptLine }[] {
    const byRespondsTo = new Map<number, TranscriptLine>();
    for (const l of this.lines) {
      if (l.respondsTo !== null) {
        byRespondsTo.set(l.respondsTo, l);
      }
    }

    const out: { line: TranscriptLine; reply: TranscriptLine }[] = [];
    for (const l of this.lines) {
      const reply = byRespondsTo.get(l.id);
      if (reply) {
        out.push({ line: l, reply });
      }
    }
    return out;
  }

  /**
   * Append a new line to the transcript (in memory).
   *
   * This does NOT persist to disk -- you must call save() afterward.
   * We separate append (fast, in-memory) from save (slow, I/O) so that
   * a single "turn" (user input + bot reply) can do two appends and one save.
   *
   * @param speaker    "human" or "bot"
   * @param text       The raw text spoken
   * @param respondsTo ID of the line this is a reply to, or null
   * @param sessionId  Which conversation this belongs to
   * @returns          The newly created TranscriptLine (with its assigned id)
   */
  append(
    speaker: "human" | "bot",
    text: string,
    respondsTo: number | null,
    sessionId: string,
  ): TranscriptLine {
    const line: TranscriptLine = {
      id: this.nextId++,
      speaker,
      text,
      respondsTo,
      createdAt: Date.now(),
      sessionId,
    };
    this.lines.push(line);
    return line;
  }

  /**
   * Persist the entire transcript to disk as a JSON array.
   *
   * Called after every turn in index.ts. For a REPL this is fine; for a
   * server you'd batch writes or use an append-only log.
   */
  save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.lines, null, 2), "utf-8");
  }

  /** Returns the total number of lines in the transcript. */
  size(): number {
    return this.lines.length;
  }
}
