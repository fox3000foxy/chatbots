import * as readline from "node:readline";
import { Parry } from "./parry";

const DATA_DIR = process.argv[2] || ".";

function main() {
	const parry = new Parry();
	try {
		parry.loadDataFiles(DATA_DIR);
	} catch (e) {
		console.error("Error loading PARRY data:", e instanceof Error ? e.message : e);
		process.exit(1);
	}

	console.log(`\n${"=".repeat(60)}`);
	console.log("  PARRY (1972) — Faithful TypeScript Port");
	console.log("  Based on Colby's original MLISP source code");
	console.log(`${"=".repeat(60)}\n`);
	console.log("PARRY: WHAT DO YOU WANT?\n");

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

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
