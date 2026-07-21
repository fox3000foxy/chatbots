/**
 * ============================================================================
 * ELIZA / DOCTOR -- TypeScript port
 * ============================================================================
 *
 * This file is a faithful reimplementation of Joseph Weizenbaum's 1966 ELIZA
 * program (original language: MAD-SLIP on an IBM 7094), based on the C++
 * reconstruction at github.com/anthay/ELIZA which itself uses Weizenbaum's
 * rediscovered original script files.
 *
 * HOW ELIZA WORKS, END TO END (see response() near the middle of this file
 * for the real code - this is the roadmap):
 *
 *   1. The raw input line is uppercased and normalised (elizaUppercase),
 *      then split into words and punctuation tokens (splitUserInput).
 *
 *   2. ELIZA scans the words left to right looking for any word that is a
 *      "keyword" in the loaded script (e.g. "I", "YOU", "MOTHER", "ALIKE").
 *      Every keyword found is pushed onto a "keystack", ordered so that
 *      higher-precedence keywords are tried first (e.g. "MOTHER" typically
 *      outranks "I" so family-related sentences get the more specific
 *      response). While scanning, ELIZA also performs simple word swaps
 *      (I <-> YOU, MY <-> YOUR, ...) so it can mirror the user's pronouns
 *      back at them later ("I am sad" -> "YOU ARE sad").
 *
 *   3. ELIZA pops the highest-priority keyword and tries to match the
 *      user's sentence against that keyword's list of "decomposition"
 *      patterns (see match()/xmatch()). A decomposition pattern is a
 *      sequence like [0, "ARE", "YOU", 1] where 0 means "any number of
 *      words" and 1 means "capture exactly one word" - similar in spirit
 *      to a very old, hand-rolled regular expression engine with named
 *      capture groups.
 *
 *   4. Once a decomposition matches, ELIZA takes the *next* "reassembly"
 *      rule for that pattern (cycling through several canned templates
 *      round-robin, so the same input doesn't always get the exact same
 *      reply - see reassemble()) and slots the captured words back in,
 *      e.g. template ["WHY", "DO", "YOU", "THINK", 2] becomes
 *      "WHY DO YOU THINK <captured words>".
 *
 *   5. Special reassembly forms change this default behaviour:
 *        - NEWKEY: forget this keyword, try the next one on the stack.
 *        - =KEYWORD: jump straight to a different keyword's rules.
 *        - (PRE (...) (=KEYWORD)): rewrite the sentence (typically to swap
 *          pronouns) and re-run keyword scanning on the rewritten sentence -
 *          this is how "YOU'RE happy" can be answered as if the user had
 *          said "I'M happy" transformed appropriately.
 *
 *   6. If nothing on the keystack produces a response, and a special
 *      MEMORY rule is defined, ELIZA can fall back to "recalling" an
 *      earlier remark the user made (see RuleMemory) - this is the closest
 *      thing ELIZA has to state or long-term memory.
 *
 *   7. If everything fails, ELIZA cycles through a small set of generic
 *      stalling replies ("PLEASE CONTINUE", "I SEE", ...) via the NONE
 *      rule / NOMATCH_MSGS.
 *
 * ELIZA itself has NO understanding of meaning - everything above is
 * mechanical pattern matching and text substitution driven entirely by the
 * data in the loaded .ela script (see the `scripts/` folder). The
 * "intelligence" people perceive comes from how cleverly the DOCTOR script
 * was authored, not from anything in this engine.
 */

type StringList = string[];

/** Splits a string on single spaces only (script-file tokens are already
 * space-separated, so this is simpler than a general-purpose word splitter). */
function split(s: string): StringList {
	const result: StringList = [];
	let word = "";
	for (const ch of s) {
		if (ch === " ") {
			if (word) {
				result.push(word);
				word = "";
			}
		} else {
			word += ch;
		}
	}
	if (word) {
		result.push(word);
	}
	return result;
}

/** Inverse of split(): re-joins a word list into a single space-separated string. */
function join(words: StringList): string {
	return words.filter((w) => w).join(" ");
}

/** Parses a string as a non-negative integer, or -1 if it isn't one. Used
 * throughout the decomposition-pattern matcher, where pattern tokens can be
 * either literal words or small integers (0 = wildcard, N = "capture N words"). */
function toInt(s: string): number {
	if (/^\d+$/.test(s)) {
		return Number.parseInt(s, 10);
	}
	return -1;
}

// ---- Hollerith encoding for HASH function ----
// The original 1960s ELIZA ran on an IBM 7094 which stored characters using
// 6-bit Hollerith/BCD codes, not ASCII. The MEMORY-rule hashing function
// (see hash() below) reproduces the original bit-for-bit arithmetic, which
// depends on this exact encoding table. It only matters for picking *which*
// of the 4 canned memory-rule templates gets used for a given remark - it
// has no bearing on meaning, it's essentially a pseudo-random index.
const HOLLERITH_UNDEFINED = 0xff;
const HOLLERITH_ENCODING: Uint8Array = (() => {
	const bcd = [
		"0",
		"1",
		"2",
		"3",
		"4",
		"5",
		"6",
		"7",
		"8",
		"9",
		null,
		"=",
		"'",
		null,
		null,
		null,
		"+",
		"A",
		"B",
		"C",
		"D",
		"E",
		"F",
		"G",
		"H",
		"I",
		null,
		".",
		")",
		null,
		null,
		null,
		"-",
		"J",
		"K",
		"L",
		"M",
		"N",
		"O",
		"P",
		"Q",
		"R",
		null,
		"$",
		"*",
		null,
		null,
		null,
		" ",
		"/",
		"S",
		"T",
		"U",
		"V",
		"W",
		"X",
		"Y",
		"Z",
		null,
		",",
		"(",
		null,
		null,
		null,
	];
	const arr = new Uint8Array(256);
	arr.fill(HOLLERITH_UNDEFINED);
	for (let i = 0; i < 64; i++) {
		if (bcd[i]) {
			arr[bcd[i]!.charCodeAt(0)] = i;
		}
	}
	return arr;
})();

