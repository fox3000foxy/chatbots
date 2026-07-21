import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { findCandidates, pickReply } from "./matcher.js";
import { SEED_CONVERSATIONS } from "./seed.js";
import { TranscriptStore } from "./store.js";
import type { BotConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "..", "data", "transcript.json");

const config: BotConfig = {
	contextWindow: 4,
	topK: 20,
	minScore: 0.08,
};

const FALLBACKS = ["I don't know what to say to that yet.", "Ask me something else, that one's got me stumped.", "Hm. Not sure. What else is on your mind?", "I'll have to think about that one."];

function seedStore(store: TranscriptStore): void {
	if (store.size() > 0) return;
	for (const conv of SEED_CONVERSATIONS) {
		let prevId: number | null = null;
		const sessionId = `__seed_${conv.contributorId}_${Math.random().toString(36).slice(2, 8)}`;
		for (let i = 0; i < conv.lines.length; i++) {
			const speaker = i % 2 === 0 ? "human" : "bot";
			// Seed data represents knowledge Cleverbot would already have
			// absorbed long ago, so it goes straight in pre-consolidated.
			const line = store.append(speaker, conv.lines[i], prevId, sessionId, conv.contributorId, true);
			prevId = line.id;
		}
	}
	store.save();
	console.log(`Seeded ${store.size()} lines from ${SEED_CONVERSATIONS.length} contributor conversations.`);
}

function consolidatePreviousSessions(store: TranscriptStore): void {
	const learned = store.consolidate();
	if (learned > 0) {
		console.log(`(Overnight retrain: ${learned} line(s) from your last visit are now part of what I can draw on.)`);
		store.save();
	}
}

async function main() {
	const store = new TranscriptStore(DATA_PATH);
	seedStore(store);
	consolidatePreviousSessions(store);

	const recentContext: string[] = [];
	const sessionId = `session_${Date.now()}`;
	const contributorId = `guest_${Math.random().toString(36).slice(2, 8)}`;

	const rl = createInterface({ input: process.stdin, output: process.stdout });

	console.log("\nCleverbot -- starting conversation (type /quit to exit).");
	console.log("Note: anything new you teach it only becomes matchable after you restart\n(that's the documented 'no learning mid-conversation' behaviour).\n");

	const ask = (): Promise<string> => new Promise((resolve) => rl.question("You:  ", resolve));

	let input = await ask();

	while (input.trim().toLowerCase() !== "/quit") {
		if (!input.trim()) {
			input = await ask();
			continue;
		}

		const userLine = store.append("human", input.trim(), null, sessionId, contributorId, false);
		recentContext.push(input.trim());

		const candidates = findCandidates(store, input.trim(), recentContext, config);
		const pick = pickReply(candidates);

		let replyText: string;
		let replyContributor: string;
		if (pick) {
			replyText = pick.reply.text;
			replyContributor = pick.reply.contributorId;
		} else {
			replyText = FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
			replyContributor = "system";
		}

		store.append("bot", replyText, userLine.id, sessionId, replyContributor, false);
		console.log(`Bot:  ${replyText}`);
		recentContext.push(replyText);

		if (recentContext.length > config.contextWindow * 2) {
			recentContext.splice(0, recentContext.length - config.contextWindow * 2);
		}

		store.save();
		input = await ask();
	}

	store.save();
	rl.close();
	console.log(`\nSaved ${store.size()} lines (${store.pendingCount()} pending consolidation). Goodbye.`);
}

main().catch(console.error);
