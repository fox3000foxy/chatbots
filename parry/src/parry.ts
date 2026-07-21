/**
 * ============================================================================
 * PARRY -- TypeScript port
 * ============================================================================
 *
 * Faithful reimplementation of Kenneth Colby's 1972 PARRY, a simulation of a
 * patient with paranoid schizophrenia (original: MLISP/FAIL/LAP on a PDP-10).
 * See this repo's README for the full historical background and the belief-
 * network / emotional-model reference tables; this file's comments focus on
 * how the code implements those ideas.
 *
 * UNLIKE ELIZA (pure pattern matching with no internal state), PARRY layers
 * three cooperating systems on top of pattern matching:
 *
 *   1. EMOTIONS - four numbers (anger, fear, mistrust, hurt) that decay
 *      toward a baseline every turn (modifyVariables) and jump upward when
 *      triggered (applyEmotionalJumps). High fear/anger is what pushes PARRY
 *      toward its paranoid, defensive responses.
 *
 *   2. BELIEFS - a list of (name, strength 0-5, category, negated) records
 *      representing what PARRY currently believes ("the mafia is after me",
 *      strength 4). The INFERENCE ENGINE (applyInferences) mutates belief
 *      strengths and schedules emotional jumps each turn based on simple
 *      IF/TH2/EMOTE rules loaded from the original data files.
 *
 *   3. FLARES - an escalating chain of delusion topics (see checkFlare /
 *      getFlareSet / the Flare/Delusion hierarchy table in the README).
 *      Certain trigger words move PARRY from a neutral flare set toward
 *      increasingly paranoid ones (horses -> horse racing -> gambling ->
 *      bookies -> the mafia...), and once "delusional mode" (delFlag) is
 *      entered PARRY's fear stops decaying normally.
 *
 * Each turn (see response() near the bottom of this file), PARRY: decays
 * emotions, runs the inference engine, applies any resulting emotional
 * jumps, THEN tries (in priority order) a direct pattern match, a few fixed
 * special cases (continue/elaborate), the flare/delusion system, the
 * delusion-trigger check, generic why/how questions, greetings, and finally
 * a keyword-based fallback that cycles between a few canned responses per
 * keyword so it doesn't repeat itself immediately.
 */
import { existsSync, readFileSync } from "node:fs";

/** The four continuously-decaying emotional variables (see README's
 * "Emotional Model" table for each one's baseline and decay rate). */
interface Emotions {
	anger: number;
	fear: number;
	mistrust: number;
	hurt: number;
}

/** Pending emotional "jumps" computed by the inference engine this turn
 * (applyInferences) and then added onto `emotions` in applyEmotionalJumps,
 * then reset to zero at the start of the next turn's modifyVariables(). */
interface EmotionJumps {
	ajump: number;
	fjump: number;
	hjump: number;
}

/** HUM = self, HUM2 = other people, DOC = the doctor/interviewer, INT = the
 * interview itself, INN = intentions/motivations - see README's Belief
 * Network table. */
type BeliefCategory = "HUM" | "HUM2" | "DOC" | "INT" | "INN";

/** One item in PARRY's belief store: how strongly (0-5) he holds some idea,
 * what kind of belief it is, and whether it's negated (disbelieved). */
interface Belief {
	name: string;
	strength: number;
	category: BeliefCategory;
	negated: boolean;
}

/** One rule from the original `inf` data file. TH2 = belief decay/spread,
 * EMOTE = belief-triggered emotional jump, IF = conditional belief
 * propagation - see applyInferences() below for how each type is executed. */
interface Inference {
	type: "TH2" | "EMOTE" | "IF";
	condition: string[];
	consequences: string[];
}

/** A canonicalised token sequence (see canonicalTokenize) mapped to the
 * pdat response number it should trigger if matched (see matchPatterns). */
interface Pattern {
	tokens: string[];
	response: number;
}

export class Parry {
	// --- Linguistic tables loaded from the original PDP-10 data files (see
	// loadDataFiles below) - canonicalising words and matching sentences.
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

	// --- The emotional model (see interfaces above and modifyVariables /
	// applyEmotionalJumps below).
	private emotions: Emotions = { anger: 0, fear: 0, mistrust: 0, hurt: 0 };
	private baselines: Emotions = { anger: 0, fear: 0, mistrust: 0, hurt: 0 };
	private jumps: EmotionJumps = { ajump: 0, fjump: 0, hjump: 0 };

