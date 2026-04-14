import type { GrantRecord } from "./types";

const SOURCE_HINTS: Array<{ source_id: GrantRecord["source_id"]; patterns: RegExp[] }> = [
	{ source_id: "nih-guide", patterns: [/\bnih\b/i, /\bnational institutes? of health\b/i] },
	{ source_id: "nsf-funding", patterns: [/\bnsf\b/i, /\bnational science foundation\b/i] },
	{ source_id: "doe-science", patterns: [/\bdoe\b/i, /\bdepartment of energy\b/i] },
	{
		source_id: "nifa-usda",
		patterns: [/\busda\b/i, /\bnifa\b/i, /\bdepartment of agriculture\b/i],
	},
	{ source_id: "darpa-opportunities", patterns: [/\bdarpa\b/i] },
];

const DEADLINE_WINDOW_PATTERNS = [
	/\bclosing\s+in\s+(?:the\s+)?next\s+(\d{1,3})\s+days?\b/i,
	/\bwithin\s+(\d{1,3})\s+days?\b/i,
	/\bnext\s+(\d{1,3})\s+days?\b/i,
	/\bdue\s+in\s+(\d{1,3})\s+days?\b/i,
];

const CLOSING_SOON_PATTERNS = [
	/\bclosing soon\b/i,
	/\bdue soon\b/i,
	/\bupcoming deadlines?\b/i,
];

const OPEN_NOW_PATTERNS = [
	/\bopen now\b/i,
	/\bcurrently open\b/i,
	/\bcurrently active\b/i,
	/\bopen opportunities?\b/i,
	/\bopen\b/i,
];

const ELIGIBILITY_QUERY_PATTERNS = [
	/\beligib/i,
	/\bwho can apply\b/i,
	/\bcan i apply\b/i,
	/\bapplicant requirements?\b/i,
];

const AMOUNT_QUERY_PATTERNS = [
	/\bfunding amount\b/i,
	/\baward amount\b/i,
	/\bbudget\b/i,
	/\bhow much\b/i,
	/\bamount\b/i,
];

const SCOPE_QUERY_PATTERNS = [
	/\bresearch area\b/i,
	/\bscope\b/i,
	/\btopic\b/i,
	/\bfit\b/i,
	/\brelevant to\b/i,
];

const EXPLAINABILITY_QUERY_PATTERNS = [
	/\bwhy\b/i,
	/\bwhy included\b/i,
	/\bwhy excluded\b/i,
	/\bwhy did\b/i,
	/\bexplain\b/i,
	/\breason\b/i,
];

const COMPARISON_QUERY_PATTERNS = [/\bcompare\b/i, /\bversus\b/i, /\bvs\.?\b/i];

const NOISE_PHRASES = [
	/\bgrants?\b/gi,
	/\bfunding opportunities?\b/gi,
	/\bfunding\b/gi,
	/\ball\b/gi,
	/\bany\b/gi,
	/\bevery\b/gi,
	/\beverything\b/gi,
	/\blist\b/gi,
	/\bget\b/gi,
	/\bshow\b/gi,
	/\bavailable\b/gi,
	/\bcurrent\b/gi,
	/\blatest\b/gi,
	/\brecent\b/gi,
	/\bclosing\b/gi,
	/\bdeadline\b/gi,
	/\bdeadlines\b/gi,
	/\bnext\b/gi,
	/\bdays?\b/gi,
	/\bwithin\b/gi,
	/\bin\b/gi,
	/\bthe\b/gi,
	/\bfor\b/gi,
	/\bshow me\b/gi,
	/\bfind me\b/gi,
	/\bthat are\b/gi,
	/\bclosing in\b/gi,
	/\bclose in\b/gi,
	/\bopen\b/gi,
	/\bcurrently\b/gi,
	/\bactive\b/gi,
	/\bwho can apply\b/gi,
	/\bcan i apply\b/gi,
	/\bapplicant requirements?\b/gi,
	/\bfunding amount\b/gi,
	/\baward amount\b/gi,
	/\bhow much\b/gi,
	/\bscope\b/gi,
	/\bfit\b/gi,
	/\btopic\b/gi,
	/\bresearch area\b/gi,
	/\bwhy\b/gi,
	/\bexplain\b/gi,
	/\breason\b/gi,
	/\bcompare\b/gi,
	/\bversus\b/gi,
	/\bvs\b/gi,
];

const STOPWORDS = new Set([
	"grant",
	"grants",
	"funding",
	"opportunity",
	"opportunities",
	"all",
	"any",
	"every",
	"everything",
	"list",
	"get",
	"available",
	"current",
	"latest",
	"recent",
	"with",
	"and",
	"about",
	"related",
	"have",
	"has",
	"been",
	"will",
	"closing",
	"close",
	"deadline",
	"deadlines",
	"next",
	"days",
	"day",
	"within",
	"in",
	"the",
	"for",
	"show",
	"me",
	"find",
	"that",
	"are",
	"open",
	"currently",
	"active",
	"who",
	"can",
	"apply",
	"eligibility",
	"eligible",
	"applicant",
	"requirements",
	"amount",
	"budget",
	"scope",
	"topic",
	"relevant",
	"research",
	"area",
	"why",
	"reason",
	"explain",
	"compare",
	"versus",
	"vs",
]);