/** True if `c` has an entry in the 6-bit Hollerith table (i.e. the original
 * 7094 hardware could represent it). Non-representable characters still get
 * hashed (see lastChunkAsBcd) but using their raw low 6 bits instead. */
function hollerithDefined(c: string): boolean {
	const code = c.charCodeAt(0);
	return code < 256 && HOLLERITH_ENCODING[code] !== HOLLERITH_UNDEFINED;
}

/** Uppercases the input AND normalises punctuation the way the original
 * ELIZA's input routine did: curly quotes/backticks become straight quotes
 * or spaces, "!" and "?" both collapse to ".", ":" and ";" and em/en-dashes
 * become ",". This keeps punctuation-based sentence splitting (splitUserInput)
 * predictable regardless of how the user typed their punctuation. */
function elizaUppercase(utf8String: string): string {
	let result = "";
	for (const ch of utf8String) {
		const cp = ch.codePointAt(0)!;
		switch (cp) {
			case 0x2019:
				result += "'";
				break;
			case 0x2018:
			case 0x0060:
			case 0x0022:
			case 0x00ab:
			case 0x00bb:
			case 0x201a:
			case 0x201b:
			case 0x201c:
			case 0x201d:
			case 0x201e:
			case 0x201f:
			case 0x2039:
			case 0x203a:
				result += " ";
				break;
			case 0x0021:
			case 0x003f:
				result += ".";
				break;
			case 0x00a1:
			case 0x00bf:
				result += " ";
				break;
			case 0x003a:
			case 0x003b:
			case 0x2013:
			case 0x2014:
				result += ",";
				break;
			default:
				result += ch.toUpperCase();
				break;
		}
	}
	return result;
}

/** Splits a sentence into words AND punctuation tokens, where each character
 * in `punctuation` (usually "," and ".") becomes its own token in the output.
 * This is what lets ELIZA later find sentence boundaries ("BUT", ",", ".")
 * while scanning for keywords, so a compound sentence like "I like dogs but
 * I hate rain" can be cut down to just the clause containing a keyword. */
function splitUserInput(s: string, punctuation: string): StringList {
	const result: StringList = [];
	let word = "";
	for (const ch of s) {
		if (ch === " " || punctuation.includes(ch)) {
			if (word) {
				result.push(word);
				word = "";
			}
			if (ch !== " ") {
				result.push(ch);
			}
		} else {
			word += ch;
		}
	}
	if (word) {
		result.push(word);
	}
	return result;
}

// ---- HASH ----
// Together, lastChunkAsBcd() + hash() reproduce the original ELIZA's memory
// index calculation exactly. The idea: take the last word of the user's
// sentence, encode its final 6 characters as 6-bit BCD digits (padding with
// spaces if shorter), square that number, and take a middle slice of bits as
// the index. This is a deterministic but effectively "random-looking" way to
// pick 1 of the 4 MEMORY-rule templates - the original authors didn't have a
// real random number generator handy, so squaring-and-extracting-middle-bits
// was a classic simple pseudo-randomness trick of the era.
function lastChunkAsBcd(s: string): number {
	let result = 0;
	const append = (c: string) => {
		result <<= 6;
		if (hollerithDefined(c)) {
			result |= HOLLERITH_ENCODING[c.charCodeAt(0)];
		} else {
			result |= c.charCodeAt(0) & 0x3f;
		}
	};
	let count = 0;
	if (s.length > 0) {
		const start = Math.floor((s.length - 1) / 6) * 6;
		for (let i = start; i < s.length; i++, count++) {
			append(s[i]);
		}
	}
	while (count++ < 6) {
		append(" ");
	}
	return result >>> 0;
}

function hash(d: number, n: number): number {
	d &= 0x7ffffffff; // 35 bits
	d = Math.imul(d, d); // square
	const shift = 35 - Math.floor(n / 2);
	// For 64-bit precision we need BigInt for safety; the C++ code uses uint64_t
	// But JS numbers lose precision beyond 53 bits. For n<=15 this should be fine
	// because the result only uses the middle n bits, which for small n don't need full 64-bit
	// Actually d*d can be up to 70 bits, so we must use BigInt
	const dBig = BigInt(d);
	const squared = dBig * dBig;
	const shifted = squared >> BigInt(shift);
	const mask = (BigInt(1) << BigInt(n)) - BigInt(1);
	return Number(shifted & mask);
}

// ---- Tags ----
// A "DLIST" tag groups several keywords under one label so a single pattern
// slot can match any of them, e.g. pattern (/FAMILY) matches "MOTHER",
// "FATHER", "BROTHER", etc. if the script defines those three keywords with
// a shared /FAMILY tag. collectTags() (further below) builds this table once
// per loaded script by scanning every keyword's declared tags.
type TagMap = Map<string, StringList>;

const TAG_SIX_CHAR = "USE_SIX_CHAR_MATCHING_BEHAVIOR";

/** Checks whether `word` belongs to the inline word list or DLIST tag
 * referenced by a pattern token that looks like "(* LIST OF WORDS)" or
 * "(/TAGNAME1 TAGNAME2)". Used inside match()/xmatch() whenever a
 * decomposition pattern slot is parenthesised instead of a literal word. */
