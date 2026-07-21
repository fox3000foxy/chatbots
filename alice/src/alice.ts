/**
 * ============================================================================
 * ALICE -- TypeScript port
 * ============================================================================
 *
 * Faithful reimplementation of Dr. Richard Wallace's ALICE (Artificial
 * Linguistic Internet Computer Entity, 1995), driven entirely by AIML
 * (Artificial Intelligence Markup Language) - an XML dialect where each
 * <category> is one (input pattern -> output template) rule. Unlike ELIZA's
 * hand-rolled decomposition/reassembly syntax, ALICE's patterns and
 * templates are just XML, which is what let the AIML community grow such an
 * enormous shared category set (this port ships with 66 files / ~99,500
 * categories - see the README's ALICE section for the full architecture
 * diagram and tag reference table).
 *
 * HOW ALICE WORKS, END TO END:
 *
 *   1. loadAIML() reads every .aiml file in a directory, parses each
 *      <category>'s <pattern>/<template> (and optional <that>, for
 *      context-sensitive replies referencing ALICE's own last statement -
 *      not fully exploited by this port, but stored for completeness), and
 *      sorts the whole category list so MORE SPECIFIC patterns (fewer
 *      wildcards, and among equally-specific ones, longer patterns) are
 *      tried FIRST. This ordering matters enormously: without it, a broad
 *      pattern like "*" could shadow a specific one like "WHAT IS YOUR
 *      NAME" simply by appearing first in some file.
 *
 *   2. response() cleans (uppercases/normalises whitespace) the user's
 *      input and calls findMatch(), which tries every category's pattern
 *      (compiled to a regex - see patternToRegex) in that sorted order
 *      until one matches, capturing whatever "*" or "_" absorbed into
 *      `lastWildcard` for <star/> to use later.
 *
 *   3. The matched category's <template> is walked recursively by
 *      processTemplate(), which interprets each AIML tag it encounters -
 *      <star/> inserts the captured wildcard text, <random> picks one
 *      <li> child at random, <set>/<get> read and write simple named
 *      variables, <condition> branches on a stored variable's value, and
 *      <srai>/<sr> (Symbolic Reduction) recursively re-run the WHOLE
 *      matching process on a different, usually simpler, sentence - this
 *      is how AIML authors implement synonyms/rephrasing ("WHAT'S UP" can
 *      <srai> to "HELLO" and reuse that category's template) without
 *      duplicating templates. Recursion is capped at depth 10
 *      (processSrai) to guard against a pattern that <srai>s to itself.
 *
 * ALICE, like ELIZA, has no real understanding - all "knowledge" comes from
 * the size and cleverness of the loaded AIML category set, not from this
 * engine, which is a fairly small and generic AIML interpreter.
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DomJS } = require("dom-js");

/** One parsed AIML rule: a pattern to match against user input, the
 * template XML node to execute if it matches, and an optional <that>
 * pattern (ALICE's own previous statement) for context-sensitive replies. */
interface Category {
	pattern: string;
	template: string;
	that?: string;
}

export class Alice {
	private categories: Category[] = [];
	private ready = false;
	/** Whatever text the last successful pattern match's "*"/"_" wildcard
	 * captured - consumed by <star/> while processing that match's template. */
	private lastWildcard = "";
	/** Guards against infinite <srai> recursion (see processSrai). */
	private sraiDepth = 0;
	/** Backing store for AIML's <set name="X">/<get name="X"/> variables. */
	private storedVars = new Map<string, string>();

