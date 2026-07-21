import * as readline from "node:readline";
import { Alice } from "./alice";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const AIML_DIR = resolve(__dirname, "../aiml");

function main() {
	const alice = new Alice();
	try {
		alice.loadAIML(AIML_DIR);
	} catch (e) {
		console.error("Error loading AIML:", e instanceof Error ? e.message : e);
		process.exit(1);
	}

	console.log(`\n${"=".repeat(60)}`);
	console.log("  A.L.I.C.E. (1995) -- Free ALICE AIML v1.6");
	console.log("  Based on Dr. Richard Wallace's AIML files");
	console.log(`${"=".repeat(60)}\n`);
	console.log("ALICE: Hello. I am ALICE.\n");

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

	function prompt() {
		rl.question("YOU: ", (input) => {
			const t = input.trim();
			if (!t || t.toUpperCase() === "GOODBYE") {
				console.log("\nALICE: Goodbye.\n");
				rl.close();
				return;
			}
			const response = alice.response(t);
			console.log(`ALICE: ${response}\n`);
			prompt();
		});
	}
	prompt();
}

main();