function inlist(word: string, wordlist: string, tags: TagMap): boolean {
	let wl = wordlist;
	if (wl.endsWith(")")) {
		wl = wl.slice(0, -1);
	}
	let cp = wl.startsWith("(") ? wl.slice(1) : wl;
	cp = cp.trimStart();

	const sixCharBehavior = () => {
		const t = tags.get(TAG_SIX_CHAR);
		return t !== undefined && t[0] === TAG_SIX_CHAR;
	};

	if (cp.startsWith("*")) {
		cp = cp.slice(1).trim();
		const items = split(cp);
		if (sixCharBehavior()) {
			const word6 = word.slice(0, 6);
			for (const w of items) {
				for (let i = 0; i < w.length; i += 6) {
					if (w.slice(i, i + 6) === word6) {
						return true;
					}
				}
			}
			return false;
		}
		return items.includes(word);
	}
	if (cp.startsWith("/")) {
		cp = cp.slice(1).trim();
		const tagNames = split(cp);
		for (const tag of tagNames) {
			const t = tags.get(tag);
			if (t?.includes(word)) {
				return true;
			}
		}
	}
	return false;
}

// ---- Match ----
/**
 * The heart of ELIZA: tries to match a "decomposition pattern" against the
 * user's word list, and if successful, returns the list of captured word
 * groups (matches[i] holds whatever words matched pattern slot i).
 *
 * A decomposition pattern is a list of tokens, each one of:
 *   - "0"        a wildcard matching ANY number of words (incl. zero)
 *   - a number N a fixed-width capture of exactly N consecutive words
 *   - "(...)"    a parenthesised word-list or DLIST reference (see inlist)
 *   - anything else: a literal word that must match exactly
 *
 * Example: pattern [0, "YOU", "ARE", 1] against "I THINK YOU ARE SAD"
 * matches with slot 0 = "I THINK" (the wildcard) and slot 3 = "SAD" (the
 * single-word capture after ARE).
 *
 * Because a "0" wildcard can absorb a variable number of words, matching
 * isn't a simple linear scan - xmatch() below tries every possible wildcard
 * length (starting from the shortest) until the remaining fixed-width
 * tokens line up with what follows in the sentence. This is classic
 * backtracking pattern matching, conceptually the ancestor of what modern
 * regular expression engines do with "*" and capture groups.
 */
function match(tags: TagMap, pattern: StringList, words: StringList): StringList | null {
	const patArray = [...pattern];
	const wordArray = [...words];
	const matches = new Array<string>(patArray.length);

	/**
	 * Tries to match one "segment" of the pattern - the tokens from pBegin to
	 * pEnd, which contains at most one wildcard at its very start - against
	 * the sentence starting at word index wBegin. `fixedLen` is the number of
	 * words the segment's non-wildcard tokens are guaranteed to consume.
	 * Returns the sentence index just past the match, or null on failure.
	 */
	function xmatch(pBegin: number, pEnd: number, wBegin: number, fixedLen: number): { wEnd: number } | null {
		if (wordArray.length - wBegin < fixedLen) {
			return null;
		}

		const hasWildcard = pBegin < patArray.length && toInt(patArray[pBegin]) === 0;
		let wildcardLen: number;
		let wildcardEnd: number;

		if (hasWildcard) {
			if (pEnd === patArray.length) {
				wildcardLen = wordArray.length - wBegin - fixedLen;
				wildcardEnd = wildcardLen;
			} else {
				wildcardLen = 0;
				wildcardEnd = wordArray.length - wBegin - fixedLen;
			}
		} else {
			wildcardLen = 0;
			wildcardEnd = 0;
		}

		for (; wildcardLen <= wildcardEnd; wildcardLen++) {
			let p = pBegin + (hasWildcard ? 1 : 0);
			let w = wBegin + wildcardLen;
			let ok = true;
			for (; p < pEnd; p++) {
				const n = toInt(patArray[p]);
				if (n > 0) {
					if (w + n > wordArray.length) {
						ok = false;
						break;
					}
					const part: StringList = [];
					for (let i = 0; i < n; i++) {
						part.push(wordArray[w++]);
					}
					matches[p] = join(part);
				} else {
					if (w >= wordArray.length) {
						ok = false;
						break;
					}
					if (patArray[p].startsWith("(")) {
						if (inlist(wordArray[w], patArray[p], tags)) {
							matches[p] = wordArray[w++];
						} else {
							ok = false;
							break;
						}
					} else if (patArray[p] === wordArray[w]) {
						matches[p] = wordArray[w++];
					} else {
						ok = false;
						break;
					}
				}
			}
			if (ok) {
				if (hasWildcard) {
					const part: StringList = [];
					for (let i = 0; i < wildcardLen; i++) {
						part.push(wordArray[wBegin + i]);
					}
					matches[pBegin] = join(part);
				}
				return { wEnd: w };
			}
			if (wildcardLen === wildcardEnd) {
				break;
			}
		}
		return null;
	}

	// Walk the pattern in segments, each segment being either "just a
	// wildcard" or "a run of fixed-width/literal tokens with an optional
	// leading wildcard". For every segment we call xmatch() to consume the
	// corresponding words from the sentence; if any segment fails to match,
	// the whole pattern fails (no backtracking across segment boundaries -
	// that mirrors the original algorithm's behaviour exactly).
	let w = 0;
	let pSegEnd = 0;
	while (pSegEnd < patArray.length) {
		let fixedLen = 0;
		const p = pSegEnd;
		for (; pSegEnd < patArray.length; pSegEnd++) {
			const n = toInt(patArray[pSegEnd]);
			if (n === 0) {
				if (pSegEnd > p) {
					break;
				}
			} else if (n > 0) {
				fixedLen += n;
			} else {
				fixedLen++;
			}
		}
		const result = xmatch(p, pSegEnd, w, fixedLen);
		if (!result) {
			return null;
		}
		w = result.wEnd;
	}
	if (w < wordArray.length) {
		return null;
	}

	// Build result from matches
	const result: StringList = [];
	for (const m of matches) {
		result.push(m);
	}
	return result;
}

// ---- Reassemble ----
/**
 * Builds the final response by walking a reassembly template and expanding
 * numeric references back into the words that match() captured.
 * `reassemblyRule` looks like ["WHY", "DO", "YOU", "THINK", 2] - literal
 * words are copied as-is, and a positive integer N is replaced by the words
 * captured in decomposition slot N (1-indexed to match the original
 * Fortran-flavoured convention). "0" or an out-of-range N becomes the
 * literal word "HMMM", ELIZA's way of admitting the reference didn't
 * resolve to anything.
 */
