import { readFileSync, existsSync } from "node:fs";

// ---- Types ----
type StringList = string[];

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
	guard?: string;
}

interface Pattern {
	tokens: string[];
	response: number; // octal or decimal semantic unit number
}

interface SemanticUnit {
	number: number;
	type: "B" | "E";
	anaph?: Array<[string, number]>;
	exh?: boolean;
	normal?: Array<[string[], Array<[string, string]>]>;
	embd?: Array<[string[], Array<[string, string]>]>;
	// B-type
	contents?: string[];
	keywds?: string[];
	lit?: string[];
	sqr?: string[];
}

interface Flare {
	name: string;
	set: string;
	weight: number;
	next: string;
	words: string[];
	type: "INSTITUTION" | "INDIVIDUAL";
	story: number[];
	used: boolean;
}

// ---- PARRY Engine ----
export class Parry {
	// Data
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
	private fillerPatterns: Pattern[] = [];
	private negatePatterns: Pattern[] = [];
	private familyPatterns: Pattern[] = [];

	// Emotional state
	private emotions: Emotions = { anger: 0, fear: 0, mistrust: 0, hurt: 0 };
	private baselines: Emotions = { anger: 0, fear: 0, mistrust: 0, hurt: 0 };
	private jumps: EmotionJumps = { ajump: 0, fjump: 0, hjump: 0 };

	// Delusion system
	private delFlag = false;
	private flare: string = "INIT";
	private flareList: string[] = [];
	private liveFlares: string[] = [];
	private deadFlares: string[] = [];
	private delNouns: string[] = [];
	private delVerbs: string[] = [];
	private delAmbiguous: string[] = [];
	private weak = false;
	private delEnd = false;
	private sensitiveList: string[] = [];
	private suppress: string | null = null;
	private chosen: string | null = null;
	private topic: string | null = null;
	private wdFlag: string | null = null;
	private weight = 0;

	// Anaphora
	private anaphList = new Map<string, string>();
	private allAnaphs: string[] = [];

	// PDAT emulation
	private pdat = new Map<number, SemanticUnit>();

	// Conversation history
	private inputHistory: string[] = [];
	private outputHistory: string[] = [];

	// Load all data files
	loadDataFiles(dataDir: string) {
		this.loadSynonyms(`${dataDir}/synonm.alf`);
		this.loadIdioms(`${dataDir}/idiom.alf`);
		this.loadIrregulars(`${dataDir}/irreg.alf`);
		this.loadFlags(`${dataDir}/flags.alf`);
		this.loadSuffixes(`${dataDir}/suffix.alf`);
		this.loadBoundaryWords(`${dataDir}/startr.alf`, this.startWords);
		this.loadBoundaryWords(`${dataDir}/stoppr.alf`, this.stopWords);
		this.loadSimplePatterns(`${dataDir}/spats.sel`);
		this.loadCompoundPatterns(`${dataDir}/cpats.sel`);
		this.loadBeliefs(`${dataDir}/bel`);
		this.loadInferences(`${dataDir}/inf`);
		this.loadPatternFile(`${dataDir}/filler.pat`, this.fillerPatterns);
		this.loadPatternFile(`${dataDir}/negate.pat`, this.negatePatterns);
		this.loadPatternFile(`${dataDir}/famly.pat`, this.familyPatterns);

		this.initEmotions();
		this.initFlares();
	}

	private loadSynonyms(path: string) {
		for (const line of this.readLines(path)) {
			const m = line.match(/^\((\S+)\s+(\S+)\)/);
			if (m) this.synonyms.set(m[1], m[2]);
		}
	}

	private loadIdioms(path: string) {
		for (const line of this.readLines(path)) {
			const m = line.match(/^\((\S+)\s+(.+)\)\s*$/);
			if (m) this.idioms.set(m[1], m[2]);
		}
	}

	private loadIrregulars(path: string) {
		for (const line of this.readLines(path)) {
			const m = line.match(/^\((\S+)\s+(.+)\)\s*$/);
			if (m) this.irregulars.set(m[1], m[2]);
		}
	}

	private loadFlags(path: string) {
		for (const line of this.readLines(path)) {
			const m = line.match(/^\((\S+)\)/);
			if (m) this.flags.add(m[1]);
		}
	}