export type GrantQueryIntents = {
	open_now: boolean;
	eligibility_focus: boolean;
	amount_focus: boolean;
	scope_focus: boolean;
	explainability: boolean;
	comparison: boolean;
};

export type ParsedGrantQuery = {
	source_id?: string;
	closing_within_days?: number;
	query_tokens: string[];
	normalized_query?: string;
	intents: GrantQueryIntents;
};

export function parse_grant_query({
	query,
	source_id,
	closing_within_days,
}: {
	query?: string;
	source_id?: string;
	closing_within_days?: number;
}): ParsedGrantQuery {
	const inferred_source_id = source_id ?? infer_source_id(query);
	const inferred_closing_within_days =
		closing_within_days ?? infer_closing_within_days(query);
	const intents = infer_query_intents(query);
	const query_tokens = tokenize_query(
		remove_query_noise(query ?? "", inferred_source_id, inferred_closing_within_days),
	);

	return {
		source_id: inferred_source_id,
		closing_within_days: inferred_closing_within_days,
		query_tokens,
		normalized_query: query_tokens.length > 0 ? query_tokens.join(" ") : undefined,
		intents,
	};
}

export function compute_query_relevance(
	grant: GrantRecord,
	query_tokens: string[],
	intents?: GrantQueryIntents,
): number {
	if (query_tokens.length === 0) return 0;

	const title = grant.title.toLowerCase();
	const scope = `${grant.scope_summary ?? ""}\n${grant.excerpt}`.toLowerCase();
	const haystack = build_query_haystack(grant);

	let score = 0;
	for (const token of query_tokens) {
		if (title.includes(token)) {
			score += 4;
			continue;
		}
		if (scope.includes(token)) {
			score += 2;
			continue;
		}
		if (haystack.includes(token)) score += 1;
	}

	return score + compute_intent_coverage_score(grant, intents);
}

export function compute_intent_coverage_score(
	grant: GrantRecord,
	intents?: GrantQueryIntents,
): number {
	if (!intents) return 0;
	let score = 0;
	if (intents.amount_focus && grant.amount_summary) score += 3;
	if (intents.eligibility_focus && grant.eligibility_summary) score += 3;
	if (intents.scope_focus && grant.scope_summary) score += 2;
	if (intents.open_now && grant.is_likely_open) score += 2;
	return score;
}

export function matches_deadline_window(
	grant: GrantRecord,
	closing_within_days?: number,
	now_ms = Date.now(),
): boolean {
	if (!closing_within_days) return true;
	if (!grant.deadline_iso) return false;

	const deadline_ms = new Date(grant.deadline_iso).getTime();
	if (Number.isNaN(deadline_ms)) return false;

	const max_ms = now_ms + closing_within_days * 24 * 60 * 60 * 1000;
	return deadline_ms >= now_ms && deadline_ms <= max_ms;
}

export function build_query_haystack(grant: GrantRecord): string {
	return [
		grant.title,
		grant.excerpt,
		grant.deadline_text,
		grant.amount_summary,
		grant.eligibility_summary,
		grant.scope_summary,
		grant.source_name,
		grant.source_id,
		grant.reasons.join(" "),
		grant.url,
	]
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
}

function infer_source_id(query?: string): string | undefined {
	if (!query) return undefined;
	return SOURCE_HINTS.find(({ patterns }) => patterns.some((pattern) => pattern.test(query)))
		?.source_id;
}

function infer_closing_within_days(query?: string): number | undefined {
	if (!query) return undefined;
	for (const pattern of DEADLINE_WINDOW_PATTERNS) {
		const match = query.match(pattern);
		const days = Number(match?.[1]);
		if (Number.isFinite(days) && days > 0) return days;
	}
	if (CLOSING_SOON_PATTERNS.some((pattern) => pattern.test(query))) return 30;
	return undefined;
}

function infer_query_intents(query?: string): GrantQueryIntents {
	return {
		open_now: has_any_pattern(query, OPEN_NOW_PATTERNS),
		eligibility_focus: has_any_pattern(query, ELIGIBILITY_QUERY_PATTERNS),
		amount_focus: has_any_pattern(query, AMOUNT_QUERY_PATTERNS),
		scope_focus: has_any_pattern(query, SCOPE_QUERY_PATTERNS),
		explainability: has_any_pattern(query, EXPLAINABILITY_QUERY_PATTERNS),
		comparison: has_any_pattern(query, COMPARISON_QUERY_PATTERNS),
	};
}

function remove_query_noise(
	query: string,
	source_id?: string,
	closing_within_days?: number,
): string {
	let cleaned = query.toLowerCase();
	for (const { source_id: hinted_source_id, patterns } of SOURCE_HINTS) {
		if (source_id && hinted_source_id !== source_id) continue;
		for (const pattern of patterns) cleaned = cleaned.replace(pattern, " ");
	}
	if (closing_within_days) {
		for (const pattern of DEADLINE_WINDOW_PATTERNS) cleaned = cleaned.replace(pattern, " ");
	}
	for (const pattern of NOISE_PHRASES) cleaned = cleaned.replace(pattern, " ");
	return cleaned;
}

function tokenize_query(query: string): string[] {
	return query
		.split(/[^a-z0-9]+/i)
		.map((token) => token.trim().toLowerCase())
		.filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function has_any_pattern(query: string | undefined, patterns: RegExp[]): boolean {
	if (!query) return false;
	return patterns.some((pattern) => pattern.test(query));
}