function reassemble(reassemblyRule: StringList, components: StringList): StringList {
	const result: StringList = [];
	for (const r of reassemblyRule) {
		const n = toInt(r);
		if (n < 0) {
			result.push(r);
		} else if (n === 0 || n > components.length) {
			result.push("HMMM");
		} else {
			const expanded = split(components[n - 1]);
			result.push(...expanded);
		}
	}
	return result;
}

// ---- Script tokenizer and reader ----
// A minimal S-expression tokenizer for reading .ela script files, which look
// like: (HELLO ((0) (HOW DO YOU DO. PLEASE STATE YOUR PROBLEM))) - i.e. Lisp-
// style nested parentheses with symbols and numbers as the only atoms.
namespace TokenType {
	export const EOF = "eof";
	export const SYMBOL = "symbol";
	export const NUMBER = "number";
	export const OPEN = "open";
	export const CLOSE = "close";
}
interface Token {
	type: string;
	value: string;
}

class Tokenizer {
	private pos = 0;
	private lineNumber = 1;
	private peeked: Token | null = null;
	private src: string;

	constructor(source: string) {
		this.src = source;
	}

	peektok(): Token {
		if (!this.peeked) {
			this.peeked = this.readtok();
		}
		return this.peeked;
	}

	nexttok(): Token {
		if (this.peeked) {
			const t = this.peeked;
			this.peeked = null;
			return t;
		}
		return this.readtok();
	}

	line(): number {
		return this.lineNumber;
	}

	private isWhitespace(ch: string): boolean {
		return ch <= " " || ch === "\x7f";
	}

	private isNewline(ch: string): boolean {
		return ch === "\x0a" || ch === "\x0b" || ch === "\x0c" || ch === "\x0d";
	}

	private readtok(): Token {
		while (this.pos < this.src.length) {
			let ch = this.src[this.pos];
			while (this.pos < this.src.length && this.isWhitespace(ch)) {
				if (this.isNewline(ch)) {
					this.lineNumber++;
					if (ch === "\x0d" && this.pos + 1 < this.src.length && this.src[this.pos + 1] === "\x0a") {
						this.pos++;
					}
				}
				this.pos++;
				ch = this.pos < this.src.length ? this.src[this.pos] : "";
			}
			if (this.pos >= this.src.length) {
				return { type: TokenType.EOF, value: "" };
			}
			ch = this.src[this.pos];
			if (ch === ";") {
				while (this.pos < this.src.length && !this.isNewline(this.src[this.pos])) {
					this.pos++;
				}
				continue;
			}
			break;
		}
		if (this.pos >= this.src.length) {
			return { type: TokenType.EOF, value: "" };
		}
		const ch = this.src[this.pos];
		if (ch === "(") {
			this.pos++;
			return { type: TokenType.OPEN, value: "(" };
		}
		if (ch === ")") {
			this.pos++;
			return { type: TokenType.CLOSE, value: ")" };
		}
		if (ch === "=") {
			this.pos++;
			return { type: TokenType.SYMBOL, value: "=" };
		}

		if (ch >= "0" && ch <= "9") {
			let value = "";
			while (this.pos < this.src.length && this.src[this.pos] >= "0" && this.src[this.pos] <= "9") {
				value += this.src[this.pos++];
			}
			return { type: TokenType.NUMBER, value };
		}

		// symbol
		let value = "";
		while (this.pos < this.src.length) {
			const c = this.src[this.pos];
			if (c === "(" || c === ")" || c === ";" || c === "=" || this.isWhitespace(c)) {
				break;
			}
			value += c;
			this.pos++;
		}
		return { type: TokenType.SYMBOL, value: elizaUppercase(value) };
	}
}

// ---- Rule classes ----
/** One (decomposition -> reassembly-options) pair belonging to a keyword.
 * `nextReassemblyRule` is the round-robin cursor into reassemblyRules: each
 * time this transform fires, ELIZA uses the next template in the list and
 * wraps back around, so repeatedly triggering the same keyword doesn't
 * always produce an identical reply. */
interface ITransform {
	decomposition: StringList;
	reassemblyRules: StringList[];
	nextReassemblyRule: number;
}

/** The outcome of trying to apply a keyword's rule to the current sentence. */
enum Action {
	/** No decomposition matched and there's no link keyword to fall back to. */
	Inapplicable = 0,
	/** A decomposition matched and reassembly produced a final response. */
	Complete = 1,
	/** The rule said "give up on me, try the next keyword on the stack" (NEWKEY). */
	Newkey = 2,
	/** The rule redirected processing to a different keyword (=KEYWORD or PRE). */
	Linkkey = 3,
}

/** Shared behaviour for both kinds of rules in the script: ordinary keyword
 * rules (RuleKeyword) and the special MEMORY rule (RuleMemory). */
abstract class RuleBase {
	keyword: string;
	wordSubstitution: string;
	precedence: number;

	constructor(keyword: string, substitute: string, prec: number) {
		this.keyword = keyword;
		this.wordSubstitution = substitute;
		this.precedence = prec;
	}

	/** If this keyword declares a word substitution (e.g. "I = YOU" so the
	 * user's own pronoun gets flipped for mirroring), returns the
	 * replacement when `word` matches, otherwise null. Applied while
	 * scanning the sentence, *before* any pattern matching happens. */
	applyWordSubstitution(word: string): string | null {
		if (!this.wordSubstitution || word !== this.keyword) {
			return null;
		}
		return this.wordSubstitution;
	}

	abstract hasTransformation(): boolean;
	abstract applyTransformation(words: StringList, tags: TagMap, linkKeyword: { value: string }): Action;
}