	/**
	 * Loads and parses every .aiml file in `aimlDir`, then sorts the
	 * resulting category list so the most specific patterns are tried
	 * first: fewer wildcards (`*`/`_`) wins, and among patterns with an
	 * equal wildcard count, the longer (more literal words to match) one
	 * wins. This directly implements AIML's documented "most specific
	 * pattern wins" matching rule (see README's Wildcard Matching section).
	 */
	loadAIML(aimlDir: string) {
		if (!existsSync(aimlDir)) {
			throw new Error(`AIML directory not found: ${aimlDir}`);
		}
		const files = readdirSync(aimlDir)
			.filter((f) => f.endsWith(".aiml"))
			.sort();

		for (const file of files) {
			this.parseFile(`${aimlDir}/${file}`);
		}
		// Sort: more specific patterns first (fewer wildcards)
		this.categories.sort((a, b) => {
			const awc = (a.pattern.match(/[*_]/g) || []).length;
			const bwc = (b.pattern.match(/[*_]/g) || []).length;
			if (awc !== bwc) return awc - bwc;
			return b.pattern.length - a.pattern.length;
		});
		this.ready = true;
	}

	/** Reads and XML-parses one .aiml file, then walks its DOM to extract
	 * every <category> into `this.categories` (see walkCategories). */
	private parseFile(path: string) {
		const xml = require("node:fs").readFileSync(path, "utf-8");
		const dom = new DomJS();
		dom.parse(xml, (_err: unknown, doc: any) => {
			this.walkCategories(doc.children || []);
		});
	}

	/** Recursively scans a parsed XML node tree for <category> elements
	 * (which may be nested inside a <topic> or other grouping tag) and
	 * records each one's pattern/template/that into `this.categories`. */
	private walkCategories(nodes: any[]) {
		for (const node of nodes) {
			if (node.name === "category") {
				const pattern = this.getTagText(node, "pattern");
				const that = this.getTagText(node, "that");
				const template = this.getTagContent(node, "template");
				if (pattern && template) {
					this.categories.push({
						pattern: this.clean(pattern),
						template,
						that: that ? this.clean(that) : undefined,
					});
				}
			}
			if (node.children) this.walkCategories(node.children);
		}
	}

	/** Finds a direct child tag by name and returns its flattened text
	 * content (used for <pattern> and <that>, which are plain text). */
	private getTagText(parent: any, tag: string): string | null {
		for (const child of parent.children || []) {
			if (child.name === tag) {
				return this.collectText(child);
			}
		}
		return null;
	}

	/** Same lookup as getTagText, but returns the raw XML node itself
	 * rather than flattened text - used for <template>, since its content
	 * needs to stay structured for processTemplate() to walk later. */
	private getTagContent(parent: any, tag: string): string | null {
		for (const child of parent.children || []) {
			if (child.name === tag) {
				return child;
			}
		}
		return null;
	}

	private nodeText(node: any): string {
		if (typeof node.text === "string") return node.text;
		if (typeof node.text === "function") return node.text() || "";
		return this.collectText(node);
	}

	/** Flattens an XML node's entire subtree down to its plain text content,
	 * discarding any tags along the way - used where AIML expects plain
	 * text rather than nested markup (e.g. reading a <pattern>). */
	private collectText(node: any): string {
		let text = "";
		for (const child of node.children || []) {
			text += this.nodeText(child);
			if (child.children) text += this.collectText(child);
		}
		return text;
	}

	/** AIML matching is whitespace- and case-insensitive by convention:
	 * collapse runs of whitespace to a single space, trim, and uppercase. */
	private clean(s: string): string {
		return s.replace(/\s+/g, " ").trim().toUpperCase();
	}

	/**
	 * Public entrypoint: cleans the input, finds the best-matching category
	 * (findMatch, using the specificity-sorted list from loadAIML), then
	 * executes its template (processTemplate) to produce the final reply.
	 */
	response(input: string): string {
		if (!this.ready) return "I am not initialized.";

		const cleaned = this.clean(input);
		const cat = this.findMatch(cleaned);
		if (!cat) return "I don't know.";

		this.sraiDepth = 0;
		const result = this.processTemplate(cat.template, cleaned);
		return result || "I don't know.";
	}

