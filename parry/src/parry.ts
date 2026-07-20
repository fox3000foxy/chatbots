import { existsSync, readFileSync } from "node:fs";

interface Emotions {
	anger: number;
	fear: number;
	mistrust: number;
	hurt: number;
}

interface EmotionJumps {
	ajump: number;
	fjump: number;
	hjump: number;
}

type BeliefCategory = "HUM" | "HUM2" | "DOC" | "INT" | "INN";

interface Belief {
	name: string;
	strength: number;
	category: BeliefCategory;
	negated: boolean;
}

interface Inference {
	type: "TH2" | "EMOTE" | "IF";
	condition: string[];
	consequences: string[];
}

interface Pattern {
	tokens: string[];
	response: number;
}

export class Parry {
	private synonyms = new Map<string, string>();
	private simplePatterns: Pattern[] = [];
	private compoundPatterns: Pattern[] = [];
	private beliefs: Belief[] = [];
	private inferences: Inference[] = [];
	private idioms = new Map<string, string>();
	private irregulars = new Map<string, string>();
	private suffixes: string[] = [];
	private startWords = new Set<string>();
	private stopWords = new Set<string>();
	private flags = new Set<string>();

	private emotions: Emotions = { anger: 0, fear: 0, mistrust: 0, hurt: 0 };
	private baselines: Emotions = { anger: 0, fear: 0, mistrust: 0, hurt: 0 };
	private jumps: EmotionJumps = { ajump: 0, fjump: 0, hjump: 0 };

	private delFlag = false;
	private flare = "INIT";
	private liveFlares: string[] = [];
	private deadFlares: string[] = [];
	private delNouns: string[] = [];
	private delVerbs: string[] = [];
	private delAmbiguous: string[] = [];
	private delEnd = false;
	private sensitiveList: string[] = [];
	private topic: string | null = null;
	private weight = 0;
	private pdat = new Map<number, string>();

	private patternRe: RegExp;

	constructor() {
		this.patternRe = /^\(\((.*)\)\s+(?:\x02|P)(\d+)\)$/;
	}

	loadDataFiles(dataDir: string) {
		this.loadLines(`${dataDir}/synonm.alf`, (p) => {
			const m = p.match(/^\((\S+)\s+(\S+)\)/);
			if (m) this.synonyms.set(m[1], m[2]);
		});
		this.loadLines(`${dataDir}/idiom.alf`, (p) => {
			const m = p.match(/^\((\S+)\s+(.+)\)\s*$/);
			if (m) this.idioms.set(m[1], m[2]);
		});
		this.loadLines(`${dataDir}/irreg.alf`, (p) => {
			const m = p.match(/^\((\S+)\s+(.+)\)\s*$/);
			if (m) this.irregulars.set(m[1], m[2]);
		});
		this.loadLines(`${dataDir}/flags.alf`, (p) => {
			const m = p.match(/^\((\S+)\)/);
			if (m) this.flags.add(m[1]);
		});
		this.loadLines(`${dataDir}/suffix.alf`, (p) => {
			const t = p.trim();
			if (t && !t.startsWith(";")) this.suffixes.push(t);
		});
		this.loadLines(`${dataDir}/startr.alf`, (p) => {
			const t = p.trim().toUpperCase();
			if (t && !t.startsWith(";") && !t.startsWith("(")) this.startWords.add(t);
		});
		this.loadLines(`${dataDir}/stoppr.alf`, (p) => {
			const t = p.trim().toUpperCase();
			if (t && !t.startsWith(";") && !t.startsWith("(")) this.stopWords.add(t);
		});

		this.loadPatterns(`${dataDir}/spats.sel`, this.simplePatterns);
		this.loadPatterns(`${dataDir}/cpats.sel`, this.compoundPatterns);
		this.loadBeliefs(`${dataDir}/bel`);
		this.loadInferences(`${dataDir}/inf`);

		this.initEmotions();
		this.initFlares();
	}