	private loadSuffixes(path: string) {
		for (const line of this.readLines(path)) {
			const trimmed = line.trim();
			if (trimmed && !trimmed.startsWith(";")) {
				this.suffixes.push(trimmed);
			}
		}
	}

	private loadBoundaryWords(path: string, set: Set<string>) {
		for (const line of this.readLines(path)) {
			const trimmed = line.trim().toUpperCase();
			if (trimmed && !trimmed.startsWith(";") && !trimmed.startsWith("(")) {
				set.add(trimmed);
			}
		}
	}

	private loadSimplePatterns(path: string) {
		for (const line of this.readLines(path)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith(";")) continue;
			// Format: ((TOKEN1 TOKEN2 ...) NNNN) or ((TOKEN1 ...) PNNNN)
			const m = trimmed.match(/^\(\((.*)\)\s+(?:|P)(\d+)\)/);
			if (m) {
				const tokens = m[1].trim().split(/\s+/);
				const num = Number.parseInt(m[2], 10);
				this.simplePatterns.push({ tokens, response: num });
			}
		}
	}

	private loadCompoundPatterns(path: string) {
		for (const line of this.readLines(path)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith(";")) continue;
			// Same format as simple patterns
			const m = trimmed.match(/^\(\((.*)\)\s+(?:|P)(\d+)\)/);
			if (m) {
				const tokens = m[1].trim().split(/\s+/);
				const num = Number.parseInt(m[2], 10);
				this.compoundPatterns.push({ tokens, response: num });
			}
		}
	}

	private loadPatternFile(path: string, target: Pattern[]) {
		for (const line of this.readLines(path)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("~")) continue;
			const m = trimmed.match(/^\(\((.*)\)\s+(?:|P)(\d+)\)/);
			if (m) {
				const tokens = m[1].trim().split(/\s+/);
				const num = Number.parseInt(m[2], 10);
				target.push({ tokens, response: num });
			}
		}
	}

	private loadBeliefs(path: string) {
		for (const line of this.readLines(path)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("~") || trimmed.startsWith(";")) continue;
			// Format: (NAME STRENGTH CATEGORY ...) or (*NAME STRENGTH CATEGORY ...)
			const m = trimmed.match(/^\((\*?)(\S+)\s+(\d+)\s+(\S+)/);
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
		for (const line of this.readLines(path)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("~") || trimmed.startsWith(";")) continue;
			if (trimmed.startsWith("(TH2")) {
				const rest = trimmed.slice(4, -1).trim();
				const parts = this.parseInferenceArgs(rest);
				if (parts.length >= 2) {
					this.inferences.push({
						type: "TH2",
						condition: [parts[0]],
						consequences: parts.slice(1),
					});
				}
			} else if (trimmed.startsWith("(EMOTE")) {
				const rest = trimmed.slice(6, -1).trim();
				const m = rest.match(/^\((\w+\s+-?[\d.]+)\)\s+(.+)/);
				if (m) {
					const jumpParts = m[1].split(/\s+/);
					const consequences = m[2].trim().split(/\s+/);
					this.inferences.push({
						type: "EMOTE",
						condition: jumpParts,
						consequences,
					});
				}
			} else if (trimmed.startsWith("(IF")) {
				const rest = trimmed.slice(2, -1).trim();
				const parts = this.parseInferenceArgs(rest);
				if (parts.length >= 3) {
					this.inferences.push({
						type: "IF",
						condition: [parts[0], parts[1]],
						consequences: parts.slice(2),
					});
				}
			}
		}
	}

	private parseInferenceArgs(s: string): string[] {
		const result: string[] = [];
		let depth = 0;
		let current = "";
		for (const ch of s) {
			if (ch === "(") { depth++; if (depth > 1) current += ch; }
			else if (ch === ")") { depth--; if (depth > 0) current += ch; else if (depth === 0 && current) { result.push(current.trim()); current = ""; } }
			else if (ch === " " && depth === 0) { if (current) { result.push(current.trim()); current = ""; } }
			else current += ch;
		}
		if (current) result.push(current.trim());
		return result;
	}

	private initEmotions() {
		this.emotions = { anger: 0, fear: 0, mistrust: 0, hurt: 0 };
		this.baselines = { anger: 0, fear: 0, mistrust: 0, hurt: 0 };
		this.jumps = { ajump: 0, fjump: 0, hjump: 0 };
	}

	private initFlares() {
		this.flare = "INIT";
		this.liveFlares = ["HORSESET", "RACESET", "GAMBLESET", "BOOKIESET", "GANGSTSET", "MAFIASET"];
		this.deadFlares = [];
		this.delFlag = false;
		this.delEnd = false;
	}

	// ---- Core Functions ----

	// Synonym reduction to canonical 5-letter form
	private wordCanonical(word: string): string {
		const upper = word.toUpperCase();
		const fromSyn = this.synonyms.get(upper);
		if (fromSyn) return fromSyn;
		const fromIdiom = this.idioms.get(upper);
		if (fromIdiom) return fromIdiom;
		const fromIrreg = this.irregulars.get(upper);
		if (fromIrreg) return fromIrreg;
		// Try stripping suffixes
		for (const sfx of this.suffixes) {
			if (upper.endsWith(sfx)) {
				const base = upper.slice(0, -sfx.length);
				const fromBase = this.synonyms.get(base);
				if (fromBase) return fromBase;
			}
		}
		return upper;
	}

	// Split input into canonical tokens
	private canonicalTokenize(input: string): string[] {
		let text = input.toUpperCase();
		// Remove punctuation except periods and question marks (sentence boundaries)
		text = text.replace(/[^A-Z0-9\s'.?-]/g, " ").replace(/\s+/g, " ").trim();
		const rawWords = text.split(/\s+/).filter((w) => w.length > 0);
		// Split on sentence boundaries
		const tokens: string[] = [];
		for (const word of rawWords) {
			// Handle contractions via irregulars
			const canon = this.wordCanonical(word);
			// Truncate to 5 characters (PARRY convention)
			tokens.push(canon.length > 5 ? canon.slice(0, 5) : canon);
		}
		return tokens;
	}

	// Match tokens against pattern list; return first match
	private matchPatterns(tokens: string[], patterns: Pattern[]): number | null {
		for (const pat of patterns) {
			if (this.tokensMatch(tokens, pat.tokens)) {
				return pat.response;
			}
		}
		return null;
	}

	private tokensMatch(input: string[], pattern: string[]): boolean {
		if (pattern.length === 0) return true;
		if (pattern.length > input.length) return false;
		// Simple prefix match for now (PARRY uses this)
		for (let i = 0; i < pattern.length; i++) {
			if (pattern[i] !== input[i]) return false;
		}
		return true;
	}

	// Check if any member of list appears in tokens
	private memberAny(list: string[], tokens: string[]): string | null {
		for (const item of list) {
			for (const tok of tokens) {
				if (tok === item) return item;
			}
		}
		return null;
	}

	// ---- Emotional Model (from opar3 MODIFVAR) ----
	private modifyVariables() {
		this.emotions.anger = Math.max(this.emotions.anger - 1, this.baselines.anger);
		this.emotions.hurt = Math.max(this.emotions.hurt - 0.5, this.baselines.hurt);
		if (this.delFlag) {
			this.emotions.fear = Math.max(this.emotions.fear - 0.1, this.baselines.fear + 5);
		} else if (this.flare !== "INIT") {
			this.emotions.fear = Math.max(this.emotions.fear - 0.2, this.baselines.fear + 3);
		} else {
			this.emotions.fear = Math.max(this.emotions.fear - 0.3, this.baselines.fear);
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

	// ---- Belief System ----
	private getBelief(name: string): Belief | undefined {
		return this.beliefs.find((b) => b.name === name);
	}

	private setBeliefStrength(name: string, newStrength: number) {
		const b = this.getBelief(name);
		if (b) b.strength = newStrength;
	}

	private applyInferences() {
		for (const inf of this.inferences) {
			if (inf.type === "TH2") {
				// TH2: condition belief strength decays by 2 each turn
				const cond = inf.condition[0];
				const bel = this.getBelief(cond);
				if (bel && bel.strength > 0) {
					bel.strength = Math.max(0, bel.strength - 2);
					// Consequences are triggered when strength > 0
					for (const cons of inf.consequences) {
						const consBel = this.getBelief(cons);
						if (consBel) consBel.strength = Math.min(5, consBel.strength + 1);
					}
				}
			} else if (inf.type === "EMOTE") {
				// EMOTE: emotional jumps based on beliefs
				const jumpType = inf.condition[0];
				const jumpAmount = Number.parseFloat(inf.condition[1]);
				const triggerBeliefs = inf.consequences;
				for (const belName of triggerBeliefs) {
					const bel = this.getBelief(belName);
					if (bel && bel.strength > 0) {
						if (jumpType === "AJUMP") this.jumps.ajump += jumpAmount;
						else if (jumpType === "FJUMP") this.jumps.fjump += jumpAmount;
						else if (jumpType === "HJUMP") {
							this.jumps.hjump += jumpAmount;
							this.jumps.ajump += jumpAmount * 0.5;
						}
					}
				}
			}
		}
	}

	// ---- Flare/Delusion System ----
	private checkFlare(inp: string[]): boolean {
		let nFlare = "INIT";
		let result = false;
		let wt = 0;
		let w: string | null = null;

		for (const word of inp) {
			const fset = this.getFlareSet(word);
			if (fset && (this.liveFlares.includes(fset) || this.deadFlares.includes(fset))) {
				const fwt = this.getFlareWeight(fset);
				const nwt = this.getFlareWeight(this.getFlareSet(nFlare) || "");
				if (fwt > nwt) {
					nFlare = word;
					result = true;
					w = word;
					wt = fwt;
				}
			}
		}
		if (result) {
			if (this.flare === "INIT" || wt > 1) {
				this.flare = nFlare;
				this.weight = wt;
			} else {
				result = false;
			}
		}
		return result;
	}

	private getFlareSet(word: string): string | null {
		const flareMap: Record<string, string> = {
			"HORSE": "HORSESET",
			"RACE": "RACESET",
			"GAMBL": "GAMBLESET",
			"BOOKI": "BOOKIESET",
			"GANGS": "GANGSTSET",
			"MAFIA": "MAFIASET",
		};
		return flareMap[word] || null;
	}

	private getFlareWeight(fset: string): number {
		const weights: Record<string, number> = {
			"HORSESET": 1,
			"RACESET": 2,
			"GAMBLESET": 3,
			"BOOKIESET": 4,
			"GANGSTSET": 5,
			"MAFIASET": 6,
		};
		return weights[fset] || 0;
	}

	private flareRecord(fset: string) {
		this.flareMod(fset);
		this.jumps.fjump = this.weight / 40.0;
		this.topic = fset;
	}

	private flareMod(fset: string) {
		this.liveFlares = this.liveFlares.filter((f) => f !== fset);
		if (!this.deadFlares.includes(fset)) this.deadFlares.push(fset);
		this.fixPointers(fset);
	}

	private fixPointers(flset: string) {
		const nextFlare = this.getNextFlare(flset);
		if (nextFlare) {
			for (const f of [...this.liveFlares, ...this.deadFlares]) {
				if (this.getNextFlare(f) === flset) {
					this.setNextFlare(f, nextFlare);
				}
			}
		}
	}

	private getNextFlare(fset: string): string | null {
		const chain: Record<string, string> = {
			"HORSESET": "RACESET",
			"RACESET": "GAMBLESET",
			"GAMBLESET": "BOOKIESET",
			"BOOKIESET": "GANGSTSET",
			"GANGSTSET": "MAFIASET",
		};
		return chain[fset] || null;
	}

	private setNextFlare(fset: string, next: string) {
		// In the original, this modifies the property list
		// Simplified: we track this through flareMod
	}

	// ---- Response Selection ----
	response(input: string): string {
		const tokens = this.canonicalTokenize(input);
		this.inputHistory.push(input);

		// 1. Apply emotional decay
		this.modifyVariables();

		// 2. Apply belief-based inferences
		this.applyInferences();

		// 3. Apply emotional jumps from inferences
		this.applyEmotionalJumps();

		// 4. Try to match patterns
		const unitNum = this.matchPatterns(tokens, this.simplePatterns)
			?? this.matchPatterns(tokens, this.compoundPatterns);

		if (unitNum !== null) {
			const response = this.express(unitNum);
			if (response) return this.finalizeResponse(response);
		}

		// 5. Fallback cascade
		const specRef = this.specFn(tokens);
		if (specRef) { const r = this.express(specRef); if (r) return this.finalizeResponse(r); }

		const flareRef = this.flareRef(tokens);
		if (flareRef) { const r = this.expressUnitFromSet(flareRef); if (r) return this.finalizeResponse(r); }

		const delRef = this.delRef(tokens);
		if (delRef) { const r = this.express(delRef); if (r) return this.finalizeResponse(r); }

		const miscQ = this.miscQ(tokens);
		if (miscQ) { const r = this.express(miscQ); if (r) return this.finalizeResponse(r); }

		const miscS = this.miscS(tokens);
		if (miscS) { const r = this.express(miscS); if (r) return this.finalizeResponse(r); }

		// Check for delusion keywords at high mistrust
		if (this.emotions.mistrust > 10) {
			const delKey = this.memberAny(this.delAmbiguous, tokens);
			if (delKey) { const r = this.express(3000); if (r) return this.finalizeResponse(r); }
		}

		// Last resort: keyword scan
		const keyRef = this.keywordRef(tokens);
		if (keyRef) { const r = this.express(keyRef); if (r) return this.finalizeResponse(r); }

		// Ultimate fallback
		return this.finalizeResponse("I SEE, PLEASE GO ON.");
	}

	private finalizeResponse(response: string): string {
		this.outputHistory.push(response);
		// Check if PARRY's response mentions flares or delusions
		this.ascan(response);
		return response;
	}

	// Express a semantic unit number as English text
	private express(unitNum: number): string | null {
		// Try PDAT lookup; fall back to synthetic response
		const unit = this.pdat.get(unitNum);
		if (unit && unit.type === "E" && unit.normal && unit.normal.length > 0) {
			const [sentence, anaphs] = unit.normal[0];
			for (const [ref, meaning] of anaphs) {
				this.anaphList.set(ref, meaning);
			}
			return sentence.join(" ");
		}
		return this.syntheticResponse(unitNum);
	}

	private syntheticResponse(unitNum: number): string {
		const responses: Record<number, string> = {
			10: "HELLO. WHAT DO YOU WANT?",
			16: "PLEASE GO ON.",
			17: "WHAT MAKES YOU FEEL THAT WAY?",
			21: "I SEE. TELL ME MORE ABOUT YOUR FEELINGS.",
			24: "CAN YOU ELABORATE ON THAT?",
			42: "HELLO. WHAT DO YOU WANT TO TALK ABOUT?",
			56: "I'M IN THE HOSPITAL.",
			70: "THE DOCTORS HERE ARE OK I GUESS.",
			104: "THE DOCTOR SEEMS ALRIGHT.",
			128: "I DON'T KNOW WHY YOU ASK THAT.",
			150: "WHY DO YOU WANT TO KNOW ABOUT THE DOCTOR?",
			200: "WHY DO YOU ASK?",
			384: "I DON'T KNOW WHAT TO SAY ABOUT THAT.",
			408: "WHAT ABOUT ME?",
			528: "THE MAFIA IS AFTER ME. THAT'S WHAT I THINK.",
			600: "I DON'T KNOW WHAT TO SAY ABOUT MYSELF.",
			630: "WHY ARE YOU ASKING ABOUT ME?",
			1020: "I WANT TO GET OUT OF HERE.",
			1536: "WHAT MAKES YOU SAY THAT?",
			3000: "WHAT DO YOU MEAN BY THAT?",
			4924: "I DON'T KNOW WHAT YOU'RE TALKING ABOUT.",
		};
		return responses[unitNum] ?? "I DON'T KNOW WHAT YOU MEAN.";
	}

	private expressUnitFromSet(setName: string): string | null {
		const flareResponses: Record<string, string> = {
			"HORSESET": "I USED TO GO TO THE RACES SOMETIMES. IT WAS FUN.",
			"RACESET": "I KNOW SOME PEOPLE WHO GO TO THE TRACK. THEY LOSE A LOT OF MONEY.",
			"GAMBLESET": "I'VE DONE SOME GAMBLING MYSELF. IT'S DANGEROUS.",
			"BOOKIESET": "BOOKIES ARE CROOKED, YOU KNOW. THEY WORK FOR THE MAFIA.",
			"GANGSTSET": "I THINK THE MAFIA IS BEHIND A LOT OF THINGS. IT'S NOT SAFE.",
			"MAFIASET": "THE MAFIA IS OUT TO GET ME, I'M SURE OF IT. THEY'VE BEEN FOLLOWING ME.",
		};
		return flareResponses[setName] || "I DON'T KNOW WHAT YOU MEAN.";
	}

	// ---- Fallback Cascade ----
	private specFn(tokens: string[]): number | null {
		// Check for special functions: GO_ON, ELAB, WHO, WHAT
		if (tokens.includes("GO") || tokens.includes("CONTINUE")) return 16;
		if (tokens.includes("ELAB")) return 24;
		return null;
	}

	private flareRef(tokens: string[]): string | null {
		// Check for new flare and record
		if (this.checkFlare(tokens)) {
			this.flareRecord(this.getFlareSet(this.flare) || "");
		}
		// Check for old flare
		const oldCheck = this.checkFlareIn(tokens, this.deadFlares);
		if (oldCheck) {
			return this.getFlareSet(oldCheck);
		}
		return null;
	}

	private checkFlareIn(tokens: string[], flareList: string[]): string | null {
		for (const word of tokens) {
			const fset = this.getFlareSet(word);
			if (fset && flareList.includes(fset)) return word;
		}
		return null;
	}

	private delRef(tokens: string[]): number | null {
		const found = this.delCheck(tokens);
		if (found) {
			if (!this.delFlag) {
				this.jumps.fjump = 0.5;
				this.flareMod("MAFIASET");
			} else {
				this.jumps.fjump = 0.4;
			}
			this.delFlag = true;
			this.flare = "INIT";
			this.topic = "DELUSIONS";
			// Return a delusion-related response
			return 1020;
		}
		return null;
	}

	private delCheck(inp: string[]): boolean {
		// Check for strong delusion nouns and verbs
		if (this.memberAny(this.delNouns, inp)) return true;
		if (this.memberAny(this.delVerbs, inp)) return true;
		// Check for ambiguous delusion words at high mistrust
		if (this.emotions.mistrust > 10 && this.memberAny(this.delAmbiguous, inp)) return true;
		return false;
	}

	private miscQ(tokens: string[]): number | null {
		// Check for recognizable question types
		if (tokens[0] === "WHY" || tokens[0] === "HOW") return 200;
		return null;
	}

	private miscS(tokens: string[]): number | null {
		// Check for recognizable statements
		if (tokens.includes("HELLO") || tokens.includes("HI")) return 10;
		return null;
	}

	private keywordRef(tokens: string[]): number | null {
		// Scan for ANY keyword as last resort
		const keywords = ["YOU", "I", "DOCTOR", "HOSPITAL", "FEEL", "THINK", "WANT", "KNOW"];
		for (const kw of keywords) {
			if (tokens.includes(kw)) {
				switch (kw) {
					case "I": return 600;
					case "YOU": return 630;
					case "DOCTOR": return 150;
					case "HOSPITAL": return 70;
					case "FEEL": return 21;
					case "THINK": return 600;
					case "WANT": return 1020;
				}
				return 4924;
			}
		}
		return null;
	}

	// Scan PARRY's own answer for flare or mafia mentions
	private ascan(ans: string) {
		const tokens = this.canonicalTokenize(ans);
		for (const word of tokens) {
			const fset = this.getFlareSet(word);
			if (fset && this.liveFlares.includes(fset)) {
				this.flareMod(fset);
			}
		}
		if (tokens.includes("MAFIA")) {
			this.delFlag = true;
			this.flare = "INIT";
			this.topic = "DELUSIONS";
		}
		if (this.delFlag) {
			this.delCheck(tokens);
		}
	}

	// For initial setup / loading PDAT
	addSemanticUnit(unit: SemanticUnit) {
		this.pdat.set(unit.number, unit);
	}

	private readLines(path: string): string[] {
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim().length > 0);
	}
}

export default Parry;
