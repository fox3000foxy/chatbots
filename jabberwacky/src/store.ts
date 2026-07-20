import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { TranscriptLine } from "./types";

/**
 * The whole "brain" is just this ever-growing list, persisted to disk.
 * Every real conversation appends to it, so the bot keeps learning between
 * runs - same idea as the original, minus decades of users.
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

	/** All lines that have a known "next line" (i.e. something was said after them). */
	withReplies(): { line: TranscriptLine; reply: TranscriptLine }[] {
		const byRespondsTo = new Map<number, TranscriptLine>();
		for (const l of this.lines) {
			if (l.respondsTo !== null) byRespondsTo.set(l.respondsTo, l);
		}
		const out: { line: TranscriptLine; reply: TranscriptLine }[] = [];
		for (const l of this.lines) {
			const reply = byRespondsTo.get(l.id);
			if (reply) out.push({ line: l, reply });
		}
		return out;
	}

	append(speaker: "human" | "bot", text: string, respondsTo: number | null, sessionId: string): TranscriptLine {
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

	save(): void {
		writeFileSync(this.filePath, JSON.stringify(this.lines, null, 2), "utf-8");
	}

	size(): number {
		return this.lines.length;
	}
}