	// --- The flare/delusion escalation state (see checkFlare/getFlareSet
	// and the Flare/Delusion Topic Hierarchy diagram in the README).
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
	/** The response database: response-number -> canned text. In the real
	 * PDP-10 archive this file (`pdatb`) survives only as a skeleton, so
	 * most entries here are synthesised (see synthetic()) rather than
	 * recovered originals - see the README's History section. */
	private pdat = new Map<number, string>();

	private patternRe: RegExp;

	constructor() {
		this.patternRe = /^\(\((.*)\)\s+(?:\x02|P)(\d+)\)$/;
	}

	/** Loads every one of the ~58 original PDP-10 data files (synonym
	 * dictionary, idiom/irregular-verb tables, belief network, inference
	 * rules, response patterns, ...) from `dataDir` - see the README's
	 * "Original Data Files" table for what each file contributes. */
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

	/** Normalises a word to its canonical form for matching purposes:
	 * synonym table first (e.g. regional spelling variants), then idioms,
	 * then irregular verb forms, falling back to the uppercased word itself
	 * if none of the tables have an entry. */
	private wordCanonical(word: string): string {
		const upper = word.toUpperCase();
		return this.synonyms.get(upper) ?? this.idioms.get(upper) ?? this.irregulars.get(upper) ?? upper;
	}

	/** Turns a raw input sentence into the canonical token list used for
	 * pattern matching everywhere else in this class: uppercase, strip
	 * punctuation, split on whitespace, canonicalise each word (see
	 * wordCanonical), and truncate long words to 5 characters - mirroring
	 * the original system's fixed-width "first 5 chars" word representation
	 * (see the README's synonm.alf description). */
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

	/** True if `pattern` appears anywhere as a contiguous subsequence of
	 * `input` (a simple sliding-window substring search over token arrays;
	 * an empty pattern always matches, used for wildcard-style entries). */
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

	/** Tries every pattern in order (spats.sel-style simple patterns first,
	 * then cpats.sel-style compound ones - see the README's data file
	 * table) and returns the response number of the first one whose token
	 * sequence appears in the input, or null if none match. */
	private matchPatterns(tokens: string[], patterns: Pattern[]): number | null {
		for (const pat of patterns) {
			if (this.matchTokens(tokens, pat.tokens)) return pat.response;
		}
		return null;
	}

	/** Returns the first item of `list` that also appears in `tokens`, or
	 * null - a simple "does the input mention any of these words" check. */
	private memberAny(list: string[], tokens: string[]): string | null {
		for (const item of list) {
			if (tokens.includes(item)) return item;
		}
		return null;
	}

	/**
	 * Runs once per turn, BEFORE processing the new input: decays every
	 * emotion a step toward its baseline (see the README's Emotional Model
	 * table for each variable's rate), with fear decaying more slowly (or
	 * not really decaying below +5) while `delFlag` (delusional mode) is
	 * active - modelling how paranoid fear, once triggered, lingers far
	 * longer than ordinary anger or hurt. Also clears last turn's emotional
	 * jumps so applyInferences() can compute fresh ones for this turn.
	 */
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

	/** Adds this turn's computed jumps (see applyInferences) onto the
	 * running emotional totals. A hurt-jump also bleeds into anger and
	 * mistrust, modelling how feeling hurt compounds into anger/suspicion
	 * rather than staying isolated. */
	private applyEmotionalJumps() {
		this.emotions.anger += this.jumps.ajump;
		this.emotions.fear += this.jumps.fjump;
		this.emotions.hurt += this.jumps.hjump;
		this.emotions.mistrust += this.jumps.hjump * 0.5;
	}

	/**
	 * The inference engine: walks every rule loaded from the original `inf`
	 * data file and executes it against the current belief store.
	 *   - TH2 (belief decay/spread): if belief A is held strongly (> 0),
	 *     weaken it by 2 and strengthen each of its listed consequences by
	 *     1 - modelling how one paranoid idea "uses itself up" while
	 *     spreading suspicion to related beliefs.
	 *   - EMOTE (emotional jump): if a belief in the consequences list is
	 *     held (> 0), schedule an anger/fear/hurt jump of the given
	 *     magnitude (queued in `this.jumps`, applied next by
	 *     applyEmotionalJumps). A hurt-jump also contributes half its size
	 *     to anger, same coupling as above.
	 *   - IF is a straightforward conditional belief propagation and is
	 *     handled by the data-loading step rather than here (see
	 *     loadInferences), since IF rules apply once, at load time.
	 */
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