/** An ordinary script keyword (e.g. "MOTHER", "SORRY", "I") together with
 * every decomposition/reassembly transform declared for it, plus an
 * optional single "link keyword" to redirect to when no decomposition
 * matches at all (this is the keyword-level `=KEYWORD` shorthand, distinct
 * from the per-reassembly-rule `=KEYWORD` handled in applyTransformation). */
class RuleKeyword extends RuleBase {
	private tags: StringList = [];
	private linkKeyword = "";
	private transforms: ITransform[] = [];

	constructor(keyword: string, substitute: string, prec: number, tags: StringList, linkKw: string) {
		super(keyword, substitute, prec);
		this.tags = tags;
		this.linkKeyword = linkKw;
	}

	get dlistTags(): StringList {
		return this.tags;
	}

	hasTransformation(): boolean {
		return this.transforms.length > 0 || Boolean(this.linkKeyword);
	}

	addTransform(decomp: StringList, reassembly: StringList[]) {
		this.transforms.push({
			decomposition: decomp,
			reassemblyRules: reassembly,
			nextReassemblyRule: 0,
		});
	}

	/**
	 * Tries each decomposition pattern for this keyword in declaration order
	 * (first match wins), then interprets the next reassembly template in
	 * the round-robin cycle. Three special reassembly forms change the
	 * normal "just fill in the template" behaviour - see the inline checks
	 * below for NEWKEY, the bare `=KEYWORD` shorthand, and the `(PRE ...)`
	 * pronoun-rewriting form.
	 */
	applyTransformation(words: StringList, tags: TagMap, linkKw: { value: string }): Action {
		let constituents: StringList | null = null;
		let rule: ITransform | undefined;
		for (const t of this.transforms) {
			const result = match(tags, t.decomposition, words);
			if (result !== null) {
				constituents = result;
				rule = t;
				break;
			}
		}
		if (!rule) {
			if (this.linkKeyword) {
				linkKw.value = this.linkKeyword;
				return Action.Linkkey;
			}
			return Action.Inapplicable;
		}

		const reassemblyRule = rule.reassemblyRules[rule.nextReassemblyRule];
		rule.nextReassemblyRule = (rule.nextReassemblyRule + 1) % rule.reassemblyRules.length;

		// NEWKEY: this reassembly rule is just the literal word "NEWKEY",
		// telling ELIZA to abandon this keyword and try the next one on the
		// keystack instead - used when a decomposition matched syntactically
		// but the script author decided this keyword still isn't the right
		// one to respond with (e.g. a weak/generic pattern that should defer
		// to something more specific if anything else is available).
		if (reassemblyRule.length === 1 && reassemblyRule[0] === "NEWKEY") {
			return Action.Newkey;
		}

		// Bare "=KEYWORD" reassembly: redirect straight to another keyword's
		// rules without transforming the sentence at all.
		if (reassemblyRule.length === 2 && reassemblyRule[0].startsWith("=")) {
			linkKw.value = reassemblyRule[1];
			return Action.Linkkey;
		}

		// "(PRE (rephrase-template) (=KEYWORD))": rewrite the sentence using
		// `rephrase-template` (typically to swap I/YOU, MY/YOUR, etc. so
		// "YOU'RE happy" becomes "I AM happy"-shaped text) and then jump to
		// KEYWORD's rules to process the *rewritten* sentence. This is how
		// ELIZA achieves believable pronoun-swapped mirroring instead of
		// just echoing the user's exact words back.
		if (reassemblyRule.length > 0 && reassemblyRule[0] === "(") {
			// format: ["(", "PRE", "(", ...reassembly..., ")", "(", "=", keyword, ")", ")"]
			// index:    0      1      2       3...         n-4    n-3  n-2   n-1     n
			const preEnd = reassemblyRule.indexOf(")", 2);
			const reassem = reassemblyRule.slice(3, preEnd);
			const _refStart = reassemblyRule.indexOf("(", preEnd + 1);
			linkKw.value = reassemblyRule[reassemblyRule.length - 2];
			words.length = 0;
			words.push(...reassemble(reassem, constituents!));
			return Action.Linkkey;
		}

		const result = reassemble(reassemblyRule, constituents!);
		words.length = 0;
		words.push(...result);
		return Action.Complete;
	}
}

/**
 * ELIZA's one and only piece of persistent state. Whenever the user's
 * sentence contains the MEMORY rule's trigger keyword (classically "MY",
 * as in the famous "MY MOTHER" -> later recalled as "EARLIER YOU SAID YOUR
 * MOTHER..."), createMemory() stashes an alternate phrasing of that remark
 * away. If a *later* input produces no keyword matches at all, Eliza.response()
 * pulls one of these stashed memories out and uses it as the reply instead
 * of a generic "PLEASE CONTINUE" - giving a (very limited) illusion that
 * ELIZA "remembered" something you said earlier in the conversation.
 */
class RuleMemory extends RuleBase {
	static readonly NUM_TRANSFORMS = 4;
	private memories: StringList = [];
	private transforms: ITransform[] = [];

	constructor(keyword: string) {
		super(keyword, "", 0);
	}

	isEmpty(): boolean {
		return !this.keyword || this.transforms.length === 0;
	}

	addTransform(decomp: StringList, reassembly: StringList[]) {
		this.transforms.push({
			decomposition: decomp,
			reassemblyRules: reassembly,
			nextReassemblyRule: 0,
		});
	}

	hasTransformation(): boolean {
		return false;
	}

	applyTransformation(_words: StringList, _tags: TagMap, _linkKw: { value: string }): Action {
		return Action.Inapplicable;
	}