	private loadLines(path: string, fn: (line: string) => void) {
		if (!existsSync(path)) return;
		for (const line of readFileSync(path, "utf-8").split("\n")) {
			const t = line.trim();
			if (t) fn(t);
		}
	}

	private loadPatterns(path: string, target: Pattern[]) {
		if (!existsSync(path)) return;
		for (const line of readFileSync(path, "utf-8").split("\n")) {
			const t = line.trim();
			if (!t || t.startsWith(";") || t.startsWith("~")) continue;
			const m = t.match(this.patternRe);
			if (m) {
				target.push({
					tokens: m[1].trim().split(/\s+/),
					response: Number.parseInt(m[2], 10),
				});
			}
		}
	}

	private loadBeliefs(path: string) {
		if (!existsSync(path)) return;
		for (const line of readFileSync(path, "utf-8").split("\n")) {
			const t = line.trim();
			if (!t || t.startsWith("~") || t.startsWith(";")) continue;
			const m = t.match(/^\((\*?)(\S+)\s+(\d+)\s+(\S+)/);
			if (m) {
				this.beliefs.push({
					name: m[2],
					strength: Number.parseInt(m[3], 10),
					category: m[4] as BeliefCategory,
					negated: m[1] === "*",
				});
			}
		}
	}

	private loadInferences(path: string) {
		if (!existsSync(path)) return;
		for (const line of readFileSync(path, "utf-8").split("\n")) {
			const t = line.trim();
			if (!t || t.startsWith("~") || t.startsWith(";")) continue;
			if (t.startsWith("(TH2")) {
				const rest = t.slice(4, -1).trim();
				const parts = this.parseArgs(rest);
				if (parts.length >= 2) {
					this.inferences.push({ type: "TH2", condition: [parts[0]], consequences: parts.slice(1) });
				}
			} else if (t.startsWith("(EMOTE")) {
				const rest = t.slice(6, -1).trim();
				const m = rest.match(/^\((\w+\s+-?[\d.]+)\)\s+(.+)/);
				if (m) {
					this.inferences.push({
						type: "EMOTE",
						condition: m[1].split(/\s+/),
						consequences: m[2].trim().split(/\s+/),
					});
				}
			} else if (t.startsWith("(IF")) {
				const rest = t.slice(2, -1).trim();
				const parts = this.parseArgs(rest);
				if (parts.length >= 3) {
					this.inferences.push({ type: "IF", condition: [parts[0], parts[1]], consequences: parts.slice(2) });
				}
			}
		}
	}

	private parseArgs(s: string): string[] {
		const result: string[] = [];
		let depth = 0;
		let cur = "";
		for (const ch of s) {
			if (ch === "(") {
				depth++;
				if (depth > 1) cur += ch;
			} else if (ch === ")") {
				depth--;
				if (depth > 0) cur += ch;
				else if (depth === 0 && cur) {
					result.push(cur.trim());
					cur = "";
				}
			} else if (ch === " " && depth === 0) {
				if (cur) {
					result.push(cur.trim());
					cur = "";
				}
			} else cur += ch;
		}
		if (cur) result.push(cur.trim());
		return result;
	}

	private initEmotions() {
		this.emotions = { anger: 0, fear: 0, mistrust: 0, hurt: 0 };
		this.baselines = { anger: 0, fear: 0, mistrust: 0, hurt: 0 };
		this.jumps = { ajump: 0, fjump: 0, hjump: 0 };
	}

	private initFlares() {
		this.flare = "INIT";
		this.liveFlares = ["HORSESET", "HORSERACINGSET", "MONEYSET", "GAMBLERSET", "BOOKIESET", "CHEATSET", "GANGSTERSET", "RACKETSET", "MAFIASET", "PERSONSET", "ITALIANSET", "POLICESET"];
		this.deadFlares = [];
		this.delFlag = false;
		this.delEnd = false;
		this.delNouns = ["MAFIA", "GUN", "DEATH", "CHIEF"];
		this.delVerbs = ["KILL", "SPY"];
		this.delAmbiguous = ["BEAT", "HATE"];
		this.sensitiveList = ["LOOKS", "SEXLIFE", "FAMILY", "EDUCATION", "RELIGION"];
	}

	private wordCanonical(word: string): string {
		const upper = word.toUpperCase();
		return this.synonyms.get(upper) ?? this.idioms.get(upper) ?? this.irregulars.get(upper) ?? upper;
	}

	private canonicalTokenize(input: string): string[] {
		const text = input
			.toUpperCase()
			.replace(/[^A-Z0-9\s]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return text
			.split(/\s+/)
			.filter(Boolean)
			.map((w) => {
				const c = this.wordCanonical(w);
				return c.length > 5 ? c.slice(0, 5) : c;
			});
	}

	private matchTokens(input: string[], pattern: string[]): boolean {
		if (pattern.length === 0) return true;
		if (pattern.length > input.length) return false;
		for (let start = 0; start <= input.length - pattern.length; start++) {
			let ok = true;
			for (let i = 0; i < pattern.length; i++) {
				if (pattern[i] !== input[start + i]) {
					ok = false;
					break;
				}
			}
			if (ok) return true;
		}
		return false;
	}

	private matchPatterns(tokens: string[], patterns: Pattern[]): number | null {
		for (const pat of patterns) {
			if (this.matchTokens(tokens, pat.tokens)) return pat.response;
		}
		return null;
	}

	private memberAny(list: string[], tokens: string[]): string | null {
		for (const item of list) {
			if (tokens.includes(item)) return item;
		}
		return null;
	}

	private modifyVariables() {
		this.emotions.anger = Math.max(this.emotions.anger - 1, this.baselines.anger);
		this.emotions.hurt = Math.max(this.emotions.hurt - 0.5, this.baselines.hurt);
		if (this.delFlag) {
			this.emotions.fear = Math.max(this.emotions.fear - 0.1, this.baselines.fear + 5);
		} else if (this.flare === "INIT") {
			this.emotions.fear = Math.max(this.emotions.fear - 0.3, this.baselines.fear);
		} else {
			this.emotions.fear = Math.max(this.emotions.fear - 0.2, this.baselines.fear + 3);
		}
		this.emotions.mistrust = Math.max(this.emotions.mistrust - 0.05, this.baselines.mistrust);
		this.jumps = { ajump: 0, fjump: 0, hjump: 0 };
	}

	private applyEmotionalJumps() {
		this.emotions.anger += this.jumps.ajump;
		this.emotions.fear += this.jumps.fjump;
		this.emotions.hurt += this.jumps.hjump;
		this.emotions.mistrust += this.jumps.hjump * 0.5;
	}

	private applyInferences() {
		for (const inf of this.inferences) {
			if (inf.type === "TH2") {
				const bel = this.beliefs.find((b) => b.name === inf.condition[0]);
				if (bel && bel.strength > 0) {
					bel.strength = Math.max(0, bel.strength - 2);
					for (const cons of inf.consequences) {
						const cb = this.beliefs.find((b) => b.name === cons);
						if (cb) cb.strength = Math.min(5, cb.strength + 1);
					}
				}
			} else if (inf.type === "EMOTE") {
				const jt = inf.condition[0];
				const ja = Number.parseFloat(inf.condition[1]);
				for (const bn of inf.consequences) {
					const bel = this.beliefs.find((b) => b.name === bn);
					if (bel && bel.strength > 0) {
						if (jt === "AJUMP") this.jumps.ajump += ja;
						else if (jt === "FJUMP") this.jumps.fjump += ja;
						else if (jt === "HJUMP") {
							this.jumps.hjump += ja;
							this.jumps.ajump += ja * 0.5;
						}
					}
				}
			}
		}
	}

	private checkFlare(inp: string[]): boolean {
		let nf = "INIT";
		let result = false;
		let wt = 0;
		for (const word of inp) {
			const fs = this.getFlareSet(word);
			if (fs && (this.liveFlares.includes(fs) || this.deadFlares.includes(fs))) {
				const fwt = this.getFlareWeight(fs);
				if (fwt > wt) {
					nf = word;
					result = true;
					wt = fwt;
				}
			}
		}
		if (result) {
			if (this.flare === "INIT" || wt > 1) {
				this.flare = nf;
				this.weight = wt;
				return true;
			}
			return false;
		}
		return false;
	}

	private getFlareSet(word: string): string | null {
		const map: Record<string, string> = {
			HORSE: "HORSESET",
			RACES: "HORSERACINGSET",
			RACE: "HORSERACINGSET",
			MONEY: "MONEYSET",
			GAMBL: "GAMBLERSET",
			BET: "GAMBLERSET",
			BOOKI: "BOOKIESET",
			CROOK: "BOOKIESET",
			CHEAT: "CHEATSET",
			GANGSTER: "GANGSTERSET",
			HOOD: "GANGSTERSET",
			RACKET: "RACKETSET",
			MAFIA: "MAFIASET",
			ITALI: "ITALIANSET",
			ITALY: "ITALIANSET",
			POLICE: "POLICESET",
			FUZZ: "POLICESET",
		};
		for (const [key, val] of Object.entries(map)) {
			if (word.startsWith(key)) return val;
		}
		return null;
	}

	private getFlareWeight(fset: string): number {
		const w: Record<string, number> = {
			HORSESET: 1,
			HORSERACINGSET: 2,
			MONEYSET: 3,
			GAMBLERSET: 4,
			BOOKIESET: 5,
			CHEATSET: 6,
			GANGSTERSET: 7,
			RACKETSET: 8,
			MAFIASET: 9,
			PERSONSET: 6,
			ITALIANSET: 5,
			POLICESET: 4,
		};
		return w[fset] || 0;
	}

	private flareMod(fset: string) {
		this.liveFlares = this.liveFlares.filter((f) => f !== fset);
		if (!this.deadFlares.includes(fset)) this.deadFlares.push(fset);
	}

	private flareRecord(fset: string) {
		this.flareMod(fset);
		this.jumps.fjump = this.weight / 40;
		this.topic = fset;
	}

	private delCheck(inp: string[]): boolean {
		if (this.memberAny(this.delNouns, inp)) return true;
		if (this.memberAny(this.delVerbs, inp)) return true;
		if (this.emotions.mistrust > 10 && this.memberAny(this.delAmbiguous, inp)) return true;
		return false;
	}

	private express(num: number): string | null {
		return this.pdat.get(num) ?? null;
	}

	private expressOrSynth(num: number): string {
		return this.pdat.get(num) ?? this.synthetic(num);
	}

	private synthetic(n: number): string {
		const r: Record<number, string[]> = {
			0: ["I DON'T KNOW WHAT YOU MEAN.", "WHAT?", "I DON'T FOLLOW."],
			8: ["I SEE.", "OK."],
			10: ["WHAT DO YOU WANT?", "YEAH? WHAT IS IT?"],
			16: ["GO ON.", "KEEP TALKING."],
			17: ["I DON'T KNOW.", "MAYBE.", "I'M NOT SURE."],
			21: ["I DON'T LIKE TALKING ABOUT FEELINGS.", "WHY DO YOU KEEP ASKING ABOUT FEELINGS?"],
			24: ["WHAT IS THERE TO SAY?", "I DON'T HAVE MUCH TO SAY ABOUT IT."],
			42: ["WHAT DO YOU WANT TO TALK ABOUT?", "I'M HERE. WHAT NOW?"],
			56: ["I'M IN THE HOSPITAL. THEY PUT ME HERE.", "I SHOULDN'T BE IN HERE."],
			70: ["THE DOCTORS DON'T REALLY LISTEN.", "DOCTORS ARE ALL THE SAME."],
			104: ["I DON'T TRUST DOCTORS.", "DOCTORS ACT LIKE THEY KNOW EVERYTHING."],
			128: ["THAT'S A FUNNY QUESTION.", "WHY WOULD YOU ASK THAT?"],
			150: ["WHY ARE YOU SO INTERESTED IN THE DOCTOR?", "THE DOCTOR IS IN ON IT TOO."],
			200: ["WHY DO YOU WANT TO KNOW?", "WHAT BUSINESS IS IT OF YOURS?"],
			384: ["I CAN'T EXPLAIN IT.", "IT'S COMPLICATED.", "YOU WOULDN'T UNDERSTAND."],
			408: ["WHAT ABOUT ME?", "WHY ARE YOU ASKING ABOUT ME?", "YOU'RE THE ONE WITH QUESTIONS."],
			528: ["THE MAFIA IS AFTER ME. THAT'S WHAT I THINK.", "I'M BEING FOLLOWED BY THE MAFIA."],
			600: ["THERE'S NOTHING TO TELL.", "I DON'T WANT TO TALK ABOUT MYSELF.", "WHAT ABOUT YOU INSTEAD?"],
			630: ["WHY DO YOU KEEP ASKING ABOUT ME?", "WHAT DO YOU WANT?", "THAT'S MY BUSINESS."],
			1020: ["I WANT TO GET OUT OF HERE.", "THEY WON'T LET ME LEAVE.", "I SHOULDN'T BE HERE."],
			1432: ["I DON'T KNOW WHAT TO SAY.", "I CAN'T ANSWER THAT."],
			1536: ["WHAT MAKES YOU SAY THAT?", "THAT'S WHAT YOU THINK."],
			1970: ["MAYBE.", "I DON'T KNOW.", "I'M NOT SURE WHAT TO SAY."],
			1992: ["THAT'S WHAT I THINK.", "YEAH, I GUESS SO.", "I SUPPOSE."],
			3000: ["WHAT DO YOU MEAN BY THAT?", "I DON'T FOLLOW YOU.", "THAT DOESN'T MAKE SENSE."],
			4924: ["I DON'T KNOW WHAT YOU'RE TALKING ABOUT.", "YOU'RE NOT MAKING SENSE.", "I DON'T KNOW."],
			5004: ["THAT'S NOT TRUE.", "YOU'RE WRONG ABOUT THAT.", "I DON'T BELIEVE IT."],
			5134: ["I DON'T CARE.", "IT DOESN'T MATTER.", "WHY ARE YOU ASKING?"],
			5168: ["I DON'T TRUST ANYONE.", "YOU CAN'T TRUST PEOPLE.", "EVERYONE HAS AN ANGLE."],
			5195: ["I'M NOT COMFORTABLE TALKING ABOUT THAT.", "I DON'T WANT TO DISCUSS IT."],
			5228: ["I'M NOT SURE.", "I DON'T HAVE AN OPINION.", "I HAVEN'T THOUGHT ABOUT IT."],
			5229: ["THAT'S ABOUT ME.", "THAT'S PERSONAL.", "I DON'T WANT TO TALK ABOUT ME."],
			5230: ["I DON'T KNOW WHAT YOU'RE GETTING AT.", "WHAT ARE YOU DRIVING AT?", "I DON'T FOLLOW YOUR LINE OF QUESTIONING."],
			5231: ["I'M TIRED OF QUESTIONS.", "CAN WE TALK ABOUT SOMETHING ELSE?", "CHANGE THE SUBJECT."],
			5244: ["I DON'T HAVE MUCH TO SAY.", "THAT'S ALL THERE IS TO IT.", "THAT'S HOW IT IS."],
		};
		const alts = r[n];
		if (!alts) return "I DON'T KNOW.";
		const idx = (this.kwCycle.get(`__synth_${n}`) ?? 0) % alts.length;
		this.kwCycle.set(`__synth_${n}`, idx + 1);
		return alts[idx];
	}

	private expressFlare(setName: string): string {
		const r: Record<string, string> = {
			HORSESET: "I USED TO GO TO THE RACES SOMETIMES.",
			HORSERACINGSET: "I KNOW PEOPLE WHO GO TO THE TRACK. THEY LOSE MONEY.",
			MONEYSET: "MONEY IS TIGHT. I DON'T HAVE MUCH.",
			GAMBLERSET: "I'VE DONE SOME GAMBLING. IT'S DANGEROUS.",
			BOOKIESET: "BOOKIES ARE CROOKED. THEY WORK FOR THE MAFIA.",
			CHEATSET: "PEOPLE ARE ALWAYS TRYING TO CHEAT ME.",
			GANGSTERSET: "THE GANGSTERS ARE INVOLVED IN EVERYTHING.",
			RACKETSET: "THE RACKETS ARE RUN BY ORGANIZED CRIME.",
			MAFIASET: "THE MAFIA IS OUT TO GET ME. THEY'VE BEEN FOLLOWING ME.",
			PERSONSET: "I KNOW SOME PEOPLE IN THE ORGANIZATION.",
			ITALIANSET: "THE ITALIANS RUN THINGS AROUND HERE.",
			POLICESET: "THE POLICE DON'T DO ANYTHING ABOUT REAL CRIME.",
		};
		return r[setName] ?? "I DON'T KNOW WHAT YOU MEAN.";
	}

	private kwCycle = new Map<string, number>();

	private pick(keyword: string, alternatives: number[]): number {
		const idx = (this.kwCycle.get(keyword) ?? 0) % alternatives.length;
		this.kwCycle.set(keyword, idx + 1);
		return alternatives[idx];
	}

	response(input: string): string {
		const tokens = this.canonicalTokenize(input);

		this.modifyVariables();
		this.applyInferences();
		this.applyEmotionalJumps();

		const patNum = this.matchPatterns(tokens, this.simplePatterns) ?? this.matchPatterns(tokens, this.compoundPatterns);

		if (patNum !== null) {
			const r = this.express(patNum);
			if (r) return this.finalizeResponse(r);
		}

		// SPECFN
		if (tokens.includes("GO") || tokens.includes("CONTINUE")) return this.finalizeResponse(this.expressOrSynth(16));
		if (tokens.includes("ELAB")) return this.finalizeResponse(this.expressOrSynth(24));

		// FLAREREF
		if (this.checkFlare(tokens)) {
			const fs = this.getFlareSet(this.flare);
			if (fs) {
				this.flareRecord(fs);
				return this.finalizeResponse(this.expressFlare(fs));
			}
		}

		// DELREF
		if (this.delCheck(tokens)) {
			if (this.delFlag) this.jumps.fjump = 0.4;
			else this.jumps.fjump = 0.5;
			this.delFlag = true;
			this.flare = "INIT";
			this.topic = "DELUSIONS";
			return this.finalizeResponse(this.expressOrSynth(1020));
		}

		// MISCQ
		if (tokens[0] === "WHY" || tokens[0] === "HOW") {
			return this.finalizeResponse(this.expressOrSynth(200));
		}

		// MISCS
		if (tokens.includes("HELLO") || tokens.includes("HI")) {
			return this.finalizeResponse(this.expressOrSynth(10));
		}

		// KEYWORD fallback with cycling alternatives
		const kwMap: Record<string, number[]> = {
			I: [600, 630, 4924],
			YOU: [630, 600, 408],
			DOCTOR: [150, 104, 70],
			HOSPITAL: [70, 56, 150],
			FEEL: [21, 384, 4924],
			THINK: [600, 384, 4924],
			WANT: [1020, 528, 128],
		};
		for (const [kw, alts] of Object.entries(kwMap)) {
			if (tokens.includes(kw)) {
				return this.finalizeResponse(this.expressOrSynth(this.pick(kw, alts)));
			}
		}

		return this.finalizeResponse("I SEE, PLEASE GO ON.");
	}

	private finalizeResponse(resp: string): string {
		const tokens = this.canonicalTokenize(resp);
		for (const word of tokens) {
			const fs = this.getFlareSet(word);
			if (fs && this.liveFlares.includes(fs)) this.flareMod(fs);
		}
		if (tokens.includes("MAFIA")) {
			this.delFlag = true;
			this.flare = "INIT";
			this.topic = "DELUSIONS";
		}
		return resp;
	}

	addResponse(num: number, text: string) {
		this.pdat.set(num, text);
	}
}