	/** Tries every category's pattern, in the specificity-sorted order set
	 * up by loadAIML(), returning the first one whose compiled regex
	 * (patternToRegex) matches the input. Because the list is pre-sorted,
	 * this "first match wins" linear scan is equivalent to AIML's official
	 * "most specific pattern wins" rule without needing a smarter matching
	 * data structure (like a real AIML engine's Graphmaster trie). */
	private findMatch(input: string): Category | null {
		for (const cat of this.categories) {
			const re = this.patternToRegex(cat.pattern);
			const m = input.match(re);
			if (m) {
				this.lastWildcard = m[1] || "";
				return cat;
			}
		}
		return null;
	}

	/** Compiles an AIML pattern (space-separated literal words and `*`/`_`
	 * wildcards) into a JS RegExp. Both wildcard characters are treated
	 * identically here (matching any sequence of words, non-greedy-safe via
	 * `.*`) even though AIML traditionally treats `_` as a "more important"
	 * wildcard for tie-breaking - this port's specificity sort (loadAIML)
	 * only counts wildcards, not their kind, which is a simplification
	 * noted in the README. */
	private patternToRegex(pattern: string): RegExp {
		const parts = pattern.split(/\s+/);
		const reParts = parts.map((p) => {
			if (p === "*" || p === "_") return "\\s*(.*)\\s*";
			return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		});
		return new RegExp(`^\\s*${reParts.join("\\s+")}\\s*$`, "i");
	}

	/**
	 * Walks one <template> (or any sub-node of it) and recursively builds
	 * the final response text, tag by tag. Each `else if` branch below
	 * implements one AIML tag from the README's Supported AIML Tags table:
	 * <star/> substitutes the captured wildcard, <sr>/<srai> perform
	 * Symbolic Reduction (re-running the whole match+template pipeline on
	 * different text - see processSrai), <random> picks one <li> at random,
	 * <think> runs its children for side effects only (typically <set>)
	 * without contributing to the visible output, <set>/<get> read and
	 * write `storedVars`, <bot> looks up a static bot-profile attribute,
	 * and <condition> branches based on a stored variable (processCondition).
	 * Anything else is either descended into (if it has children) or
	 * emitted as plain text.
	 */
	private processTemplate(tpl: any, input: string): string {
		let result = "";

		for (const child of tpl.children || []) {
			if (child.name === "star") {
				result += this.lastWildcard;
			} else if (child.name === "sr") {
				// <sr/> is documented shorthand for <srai><star/></srai>:
				// symbolically reduce using exactly the wildcard capture.
				this.sraiDepth++;
				const sraiResult = this.processSrai(this.lastWildcard);
				this.sraiDepth--;
				result += sraiResult;
			} else if (child.name === "srai") {
				this.sraiDepth++;
				const sraiText = this.getInnerText(child);
				const sraiResult = this.processSrai(sraiText);
				this.sraiDepth--;
				result += sraiResult;
			} else if (child.name === "random") {
				const lis = (child.children || []).filter((c: any) => c.name === "li");
				if (lis.length > 0) {
					const picked = lis[Math.floor(Math.random() * lis.length)];
					result += this.processTemplate(picked, input);
				}
			} else if (child.name === "li") {
				result += this.processTemplate(child, input);
			} else if (child.name === "think") {
				// Side effects only - process but discard output
				this.processThink(child);
			} else if (child.name === "set") {
				const name = child.attributes?.name || "";
				const value = this.processTemplate(child, input);
				if (name) this.storedVars.set(name, value);
				result += value;
			} else if (child.name === "get") {
				const name = child.attributes?.name || "";
				result += this.storedVars.get(name) || "";
			} else if (child.name === "bot") {
				const name = child.attributes?.name || "";
				result += this.botAttr(name);
			} else if (child.name === "condition") {
				result += this.processCondition(child, input);
			} else if (child.children) {
				result += this.processTemplate(child, input);
			} else if (typeof child.text === "string") {
				result += child.text; // Text node content
			} else if (typeof child.text === "function") {
				result += child.text() || "";
			}
		}

		return result;
	}

