import { createRequire } from "node:module";
import { readdirSync, existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const { DomJS } = require("dom-js");

interface Category {
	pattern: string;
	template: string;
	that?: string;
}

export class Alice {
	private categories: Category[] = [];
	private ready = false;
	private lastWildcard = "";
	private sraiDepth = 0;
	private storedVars = new Map<string, string>();

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
		this.ready = true;
	}

	private parseFile(path: string) {
		const xml = require("fs").readFileSync(path, "utf-8");
		const dom = new DomJS();
		dom.parse(xml, (_err: unknown, doc: any) => {
			this.walkCategories(doc.children || []);
		});
	}

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

	private getTagText(parent: any, tag: string): string | null {
		for (const child of parent.children || []) {
			if (child.name === tag) {
				return this.collectText(child);
			}
		}
		return null;
	}

	private getTagContent(parent: any, tag: string): string | null {
		for (const child of parent.children || []) {
			if (child.name === tag) {
				return child;
			}
		}
		return null;
	}

	private collectText(node: any): string {
		let text = "";
		for (const child of node.children || []) {
			if (child.text) text += child.text;
			if (child.children) text += this.collectText(child);
		}
		return text;
	}

	private clean(s: string): string {
		return s.replace(/\s+/g, " ").trim().toUpperCase();
	}

	response(input: string): string {
		if (!this.ready) return "I am not initialized.";

		const cleaned = this.clean(input);
		const cat = this.findMatch(cleaned);
		if (!cat) return "I don't know.";

		this.sraiDepth = 0;
		const result = this.processTemplate(cat.template, cleaned);
		return result || "I don't know.";
	}

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

	private patternToRegex(pattern: string): RegExp {
		const parts = pattern.split(/\s+/);
		const reParts = parts.map((p) => {
			if (p === "*" || p === "_") return "(.*)";
			return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		});
		return new RegExp(`^${reParts.join("\\s+")}$`, "i");
	}

	private processTemplate(tpl: any, input: string): string {
		let result = "";

		for (const child of tpl.children || []) {
			if (child.text) {
				result += child.text;
			} else if (child.name === "star") {
				result += this.lastWildcard;
			} else if (child.name === "sr") {
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
			}
		}

		return result;
	}

	private getInnerText(node: any): string {
		let text = "";
		for (const child of node.children || []) {
			if (child.text) text += child.text;
			if (child.children) text += this.getInnerText(child);
		}
		return this.clean(text);
	}

	private processSrai(pattern: string): string {
		if (this.sraiDepth > 10) return "";
		const cat = this.findMatch(pattern);
		if (cat) {
			return this.processTemplate(cat.template, pattern);
		}
		return "";
	}

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
