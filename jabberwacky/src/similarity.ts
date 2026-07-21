/**
 * similarity.ts -- Text similarity engine for contextual matching.
 *
 * == ROLE IN THE ARCHITECTURE ==
 *
 * This file provides the core numeric scoring that drives the entire bot.
 * Every candidate match in findCandidates() is scored by comparing "how close
 * is the user's input to this historical line?" -- and that comparison IS this
 * file.
 *
 * The original Jabberwacky and Cleverbot scoring algorithms were never
 * published. We only know the HIGH-LEVEL description:
 *   - "contextual pattern matching"
 *   - "heuristics for relevance, humour, and context fit"
 *   - "a way of measuring similarity between what the user said and what has
 *      been said before"
 *
 * This implementation is our own reasonable approximation using standard
 * information-retrieval techniques (Jaccard similarity on unigrams and
 * bigrams). It is NOT a copy of any proprietary algorithm.
 *
 * == WHY JACCARD + BIGRAMS ==
 *
 * We need a metric that captures:
 *   (a) topic overlap -- do the two sentences talk about the same thing?
 *       → Jaccard on content words (unigrams after stopword removal)
 *   (b) phrase structure -- do they share multi-word patterns?
 *       → Jaccard on bigrams (pairs of adjacent tokens)
 *   (c) proportional length -- are they both questions? both one-liners?
 *       → a length-proximity bonus
 *
 * Each of these returns a score in [0, 1]. The final similarity is a weighted
 * sum. The weights were chosen by intuition (unigrams = most important,
 * bigrams = secondary signal, length = minor tiebreaker), and can be tweaked
 * in BotConfig to change behaviour.
 *
 * == EXAMPLE ==
 *
 *   similarity("hello there", "hello who is this")
 *     → contentTokens gives ["hello"] and ["who", "this"]
 *     → unigram Jaccard: {hello} ∩ {who, this} = {}  →  0/3 = 0
 *     → bigram Jaccard:  {"hello_there"} ∩ {"who_is", "is_this"} = {} → 0
 *     → length closeness: 1 - |1-2|/2 = 0.5
 *     → final = 0.6*0 + 0.3*0 + 0.1*0.5 = 0.05  (below minScore, rejected)
 *
 * But similarity("hello", "hello and welcome") is higher because
 *   → both have "hello" → unigram Jaccard = 1/3 ≈ 0.33
 *   → final ≈ 0.6*0.33 + 0 + 0.1*1 = 0.30 (strong match)
 *
 * == STOPWORDS ==
 *
 * We strip a small set of common English (and some French) stopwords before
 * computing similarity. This prevents function words like "the", "and", or
 * "you" from inflating similarity scores when they don't carry topic meaning.
 *
 * Why French too? Because the seed corpus was originally written with some
 * bilingual patterns in mind, and removing them keeps the matching more
 * content-focused.
 */

/**
 * Common function words that carry little topical meaning.
 * These are stripped before similarity computation so that matches are driven
 * by content words, not syntax.
 *
 * Includes English + French because the original Jabberwacky audience was
 * global and some bilingual patterns appear even in English-dominant corpora.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "and", "is", "it", "in", "that", "this",
  "i", "you", "he", "she", "we", "they", "was", "were", "be", "been",
  "am", "are", "do", "does", "did", "on", "for", "with", "as", "at",
  "le", "la", "les", "un", "une", "de", "du", "des", "et", "est", "ce",
  "que", "qui", "je", "tu", "il", "elle", "nous", "vous", "ils", "elles",
]);

/**
 * Split text into lowercased, NFKD-normalised tokens.
 *
 * Normalization (NFKD) decomposes accented characters (e.g. "é" → "e" + combining
 * accent), then the regex strips everything except letters, numbers, spaces, and
 * apostrophes. This makes "café" and "cafe" match fairly well.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Tokenize and remove stopwords, keeping only words that carry topical meaning.
 *
 * This is the primary input to the similarity computation. Without stopword
 * removal, two sentences like "I am a dog" and "I am a cat" would appear
 * 66% similar (they share "i", "am", "a") even though they're about completely
 * different things.
 */
export function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => !STOPWORDS.has(t));
}

/**
 * Generate bigram tokens from a list of unigram tokens.
 *
 * A bigram is a pair of adjacent words joined by an underscore.
 * e.g. tokens ["who", "are", "you"] → bigrams ["who_are", "are_you"]
 *
 * Bigrams capture short phrase patterns that unigram overlap misses.
 * "what is love" and "what is this" share unigrams {"what", "is"} but
 * their bigrams {"what_is", "is_love"} ∩ {"what_is", "is_this"} = {"what_is"}
 * shows they share a pattern the unigram view misses.
 */
function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    out.push(`${tokens[i]}_${tokens[i + 1]}`);
  }
  return out;
}

/**
 * Compute Jaccard similarity between two sets.
 *
 *   J(A, B) = |A ∩ B| / |A ∪ B|
 *
 * This gives a value in [0, 1] where:
 *   - 0 means no common elements
 *   - 1 means identical sets
 *
 * We use this for both unigram and bigram overlap. The intersection size is
 * computed by iterating the smaller set and checking membership in the larger
 * (though with our small corpuses, optimisation doesn't matter much).
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Combined similarity score between two strings.
 *
 * The formula is:
 *
 *   score = 0.6 × Jaccard(content_words_a, content_words_b)
 *         + 0.3 × Jaccard(bigrams_a, bigrams_b)
 *         + 0.1 × length_closeness
 *
 * where length_closeness = 1 - |len_a - len_b| / max(len_a, len_b)
 *
 * The weights reflect:
 *   - 0.6 unigram: topic overlap is the primary signal (what is this about?)
 *   - 0.3 bigram: phrase structure adds nuance (same topic + same pattern = better)
 *   - 0.1 length: fine-grained tiebreaker (a 3-word reply and a 50-word rant
 *     are unlikely to be good matches even if they share some words)
 *
 * If either string has zero content tokens after stopword removal, the score
 * is 0 (we can't match on nothing).
 */
export function similarity(a: string, b: string): number {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  const uniScore = jaccard(new Set(ta), new Set(tb));
  const biScore = jaccard(new Set(bigrams(ta)), new Set(bigrams(tb)));
  const lenScore =
    1 - Math.abs(ta.length - tb.length) / Math.max(ta.length, tb.length, 1);

  return 0.6 * uniScore + 0.3 * biScore + 0.1 * lenScore;
}
