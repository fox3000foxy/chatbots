import * as readline from "node:readline";
import { Parry } from "./parry";

/**
 * CLI entrypoint: loads the original PDP-10 data files (synonym tables,
 * belief network, inference rules, response patterns - see parry.ts's
 * module doc and loadDataFiles()) from `original-code/` by default, then
 * runs a simple readline REPL where each line is handed to
 * Parry.response(). Typing an empty line or "GOODBYE" ends the session.
 */
const DATA_DIR = process.argv[2] || "./original-code";

function main() {
	const parry = new Parry();
	try {
		parry.loadDataFiles(DATA_DIR);
	} catch (e) {
		console.error("Error loading PARRY data:", e instanceof Error ? e.message : e);
		process.exit(1);
	}

	console.log(`\n${"=".repeat(60)}`);
	console.log("  PARRY (1972) -- Faithful TypeScript Port");
	console.log("  Based on Colby's original MLISP source code");
	console.log(`${"=".repeat(60)}\n`);
	console.log("PARRY: WHAT DO YOU WANT?\n");

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

	// Same recursive prompt-loop pattern as the ELIZA and ALICE CLIs: each
	// answer immediately re-prompts until the exit condition is hit.
	function prompt() {
		rl.question("YOU: ", (input) => {
			const t = input.trim();
			if (!t || t.toUpperCase() === "GOODBYE") {
				console.log("\nPARRY: GOODBYE.\n");
				rl.close();
				return;
			}
			console.log(`PARRY: ${parry.response(t)}\n`);
			prompt();
		});
	}
	prompt();
}

main();