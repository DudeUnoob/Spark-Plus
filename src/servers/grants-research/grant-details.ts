import { extract_deadline_date } from "./grant-extractor";
import type { GrantRecord } from "./types";

const AMOUNT_PATTERNS = [
	/\$\s?\d[\d,]*(?:\.\d+)?\s*(?:million|billion|thousand|k|m)?(?:\s*(?:per year|annually|total|direct costs?))?/i,
	/\b(?:award ceiling|award amount|maximum award|estimated award|funding amount|budget)\b[^\n.]*/i,
	/\bup to\b[^\n.]*(?:\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:million|billion|thousand))/i,
];

const ELIGIBILITY_PATTERNS = [
	/\b(?:eligibility|eligible applicants?|who may apply)\b[^\n]*/i,
	/\b(?:applicant organizations?|eligible institutions?|domestic institutions?)\b[^\n]*/i,
	/\b(?:principal investigators?|faculty|professors?|research institutions?)\b[^\n]*/i,
];

const SCOPE_PATTERNS = [
	/\b(?:purpose|objective|program description|scope|research areas?|topics?)\b[^\n]*/i,
	/\b(?:supports|funds|seeks|invites applications?)\b[^\n]*/i,
];

const DEFAULT_ENRICHMENT_FIELDS = [
	"amount_summary",
	"eligibility_summary",
	"scope_summary",
] as const;

export function extract_grant_detail_summaries(markdown: string): Partial<GrantRecord> {
	const normalized = markdown.replace(/\r/g, "");
	const lines = normalized
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	const text = lines.join("\n");

	return {
		deadline_text: extract_summary_line(
			lines,
			/\b(deadline|closing date|close date|apply by|applications close|applications due)\b/i,
		),
		deadline_iso: to_deadline_iso(text),
		amount_summary: extract_summary_by_patterns(lines, AMOUNT_PATTERNS),
		eligibility_summary: extract_summary_by_patterns(lines, ELIGIBILITY_PATTERNS),
		scope_summary: extract_scope_summary(lines),
	};
}

export function build_comparison_payload(first: GrantRecord, second: GrantRecord) {
	const first_amount = first.amount_summary ?? "Unknown";
	const second_amount = second.amount_summary ?? "Unknown";
	const first_eligibility = first.eligibility_summary ?? "Unknown";
	const second_eligibility = second.eligibility_summary ?? "Unknown";
	const first_scope = first.scope_summary ?? first.excerpt;
	const second_scope = second.scope_summary ?? second.excerpt;
	const first_deadline = first.deadline_text ?? first.deadline_iso ?? "Unknown";
	const second_deadline = second.deadline_text ?? second.deadline_iso ?? "Unknown";
	const deadline_comparison = describe_deadline_tradeoff(first, second);
	const funding_difference =
		first_amount === second_amount
			? `Both grants report the same funding summary: ${first_amount}.`
			: `${first.title} offers ${first_amount}, while ${second.title} offers ${second_amount}.`;
	const eligibility_difference =
		first_eligibility === second_eligibility
			? `Both grants share the same eligibility summary: ${first_eligibility}.`
			: `${first.title} targets ${first_eligibility}, while ${second.title} targets ${second_eligibility}.`;
	const scope_difference =
		first_scope === second_scope
			? `Both grants emphasize the same scope summary: ${first_scope}.`
			: `${first.title} emphasizes ${first_scope}, while ${second.title} emphasizes ${second_scope}.`;

	return {
		first_grant: {
			id: first.id,
			title: first.title,
			url: first.url,
			funding_amount: first_amount,
			eligibility: first_eligibility,
			scope: first_scope,
			deadline: first_deadline,
		},
		second_grant: {
			id: second.id,
			title: second.title,
			url: second.url,
			funding_amount: second_amount,
			eligibility: second_eligibility,
			scope: second_scope,
			deadline: second_deadline,
		},
		comparison_summary: `${deadline_comparison} ${funding_difference}`,
		funding_difference,
		eligibility_difference,
		scope_difference,
		deadline_difference: deadline_comparison,
		key_differences: [
			funding_difference,
			eligibility_difference,
			scope_difference,
			deadline_comparison,
		],
	};
}

export function grant_needs_detail_enrichment(
	grant: GrantRecord,
	required_fields?: readonly (keyof Pick<
		GrantRecord,
		"amount_summary" | "eligibility_summary" | "scope_summary" | "deadline_text" | "deadline_iso"
	>)[],
): boolean {
	const fields = required_fields?.length ? required_fields : DEFAULT_ENRICHMENT_FIELDS;
	const has_deadline = has_non_empty_value(grant.deadline_text) || has_non_empty_value(grant.deadline_iso);

	return fields.some((field) => {
		if (field === "deadline_text" || field === "deadline_iso") return !has_deadline;
		return !has_non_empty_value(grant[field]);
	});
}

function extract_scope_summary(lines: string[]): string | undefined {
	return (
		extract_summary_by_patterns(lines, SCOPE_PATTERNS) ??
		lines.find((line) => line.length > 40 && !line.startsWith("http"))?.slice(0, 220)
	);
}

function extract_summary_by_patterns(lines: string[], patterns: RegExp[]): string | undefined {
	for (const pattern of patterns) {
		const matched_line = lines.find((line) => pattern.test(line));
		if (matched_line) return matched_line.slice(0, 220);
	}
	return undefined;
}

function extract_summary_line(lines: string[], pattern: RegExp): string | undefined {
	const matched_line = lines.find((line) => pattern.test(line));
	return matched_line?.slice(0, 180);
}

function to_deadline_iso(text: string): string | undefined {
	const deadline = extract_deadline_date(text);
	if (!deadline) return undefined;
	return deadline.toISOString();
}

function deadline_timestamp_ms(grant: GrantRecord): number {
	if (grant.deadline_iso) {
		const from_iso = new Date(grant.deadline_iso).getTime();
		if (!Number.isNaN(from_iso)) return from_iso;
	}
	if (grant.deadline_text) {
		const from_text = extract_deadline_date(grant.deadline_text)?.getTime();
		if (from_text !== undefined && !Number.isNaN(from_text)) return from_text;
	}
	return Number.NaN;
}

function describe_deadline_tradeoff(first: GrantRecord, second: GrantRecord): string {
	const first_label = first.deadline_text ?? first.deadline_iso ?? "an unknown deadline";
	const second_label = second.deadline_text ?? second.deadline_iso ?? "an unknown deadline";
	const first_time = deadline_timestamp_ms(first);
	const second_time = deadline_timestamp_ms(second);

	if (!Number.isNaN(first_time) && !Number.isNaN(second_time)) {
		if (first_time === second_time) {
			return `Both grants share the same deadline window: ${first_label}.`;
		}
		if (first_time < second_time) {
			return `${first.title} closes sooner (${first_label}) than ${second.title} (${second_label}).`;
		}
		return `${second.title} closes sooner (${second_label}) than ${first.title} (${first_label}).`;
	}

	return `${first.title} lists ${first_label}, while ${second.title} lists ${second_label}.`;
}

function has_non_empty_value(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}