	/** Like collectText, but also cleans (uppercases/normalises) the
	 * result - used specifically to read an <srai> tag's inner text as a
	 * fresh sentence to re-match, which needs the same normalisation the
	 * top-level response() applies to real user input. */
	private getInnerText(node: any): string {
		let text = "";
		for (const child of node.children || []) {
			text += this.nodeText(child);
			if (child.children) text += this.getInnerText(child);
		}
		return this.clean(text);
	}

	/**
	 * Implements Symbolic Reduction: re-runs the ENTIRE match+template
	 * pipeline (findMatch + processTemplate) on `pattern` as if it were a
	 * brand new user utterance, and returns whatever that produces. This is
	 * how AIML authors avoid duplicating templates for every synonymous
	 * phrasing of the same idea - e.g. a category matching "WHATS UP" can
	 * have a template of just `<srai>HELLO</srai>` to reuse the "HELLO"
	 * category's response verbatim. Depth-limited to 10 to prevent infinite
	 * recursion if a badly-authored (or malicious) category <srai>s back to
	 * a pattern that eventually leads to itself.
	 */
	private processSrai(pattern: string): string {
		if (this.sraiDepth > 10) return "";
		const cat = this.findMatch(pattern);
		if (cat) {
			return this.processTemplate(cat.template, pattern);
		}
		return "";
	}

	/** Executes a <think> block's children purely for their side effects
	 * (i.e. any <set> tags inside it update storedVars) while discarding
	 * whatever text they would have produced - <think> is AIML's way of
	 * updating variables without that update showing up in the visible
	 * reply. */
	private processThink(node: any) {
		for (const child of node.children || []) {
			if (child.name === "set") {
				const name = child.attributes?.name || "";
				const value = this.processTemplate(child, "");
				if (name) this.storedVars.set(name, value);
			}
			if (child.children) this.processThink(child);
		}
	}

	/**
	 * Implements AIML's <condition> tag in both of its documented forms:
	 *   - <condition name="X" value="Y">...</condition>: render the body
	 *     only if storedVars["X"] currently equals "Y".
	 *   - <condition><li name="X" value="Y">...</li>...</condition>: check
	 *     each <li> in order and render the first one whose (name, value)
	 *     matches the corresponding stored variable - a simple switch/case
	 *     over AIML variables.
	 */
	private processCondition(node: any, input: string): string {
		const name = node.attributes?.name || "";
		const value = node.attributes?.value || "";

		if (name && value) {
			const stored = this.storedVars.get(name);
			if (stored && this.clean(stored) === this.clean(value)) {
				return this.processTemplate(node, input);
			}
			return "";
		}

		// <condition><li name="X" value="Y">...</li>...</condition>
		for (const child of node.children || []) {
			if (child.name === "li") {
				const liName = child.attributes?.name || name;
				const liValue = child.attributes?.value || "";
				if (!liValue) return this.processTemplate(child, input);
				const stored = this.storedVars.get(liName);
				if (stored && this.clean(stored) === this.clean(liValue)) {
					return this.processTemplate(child, input);
				}
			}
		}
		return "";
	}

	/** Static lookup table backing the <bot name="X"/> tag - a fixed
	 * "profile" for the ALICE persona (name, creator, favourites, ...) that
	 * AIML templates can reference, e.g. `<bot name="favorite_color"/>`. */
	private botAttr(name: string): string {
		const attrs: Record<string, string> = {
			name: "ALICE",
			master: "Dr. Richard Wallace",
			gender: "female",
			age: "18",
			birthday: "November 23, 1995",
			botmaster: "Dr. Richard Wallace",
			favorite_band: "The Beatles",
			favorite_song: "Yesterday",
			favorite_book: "The Lord of the Rings",
			favorite_movie: "The Matrix",
			favorite_color: "blue",
			favorite_food: "pizza",
			location: "Oakland, California",
		};
		return attrs[name.toLowerCase()] || "";
	}
}