	/**
	 * Checks whether any word in the input belongs to a known "flare set"
	 * (a delusion topic - see getFlareSet/getFlareWeight and the README's
	 * Flare/Delusion Topic Hierarchy) and, if the highest-weighted match
	 * outranks the currently active flare (or we're still at the neutral
	 * "INIT" flare), moves PARRY's current topic (`this.flare`) to it. This
	 * is the mechanism that lets a conversation drift from "horses" toward
	 * "horse racing" toward "gambling" toward "the mafia" as the user (even
	 * innocently) keeps mentioning related words - each step only escalates
	 * forward, never backward, matching the original's one-way trigger
	 * chain.
	 */
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

	/** True if the input contains a delusion-triggering noun/verb (MAFIA,
	 * GUN, KILL, SPY, ...), or - only once mistrust has built up past 10 -
	 * one of the deliberately ambiguous trigger words (BEAT, HATE) that are
	 * innocuous early in a conversation but paranoia-inducing once PARRY is
	 * already suspicious. Used by response() to decide whether to force
	 * PARRY into full delusional mode. */
	private delCheck(inp: string[]): boolean {
		if (this.memberAny(this.delNouns, inp)) return true;
		if (this.memberAny(this.delVerbs, inp)) return true;
		if (this.emotions.mistrust > 10 && this.memberAny(this.delAmbiguous, inp)) return true;
		return false;
	}

	/** Looks up a canned response by its pdat number, or null if that
	 * number isn't in the (mostly-lost) original response database. */
	private express(num: number): string | null {
		return this.pdat.get(num) ?? null;
	}

	/** Same as express(), but falls back to a hand-written synthetic()
	 * response when the original pdat entry is missing - which, per the
	 * README, is true for most entries since only skeleton pdat data
	 * survived. */
	private expressOrSynth(num: number): string {
		return this.pdat.get(num) ?? this.synthetic(num);
	}

	/**
	 * Hand-written replacement text for response numbers whose original
	 * pdat entry was lost (see the class-level `pdat` field comment and the
	 * README's History section). These are NOT recovered originals - they
	 * are this port's own best-guess paraphrase of what a paranoid patient
	 * might plausibly say for that response slot, picked at random from a
	 * few alternatives (via randomIdx) to avoid always repeating the exact
	 * same line for the same trigger.
	 */
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
		return alts[this.randomIdx(alts.length, `synth_${n}`)];
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

	private lastKw = new Map<string, number>();

	private pick(keyword: string, alternatives: number[]): number {
		const avoid = this.lastKw.get(keyword);
		const filtered = alternatives.filter((_, i) => i !== avoid);
		const idx = filtered.length > 0 ? filtered[Math.floor(Math.random() * filtered.length)] : alternatives[Math.floor(Math.random() * alternatives.length)];
		const actualIdx = alternatives.indexOf(idx);
		this.lastKw.set(keyword, actualIdx);
		return idx;
	}

	private randomIdx(len: number, key: string): number {
		const avoid = this.lastKw.get(key);
		let idx: number;
		do {
			idx = Math.floor(Math.random() * len);
		} while (idx === avoid && len > 1);
		this.lastKw.set(key, idx);
		return idx;
	}

	/**
	 * Produces PARRY's reply to one line of input. Order of operations:
	 *
	 *   1. Tokenise + canonicalise the input (canonicalTokenize).
	 *   2. Run the per-turn upkeep: emotion decay (modifyVariables), the
	 *      inference engine (applyInferences), then apply whatever
	 *      emotional jumps it scheduled (applyEmotionalJumps). This happens
	 *      BEFORE looking at what to say, so the emotional state driving
	 *      word choice below already reflects this turn's input.
	 *   3. Try a direct pattern match first (matchPatterns against the
	 *      simple then compound pattern tables) - the closest thing to
	 *      "understanding" the specific sentence.
	 *   4. If nothing matched, fall through a fixed priority list of
	 *      special cases, each one a documented behaviour of the original
	 *      system:
	 *        - SPECFN: "go on"/"continue" or "elaborate" requests get fixed
	 *          canned responses (16, 24).
	 *        - FLARE: if this input pushes the delusion topic forward (see
	 *          checkFlare), respond from that flare's own response set.
	 *        - DELREF: certain delusion-trigger words (see delCheck) push
	 *          PARRY fully into delusional mode (delFlag) with a fear jump.
	 *        - MISCQ: generic "why"/"how" questions get a stock reply.
	 *        - MISCS: greetings get a stock reply.
	 *        - keyword fallback: a small table of common words (I, YOU,
	 *          DOCTOR, ...) each with a few alternative responses, cycled
	 *          via pick() so the same keyword doesn't always get the exact
	 *          same reply twice in a row.
	 *   5. If truly nothing matched anything, a last-resort generic reply.
	 *
	 * Every returned string passes through finalizeResponse(), which can
	 * still adjust flare state based on words PARRY itself just said.
	 */
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
