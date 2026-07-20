import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TranscriptStore } from "./store.js";
import { findCandidates, pickReply } from "./matcher.js";
import { SEED_CONVERSATIONS } from "./seed.js";
import type { BotConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "..", "data", "transcript.json");

const config: BotConfig = {
  contextWindow: 2,
  topK: 20,
  minScore: 0.08,
};

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

async function main() {
  const store = new TranscriptStore(DATA_PATH);
  seedStore(store);

  const recentContext: string[] = [];
  const sessionId = `session_${Date.now()}`;

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("\nJabberwacky — starting conversation (type /quit to exit).\n");

  const ask = (): Promise<string> =>
    new Promise((resolve) => rl.question("You:  ", resolve));

  let input = await ask();

  while (input.trim().toLowerCase() !== "/quit") {
    if (!input.trim()) {
      input = await ask();
      continue;
    }

    const userLine = store.append("human", input.trim(), null, sessionId);
    recentContext.push(input.trim());

    const candidates = findCandidates(store, input.trim(), recentContext, config);
    const pick = pickReply(candidates);

    if (pick) {
      store.append(
        "bot",
        pick.reply.text,
        userLine.id,
        sessionId
      );
      console.log(`Bot:  ${pick.reply.text}`);
      recentContext.push(pick.reply.text);
    } else {
      const fallback = "I have no idea what to say to that yet.";
      store.append("bot", fallback, userLine.id, sessionId);
      console.log(`Bot:  ${fallback}`);
      recentContext.push(fallback);
    }

    if (recentContext.length > config.contextWindow * 2) {
      recentContext.splice(0, recentContext.length - config.contextWindow * 2);
    }

    store.save();
    input = await ask();
  }

  store.save();
  rl.close();
  console.log(`\nSaved ${store.size()} lines. Goodbye.`);
}

main().catch(console.error);
