import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { TranscriptLine } from "./types.js";

/**
 * Same idea as Jabberwacky's store - an ever-growing, persisted transcript -
 * with one addition: lines are written as `consolidated: false` and stay
 * invisible to the matcher until `consolidate()` is called. This reproduces
 * the documented behaviour that Cleverbot can't be taught something and
 * quizzed on it in the *same* conversation - the new material only becomes
 * matchable after a batch pass, same as its real overnight database rebuild.
 */
export class TranscriptStore {
	private lines: TranscriptLine[] = [];
	private nextId = 1;

	constructor(private filePath: string) {
		if (existsSync(filePath)) {
			const raw = JSON.parse(readFileSync(filePath, "utf-8")) as TranscriptLine[];
			this.lines = raw;
			this.nextId = raw.length ? Math.max(...raw.map((l) => l.id)) + 1 : 1;
		}
	}

	all(): readonly TranscriptLine[] {
		return this.lines;
	}

	/** Only lines that have already been through a consolidation pass. */
	consolidatedLines(): TranscriptLine[] {
		return this.lines.filter((l) => l.consolidated);
	}

	/** Lines with a known "next line", restricted to the consolidated (matchable) pool. */
	withReplies(): { line: TranscriptLine; reply: TranscriptLine }[] {
		const consolidated = this.consolidatedLines();
		const byRespondsTo = new Map<number, TranscriptLine>();
		for (const l of consolidated) {
			if (l.respondsTo !== null) byRespondsTo.set(l.respondsTo, l);
		}
		const out: { line: TranscriptLine; reply: TranscriptLine }[] = [];
		for (const l of consolidated) {
			const reply = byRespondsTo.get(l.id);
			if (reply) out.push({ line: l, reply });
		}
		return out;
	}

	append(speaker: "human" | "bot", text: string, respondsTo: number | null, sessionId: string, contributorId: string, consolidated = false): TranscriptLine {
		const line: TranscriptLine = {
			id: this.nextId++,
			speaker,
			text,
			respondsTo,
			createdAt: Date.now(),
			sessionId,
			contributorId,
			consolidated,
		};
		this.lines.push(line);
		return line;
	}

	/** The "overnight retrain": everything said so far becomes matchable. */
	consolidate(): number {
		let count = 0;
		for (const l of this.lines) {
			if (!l.consolidated) {
				l.consolidated = true;
				count++;
			}
		}
		return count;
	}

	save(): void {
		writeFileSync(this.filePath, JSON.stringify(this.lines, null, 2), "utf-8");
	}

	size(): number {
		return this.lines.length;
	}

	pendingCount(): number {
		return this.lines.filter((l) => !l.consolidated).length;
	}
}
