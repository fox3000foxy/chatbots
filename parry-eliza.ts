import { readFileSync } from "node:fs";
import { Eliza, readElizaScript } from "./eliza/src/eliza";
import { Parry } from "./parry/src/parry";

const DOCTOR_SCRIPT = readFileSync("./eliza/scripts/ELIZA-script-DOCTOR-original-1966-CACM-appendix.txt", "utf-8");
const PARRY_DATA = "./parry/original-code";

const MAX_TURNS = 25;

// PARRY gets repetitive with keyword fallbacks; seed with a flare topic
const SEEDS = ["I WANT TO TALK ABOUT HORSES.", "DO YOU KNOW ABOUT ORGANIZED CRIME?", "TELL ME ABOUT YOURSELF.", "WHAT ARE YOU MOST AFRAID OF?"];

function main() {
	const script = readElizaScript(DOCTOR_SCRIPT);
	const eliza = new Eliza(script.rules, script.memRule);

	const parry = new Parry();
	parry.loadDataFiles(PARRY_DATA);

	console.log("=".repeat(68));
	console.log("   ELIZA (1966) meets PARRY (1972)");
	console.log("   RFC 439 -- 18 September 1972");
	console.log("=".repeat(68));
	console.log();

	const startMsg = SEEDS[Math.floor(Math.random() * SEEDS.length)];
	console.log(`[ELIZA] ${startMsg}`);

	let lastLine = startMsg;
	let repeatCount = 0;
	let lastParryResponse = "";

	for (let turn = 0; turn < MAX_TURNS; turn++) {
		const parryResponse = parry.response(lastLine);
		const _turnNum = turn + 1;

		if (parryResponse === lastParryResponse) {
			repeatCount++;
		} else {
			repeatCount = 0;
		}
		lastParryResponse = parryResponse;

		console.log(`[PARRY] ${parryResponse}`);

		if (repeatCount >= 4) {
			console.log("(conversation stalled -- PARRY is looping)");
			break;
		}

		const elizaResponse = eliza.response(parryResponse);
		console.log(`[ELIZA] ${elizaResponse}`);

		lastLine = elizaResponse;
	}

	console.log("=".repeat(68));
	console.log("   End of conversation");
	console.log("=".repeat(68));
}

main();