	/**
	 * Called for every keyword ELIZA encounters while scanning a sentence
	 * (see Eliza.response()) - if `keyword` happens to be the MEMORY rule's
	 * trigger word, picks one of its 4 canned decomposition/reassembly
	 * templates using the HASH-based pseudo-random index (see hash() /
	 * lastChunkAsBcd() above) and stores the resulting phrase for possible
	 * recall later. A no-op for every other keyword.
	 */
	createMemory(keyword: string, words: StringList, tags: TagMap) {
		if (keyword !== this.keyword || words.length === 0) {
			return;
		}
		if (this.transforms.length !== RuleMemory.NUM_TRANSFORMS) {
			return;
		}

		const idx = hash(lastChunkAsBcd(words[words.length - 1]), 2);
		const trans = this.transforms[idx];
		if (!trans) {
			return;
		}

		const constituents = match(tags, trans.decomposition, words);
		if (!constituents) {
			return;
		}

		const newMem = join(reassemble(trans.reassemblyRules[0], constituents));
		this.memories.push(newMem);
	}

	memoryExists(): boolean {
		return this.memories.length > 0;
	}

	/** Pops and returns the oldest stashed memory (FIFO), so memories get
	 * recalled in the order they were originally said. */
	recallMemory(): string {
		return this.memories.shift() || "";
	}
}

// ---- Eliza class ----
const NOMATCH_MSGS = ["PLEASE CONTINUE", "HMMM", "GO ON , PLEASE", "I SEE"];
const SPECIAL_NONE = "zNONE";

/** Builds the DLIST tag table (see TagMap) once per script by scanning every
 * keyword's declared tags and inverting them into tag -> [keywords] lookups,
 * so match()/inlist() can answer "does this word belong to tag X?" in O(1). */
function collectTags(rules: Map<string, RuleBase>): TagMap {
	const tags: TagMap = new Map();
	for (const rule of rules.values()) {
		if (rule instanceof RuleKeyword) {
			for (let t of rule.dlistTags) {
				if (t === "/") {
					continue;
				}
				if (t.startsWith("/")) {
					t = t.slice(1);
				}
				if (!tags.has(t)) {
					tags.set(t, []);
				}
				tags.get(t)!.push(rule.keyword);
			}
		}
	}
	return tags;
}

/** Holds one loaded script (rules + memory rule + tag table) and drives the
 * turn-by-turn conversation logic. Deliberately has almost no state of its
 * own beyond `limit` (a 1-4 cycling counter used to pick which generic
 * NOMATCH_MSGS stalling reply to show) - see class doc on RuleMemory for
 * ELIZA's only real memory. */
class Eliza {
	private rules: Map<string, RuleBase>;
	private memRule: RuleMemory;
	private tags: TagMap;
	private limit = 1;
	private delimiters: StringList = [",", ".", "BUT"];
	private punctuation = ",.";
	private useNomatchMsgs = true;
	private onNewkeyFailUseNone = true;

	constructor(rules: Map<string, RuleBase>, memRule: RuleMemory) {
		this.rules = rules;
		this.memRule = memRule;
		this.tags = collectTags(rules);
	}

	setOnNewkeyFailUseNone(v: boolean) {
		this.onNewkeyFailUseNone = v;
	}

	/**
	 * Produces ELIZA's reply to one line of user input. This is the full
	 * pipeline described in the file's top-of-file overview comment,
	 * condensed:
	 *
	 *   normalise+tokenise -> scan for keywords (building a priority-ordered
	 *   keystack while also applying pronoun substitutions in place) -> pop
	 *   keywords off the stack one at a time, trying each one's decomposition
	 *   patterns until one matches and produces Action.Complete -> handle
	 *   Action.Newkey (try next keyword) / Action.Linkkey (jump to a
	 *   different keyword, e.g. from a PRE rule) as they occur -> if the
	 *   whole stack is exhausted with nothing found, fall back to the NONE
	 *   rule or a generic stalling message.
	 */
	response(input: string): string {
		const words = splitUserInput(elizaUppercase(input), this.punctuation);

		this.limit = (this.limit % 4) + 1;

		// --- Pass 1: scan every word of the (first clause of the) sentence.
		// Any word that's a keyword with at least one usable transform gets
		// pushed onto keystack, with higher script-declared `precedence`
		// keywords inserted at the FRONT so they get tried first. Plain word
		// substitutions (I<->YOU etc.) are also applied here, in place,
		// before any pattern matching happens.
		const keystack: StringList = [];
		let topRank = 0;
		for (let i = 0; i < words.length; ) {
			const word = words[i];
			if (this.delimiter(word)) {
				// Hitting ",", "." or "BUT" before finding any keyword just
				// skips past that clause and keeps scanning the rest of the
				// sentence; hitting it AFTER finding a keyword truncates the
				// sentence there instead (only the clause containing the
				// keyword is kept for pattern matching).
				if (keystack.length === 0) {
					i++;
					words.splice(0, i);
					i = 0;
					continue;
				}
				words.splice(i);
				break;
			}
			const rule = this.rules.get(word);
			if (rule) {
				if (rule.hasTransformation()) {
					if (rule.precedence > topRank) {
						keystack.unshift(word);
						topRank = rule.precedence;
					} else {
						keystack.push(word);
					}
				}
				const sub = rule.applyWordSubstitution(word);
				if (sub) {
					words[i] = sub;
				}
			}
			i++;
		}

		// No keyword at all found in this sentence, and it's the 4th turn in
		// the stalling-message cycle: prefer recalling an old MEMORY over
		// yet another generic "PLEASE CONTINUE".
		if (keystack.length === 0 && this.limit === 4 && this.memRule.memoryExists()) {
			return this.memRule.recallMemory();
		}

		// --- Pass 2: work through the keystack, trying one keyword's rule at
		// a time until something produces Action.Complete.
		while (keystack.length > 0) {
			const topKeyword = keystack.shift()!;
			const rule = this.rules.get(topKeyword);
			if (!rule) {
				if (this.useNomatchMsgs) {
					return NOMATCH_MSGS[this.limit - 1];
				}
				break;
			}

			// Every keyword encountered gets a chance to feed the MEMORY
			// rule, regardless of whether it ultimately produces a reply.
			this.memRule.createMemory(topKeyword, words, this.tags);

			const linkKw = { value: "" };
			const act = rule.applyTransformation(words, this.tags, linkKw);

			if (act === Action.Complete) {
				return join(words);
			}
			if (act === Action.Inapplicable) {
				if (this.useNomatchMsgs) {
					return NOMATCH_MSGS[this.limit - 1];
				}
				break;
			}

			if (act === Action.Linkkey) {
				// Redirected to another keyword (from =KEYWORD or a PRE
				// rule) - push it to the FRONT of the stack so it's tried
				// next, ahead of whatever else was already queued.
				keystack.unshift(linkKw.value);
			} else if (keystack.length === 0) {
				// Action.Newkey but nothing left to try.
				if (!this.onNewkeyFailUseNone && this.useNomatchMsgs) {
					return NOMATCH_MSGS[this.limit - 1];
				}
				break;
			}
		}

		// Nothing on the keystack (or no keystack at all) produced a reply:
		// fall back to the script's special NONE rule if it defines one,
		// otherwise cycle through the generic stalling messages.
		const noneRule = this.rules.get(SPECIAL_NONE) as RuleKeyword;
		if (noneRule) {
			const linkKw = { value: "" };
			noneRule.applyTransformation(words, this.tags, linkKw);
			return join(words);
		}
		return NOMATCH_MSGS[this.limit - 1];
	}

