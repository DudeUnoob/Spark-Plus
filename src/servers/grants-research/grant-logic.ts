import { ABSOLUTE_MAX_RESULTS } from "./sources";
import {
	build_query_haystack,
	compute_query_relevance,
	matches_deadline_window,
	parse_grant_query,
} from "./grant-query";
import type { GrantRecord } from "./types";

const ORDINAL_WORD_INDEX: Record<string, number> = {
	first: 1,
	second: 2,
	third: 3,
	fourth: 4,
	fifth: 5,
	sixth: 6,
	seventh: 7,
	eighth: 8,
	ninth: 9,
	tenth: 10,
};

export function should_auto_refresh_snapshot({
	auto_refresh_if_stale,
	snapshot_is_stale,
	snapshot_grant_count,
}: {
	auto_refresh_if_stale?: boolean;
	snapshot_is_stale: boolean;
	snapshot_grant_count: number;
}): boolean {
	return (
		(auto_refresh_if_stale !== false && snapshot_is_stale) || snapshot_grant_count === 0
	);
}

export function filter_grants(
	grants: GrantRecord[],
	{
		source_id,
		min_score,
		limit,
		query,
		closing_within_days,
		include_borderline,
	}: {
		source_id?: string;
		min_score: number;
		limit: number;
		query?: string;
		closing_within_days?: number;
		include_borderline: boolean;
	},
): {
	grants: GrantRecord[];
	applied_filters: {
		source_id?: string;
		closing_within_days?: number;
		query_tokens: string[];
		query_intents: ReturnType<typeof parse_grant_query>["intents"];
		min_score: number;
		include_borderline: boolean;
	};
	explainability: {
		included: Array<{
			grant_id: string;
			match_score: number;
			matched_tokens: string[];
			open_score: number;
			source_id: string;
			reasons: string[];
			missing_fields: string[];
		}>;
		excluded_counts: {
			source_mismatch: number;
			score_too_low: number;
			deadline_outside_window: number;
			query_mismatch: number;
			not_likely_open: number;
		};
	};
} {
	const bounded_limit = Math.min(Math.max(1, limit), ABSOLUTE_MAX_RESULTS);
	const parsed_query = parse_grant_query({
		query,
		source_id,
		closing_within_days,
	});
	const excluded_counts = {
		source_mismatch: 0,
		score_too_low: 0,
		deadline_outside_window: 0,
		query_mismatch: 0,
		not_likely_open: 0,
	};

	const filtered = grants.filter((grant) => {
		if (parsed_query.source_id && grant.source_id !== parsed_query.source_id) {
			excluded_counts.source_mismatch++;
			return false;
		}

		const score_threshold =
			parsed_query.intents.open_now || !include_borderline
				? min_score
				: Math.max(0, min_score - 10);
		if (grant.open_score < score_threshold) {
			excluded_counts.score_too_low++;
			return false;
		}
		if (parsed_query.intents.open_now && !grant.is_likely_open) {
			excluded_counts.not_likely_open++;
			return false;
		}

		if (!matches_deadline_window(grant, parsed_query.closing_within_days)) {
			excluded_counts.deadline_outside_window++;
			return false;
		}
		if (parsed_query.query_tokens.length === 0) return true;

		const haystack = build_query_haystack(grant);
		const matched_count = parsed_query.query_tokens.filter((token) =>
			haystack.includes(token),
		).length;
		const match_threshold =
			parsed_query.query_tokens.length <= 1
				? 1
				: Math.ceil(parsed_query.query_tokens.length * 0.5);
		const matched = matched_count >= match_threshold;
		if (!matched) excluded_counts.query_mismatch++;
		return matched;
	});

	const ranked = filtered.sort((left, right) => {
		const relevance_difference =
			compute_query_relevance(
				right,
				parsed_query.query_tokens,
				parsed_query.intents,
			) -
			compute_query_relevance(
				left,
				parsed_query.query_tokens,
				parsed_query.intents,
			);
		if (relevance_difference !== 0) return relevance_difference;

		const left_deadline = left.deadline_iso ? new Date(left.deadline_iso).getTime() : Infinity;
		const right_deadline = right.deadline_iso ? new Date(right.deadline_iso).getTime() : Infinity;
		if (left_deadline !== right_deadline) return left_deadline - right_deadline;

		return right.open_score - left.open_score;
	});

	return {
		grants: ranked.slice(0, bounded_limit),
		applied_filters: {
			source_id: parsed_query.source_id,
			closing_within_days: parsed_query.closing_within_days,
			query_tokens: parsed_query.query_tokens,
			query_intents: parsed_query.intents,
			min_score,
			include_borderline,
		},
		explainability: {
			included: ranked.slice(0, bounded_limit).map((grant) =>
				build_included_explainability(grant, parsed_query.query_tokens, parsed_query.intents),
			),
			excluded_counts,
		},
	};
}

export function resolve_grant_reference(
	grants: GrantRecord[],
	last_listed_grant_ids: string[],
	reference: string,
): GrantRecord {
	const normalized_reference = reference.trim();
	const normalized_lower = normalized_reference.toLowerCase();
	const index = resolve_reference_index(normalized_lower, last_listed_grant_ids.length);
	if (index !== undefined) {
		const grant_id = last_listed_grant_ids[index - 1];
		if (!grant_id) {
			throw new Error(`Could not resolve grant option ${index} from the latest results.`);
		}
		const indexed_grant = grants.find((grant) => grant.id === grant_id);
		if (indexed_grant) return indexed_grant;
	}

	const direct_match = grants.find(
		(grant) => grant.id === normalized_reference || grant.url === normalized_reference,
	);
	if (direct_match) return direct_match;

	throw new Error(`Grant reference "${reference}" did not match any cached grant.`);
}

function resolve_reference_index(
	normalized_reference: string,
	last_results_length: number,
): number | undefined {
	if (normalized_reference === "last") return last_results_length > 0 ? last_results_length : undefined;

	const strict_numeric = normalized_reference.match(/^(?:option\s*)?(\d+)$/i);
	if (strict_numeric) {
		const numeric_index = Number(strict_numeric[1]);
		return Number.isFinite(numeric_index) && numeric_index > 0 ? numeric_index : undefined;
	}

	const option_word = normalized_reference.match(/^(?:option\s+)?([a-z]+)$/i)?.[1];
	if (option_word && option_word in ORDINAL_WORD_INDEX) {
		return ORDINAL_WORD_INDEX[option_word];
	}

	return undefined;
}

function build_included_explainability(
	grant: GrantRecord,
	query_tokens: string[],
	query_intents: ReturnType<typeof parse_grant_query>["intents"],
) {
	const haystack = build_query_haystack(grant);
	return {
		grant_id: grant.id,
		match_score: compute_query_relevance(grant, query_tokens, query_intents),
		matched_tokens: query_tokens.filter((token) => haystack.includes(token)),
		open_score: grant.open_score,
		source_id: grant.source_id,
		reasons: grant.reasons,
		missing_fields: [
			!grant.amount_summary ? "amount_summary" : undefined,
			!grant.eligibility_summary ? "eligibility_summary" : undefined,
			!grant.scope_summary ? "scope_summary" : undefined,
			!grant.deadline_text && !grant.deadline_iso ? "deadline" : undefined,
		].filter(Boolean) as string[],
	};
}
