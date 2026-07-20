import * as readline from "node:readline";
import Parry from "./parry";

function main() {
	const dataDir = process.argv[2] || ".";

	const parry = new Parry();
	try {
		parry.loadDataFiles(dataDir);
	} catch (e) {
		console.error("Error loading PARRY data files:", e instanceof Error ? e.message : e);
		process.exit(1);
	}

	console.log(`\n${"=".repeat(60)}`);
	console.log("  PARRY (1972) — Faithful TypeScript Port");
	console.log("  Based on Colby's original MLISP source code");
	console.log(`${"=".repeat(60)}\n`);
	console.log("PARRY: WHAT DO YOU WANT?\n");

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	function promptUser() {
		rl.question("YOU: ", (input) => {
			const trimmed = input.trim();
			if (trimmed === "" || trimmed.toUpperCase() === "GOODBYE") {
				console.log('\nPARRY: GOODBYE.\n');
				rl.close();
				return;
			}
			const response = parry.response(trimmed);
			console.log(`PARRY: ${response}\n`);
			promptUser();
		});
	}

	promptUser();
}

main();