	private delimiter(s: string): boolean {
		return this.delimiters.includes(s);
	}
}

// ---- Script reader ----
interface ScriptData {
	helloMessage: StringList;
	rules: Map<string, RuleBase>;
	memRule: RuleMemory;
}

/**
 * Parses a full .ela script file (S-expression format) into a ScriptData:
 * the greeting line, a map of keyword -> RuleKeyword, and the one special
 * MEMORY rule if the script declares one. This is a straightforward
 * recursive-descent parser over the Tokenizer's token stream - each
 * top-level `(KEYWORD ...)` form becomes one readKeywordRule() call, with
 * `(MEMORY ...)` and `(HELLO ...)` as the two recognised special forms.
 */
function readElizaScript(source: string): ScriptData {
	const tok = new Tokenizer(source);
	const script: ScriptData = {
		helloMessage: [],
		rules: new Map(),
		memRule: new RuleMemory(""),
	};

	const errmsg = (msg: string) => {
		throw new Error(`Script error on line ${tok.line()}: ${msg}`);
	};

	const rdlist = (prior = true): StringList => {
		const s: StringList = [];
		let t = tok.nexttok();
		if (prior) {
			if (t.type !== TokenType.OPEN) {
				errmsg("expected '('");
			}
			t = tok.nexttok();
		}
		while (t.type !== TokenType.CLOSE) {
			if (t.type === TokenType.SYMBOL || t.type === TokenType.NUMBER) {
				s.push(t.value);
			} else if (t.type === TokenType.OPEN) {
				let sub = "";
				t = tok.nexttok();
				while (t.type !== TokenType.CLOSE) {
					if (t.type !== TokenType.SYMBOL && t.type !== TokenType.NUMBER) {
						errmsg("expected symbol or number in sublist");
					}
					if (sub) {
						sub += " ";
					}
					sub += t.value;
					t = tok.nexttok();
				}
				s.push(`(${sub})`);
			} else {
				errmsg("expected ')'");
			}
			t = tok.nexttok();
		}
		return s;
	};

	const readReassembly = (): StringList => {
		const t = tok.nexttok();
		if (t.type !== TokenType.OPEN) {
			errmsg("expected '(' for reassembly");
		}
		if (tok.peektok().value !== "PRE") {
			return rdlist(false);
		}
		tok.nexttok(); // skip PRE
		const pre: StringList = ["(", "PRE", "("];
		const recon = rdlist();
		const ref = rdlist();
		if (ref.length !== 2 || ref[0] !== "=") {
			errmsg("expected '(=reference)' in PRE rule");
		}
		pre.push(...recon);
		pre.push(")", "(");
		pre.push(...ref);
		pre.push(")", ")");
		if (tok.nexttok().type !== TokenType.CLOSE) {
			errmsg("expected ')'");
		}
		return pre;
	};

	const readMemoryRule = () => {
		tok.nexttok(); // consume MEMORY token (already checked)
		if (script.memRule.keyword) {
			errmsg("MEMORY rule already specified");
		}
		const kw = tok.nexttok();
		if (kw.type !== TokenType.SYMBOL) {
			errmsg("expected keyword after MEMORY");
		}
		script.memRule = new RuleMemory(kw.value);

		for (let i = 0; i < RuleMemory.NUM_TRANSFORMS; i++) {
			if (tok.nexttok().type !== TokenType.OPEN) {
				errmsg("expected '(' for memory rule");
			}
			const decomp: StringList = [];
			let t2 = tok.nexttok();
			while (t2.value !== "=" && t2.type !== TokenType.EOF) {
				decomp.push(t2.value);
				t2 = tok.nexttok();
			}
			if (decomp.length === 0) {
				errmsg("expected decompose_terms = reassemble_terms");
			}
			if (t2.value !== "=") {
				errmsg("expected '='");
			}
			const reass: StringList = [];
			t2 = tok.nexttok();
			while (t2.type !== TokenType.CLOSE && t2.type !== TokenType.EOF) {
				reass.push(t2.value);
				t2 = tok.nexttok();
			}
			if (reass.length === 0) {
				errmsg("expected decompose_terms = reassemble_terms");
			}
			if (t2.type !== TokenType.CLOSE) {
				errmsg("expected ')'");
			}
			script.memRule.addTransform(decomp, [reass]);
		}
		if (tok.nexttok().type !== TokenType.CLOSE) {
			errmsg("expected ')' after memory rule");
		}
	};

	const readKeywordRule = () => {
		const t = tok.nexttok();
		// YAPYAP uses numeric labels like (100 $ ...) -- skip these extension rules
		if (t.type === TokenType.NUMBER) {
			let depth = 1;
			while (depth > 0) {
				const sk = tok.nexttok();
				if (sk.type === TokenType.EOF) {
					return;
				}
				if (sk.type === TokenType.OPEN) {
					depth++;
				}
				if (sk.type === TokenType.CLOSE) {
					depth--;
				}
			}
			return;
		}
		let keyword = t.value;
		let kwSub = "";
		let precedence = 0;
		let tags: StringList = [];
		const transforms: { decomp: StringList; reass: StringList[] }[] = [];
		let className = "";

		if (keyword === "NONE") {
			keyword = SPECIAL_NONE;
		}
		if (keyword.startsWith("DO(")) {
			// YAPYAP DO(UNSAVE...) extension -- skip this rule entirely
			let depth = 1;
			while (depth > 0) {
				const sk = tok.nexttok();
				if (sk.type === TokenType.EOF) {
					return;
				}
				if (sk.type === TokenType.OPEN) {
					depth++;
				}
				if (sk.type === TokenType.CLOSE) {
					depth--;
				}
			}
			return;
		}
		if (script.rules.has(keyword)) {
			errmsg(`keyword rule already specified for '${keyword}'`);
		}

		if (tok.peektok().type === TokenType.CLOSE) {
			errmsg(`keyword '${keyword}' has no associated body`);
		}

		for (let t2 = tok.nexttok(); t2.type !== TokenType.CLOSE; t2 = tok.nexttok()) {
			if (t2.value === "=") {
				t2 = tok.nexttok();
				if (t2.type !== TokenType.SYMBOL) {
					errmsg("expected keyword after =");
				}
				kwSub = t2.value;
			} else if (t2.type === TokenType.NUMBER) {
				precedence = Number.parseInt(t2.value, 10);
			} else if (t2.value === "DLIST") {
				tags = rdlist();
			} else if (t2.value === "DO") {
				// YAPYAP extension: DO(/YACK) etc -- consume but ignore
				rdlist();
			} else if (t2.type === TokenType.OPEN) {
				if (tok.peektok().value === "=") {
					tok.nexttok(); // =
					t2 = tok.nexttok();
					if (t2.type !== TokenType.SYMBOL) {
						errmsg("expected equivalence class name");
					}
					className = t2.value;
					tok.nexttok(); // ) close reference, leave keyword ) for loop condition
				} else {
					const decomp = rdlist();
					// empty decompose pattern () is allowed -- matches empty input
					const reass: StringList[] = [];
					do {
						reass.push(readReassembly());
					} while (tok.peektok().type === TokenType.OPEN);
					if (tok.nexttok().type !== TokenType.CLOSE) {
						errmsg("expected ')'");
					}
					transforms.push({ decomp, reass });
				}
			} else {
				// YAPYAP / other extensions ($, GOTO, REPLY, etc) -- skip by consuming rest of rule
				let depth = 1;
				while (depth > 0) {
					const sk = tok.nexttok();
					if (sk.type === TokenType.EOF) {
						break;
					}
					if (sk.type === TokenType.OPEN) {
						depth++;
					}
					if (sk.type === TokenType.CLOSE) {
						depth--;
					}
				}
				break;
			}
		}

		// Only register rule if it has transforms (skip YAPYAP extension stubs)
		if (transforms.length > 0 || className) {
			const rule = new RuleKeyword(keyword, kwSub, precedence, tags, className);
			for (const tr of transforms) {
				rule.addTransform(tr.decomp, tr.reass);
			}
			script.rules.set(keyword, rule);
		}
	};

	const readRule = (): boolean => {
		const t = tok.nexttok();
		if (t.type === TokenType.EOF) {
			return false;
		}
		if (t.type !== TokenType.OPEN) {
			errmsg("expected '('");
		}
		if (tok.peektok().type === TokenType.CLOSE) {
			tok.nexttok();
			return true;
		}
		if (tok.peektok().value === "MEMORY") {
			readMemoryRule();
		} else {
			readKeywordRule();
		}
		return true;
	};

	script.helloMessage = rdlist();

	if (tok.peektok().value === "START") {
		tok.nexttok();
	}

	while (readRule()) {
		/* empty */
	}

	// If the script being loaded doesn't define its own NONE rule or MEMORY
	// rule, fall back to Weizenbaum's originals so every script - even a
	// minimal custom one - still has working stalling replies and memory
	// recall.
	if (!script.rules.has(SPECIAL_NONE)) {
		const noneRule = new RuleKeyword(SPECIAL_NONE, "", 0, [], "");
		noneRule.addTransform(
			["0"],
			[
				["PLEASE", "GO", "ON"],
				["I", "AM", "NOT", "SURE", "I", "UNDERSTAND", "YOU", "FULLY"],
				["WHAT", "DOES", "THAT", "SUGGEST", "TO", "YOU"],
				["PLEASE", "CONTINUE"],
			]
		);
		script.rules.set(SPECIAL_NONE, noneRule);
	}
	if (!script.memRule.keyword) {
		const memRule = new RuleMemory("MY");
		const memDecomp = ["0", "YOUR", "0"];
		memRule.addTransform(memDecomp, [["LETS", "DISCUSS", "FURTHER", "WHY", "YOUR", "3"]]);
		memRule.addTransform(memDecomp, [["EARLIER", "YOU", "SAID", "YOUR", "3"]]);
		memRule.addTransform(memDecomp, [["BUT", "YOUR", "3"]]);
		memRule.addTransform(memDecomp, [["DOES", "THAT", "HAVE", "ANYTHING", "TO", "DO", "WITH", "THE", "FACT", "THAT", "YOUR", "3"]]);
		script.memRule = memRule;
	}

	return script;
}

// ---- Public API ----
export { Action, Eliza, readElizaScript, RuleKeyword, RuleMemory, SPECIAL_NONE, type StringList, type TagMap };
