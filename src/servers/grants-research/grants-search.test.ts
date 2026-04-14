import assert from "node:assert/strict";
import { test } from "node:test";
import { filter_grants, should_auto_refresh_snapshot } from "./grant-logic";
import { parse_grant_query } from "./grant-query";
import type { GrantRecord } from "./types";

test("parse_grant_query infers source and closing window from raw natural language", () => {
	const parsed = parse_grant_query({
		query: "NIH grants in neuroscience closing in the next 60 days",
	});

	assert.equal(parsed.source_id, "nih-guide");
	assert.equal(parsed.closing_within_days, 60);
	assert.deepEqual(parsed.query_tokens, ["neuroscience"]);
});

test("parse_grant_query infers broad intent flags and closing soon defaults", () => {
	const parsed = parse_grant_query({
		query:
			"Why was this currently open NIH neuroscience grant excluded for eligibility and funding amount? Closing soon.",
	});

	assert.equal(parsed.source_id, "nih-guide");
	assert.equal(parsed.closing_within_days, 30);
	assert.equal(parsed.intents.open_now, true);
	assert.equal(parsed.intents.eligibility_focus, true);
	assert.equal(parsed.intents.amount_focus, true);
	assert.equal(parsed.intents.explainability, true);
});

test("parse_grant_query treats universal query words as passthrough", () => {
	const parsed = parse_grant_query({ query: "all grants" });
	assert.deepEqual(parsed.query_tokens, []);
});

test("parse_grant_query treats 'any available grants' as passthrough", () => {
	const parsed = parse_grant_query({ query: "any available grants" });
	assert.deepEqual(parsed.query_tokens, []);
});

test("filter_grants matches NIH neuroscience opportunities inside a 60 day window", () => {
	const now = Date.now();
	const grants = [
		grant_record({
			id: "grant_1",
			source_id: "nih-guide",
			title: "Neuroscience Research Funding Opportunity",
			excerpt: "Supports translational neuroscience teams.",
			deadline_iso: new Date(now + 30 * DAY_MS).toISOString(),
		}),
		grant_record({
			id: "grant_2",
			source_id: "nih-guide",
			title: "Cancer Biology Opportunity",
			excerpt: "Cancer-focused investigators only.",
			deadline_iso: new Date(now + 25 * DAY_MS).toISOString(),
		}),
		grant_record({
			id: "grant_3",
			source_id: "nsf-funding",
			title: "Neuroscience Systems Research",
			excerpt: "Interdisciplinary neuroscience work.",
			deadline_iso: new Date(now + 20 * DAY_MS).toISOString(),
		}),
		grant_record({
			id: "grant_4",
			source_id: "nih-guide",
			title: "Neuroscience Long Horizon Program",
			excerpt: "Deadline well outside the requested window.",
			deadline_iso: new Date(now + 90 * DAY_MS).toISOString(),
		}),
	];

	const result = filter_grants(grants, {
		min_score: 50,
		limit: 10,
		query: "NIH grants in neuroscience closing in the next 60 days",
		include_borderline: true,
	});

	assert.deepEqual(
		result.grants.map((grant) => grant.id),
		["grant_1"],
	);
	assert.equal(result.applied_filters.source_id, "nih-guide");
	assert.equal(result.applied_filters.closing_within_days, 60);
	assert.deepEqual(result.applied_filters.query_tokens, ["neuroscience"]);
});

test("filter_grants returns explainability counts and strict open-now filtering", () => {
	const now = Date.now();
	const grants = [
		grant_record({
			id: "grant_open_good",
			source_id: "nih-guide",
			title: "Neuroscience Program",
			excerpt: "Open now for translational neuroscience teams.",
			open_score: 80,
			is_likely_open: true,
			deadline_iso: new Date(now + 20 * DAY_MS).toISOString(),
		}),
		grant_record({
			id: "grant_open_borderline",
			source_id: "nih-guide",
			title: "Neuroscience Pilot",
			excerpt: "Open now wording but weak signals.",
			open_score: 45,
			is_likely_open: false,
			deadline_iso: new Date(now + 12 * DAY_MS).toISOString(),
		}),
		grant_record({
			id: "grant_other_source",
			source_id: "nsf-funding",
			title: "Neuroscience Systems",
			excerpt: "Open now.",
			deadline_iso: new Date(now + 10 * DAY_MS).toISOString(),
		}),
	];

	const result = filter_grants(grants, {
		source_id: "nih-guide",
		min_score: 50,
		limit: 10,
		query: "currently open neuroscience grants",
		include_borderline: true,
	});

	assert.deepEqual(
		result.grants.map((grant) => grant.id),
		["grant_open_good"],
	);
	assert.equal(result.applied_filters.query_intents.open_now, true);
	assert.equal(result.explainability.excluded_counts.source_mismatch, 1);
	assert.equal(result.explainability.excluded_counts.score_too_low, 1);
	assert.equal(result.explainability.excluded_counts.not_likely_open, 0);
	assert.match(
		(result.explainability.included[0]?.missing_fields ?? []).join(","),
		/amount_summary|eligibility_summary|scope_summary/,
	);
});

test("filter_grants applies OR-threshold matching for multi-word queries", () => {
	const grants = [
		grant_record({
			id: "grant_biology",
			title: "Biology Program",
			excerpt: "Supports foundational biology research teams.",
		}),
		grant_record({
			id: "grant_imaging",
			title: "Imaging Program",
			excerpt: "Supports advanced imaging instrumentation development.",
		}),
		grant_record({
			id: "grant_neither",
			title: "Astronomy Program",
			excerpt: "Supports telescope methods for deep-space observations.",
		}),
	];

	const result = filter_grants(grants, {
		min_score: 0,
		limit: 10,
		query: "biology imaging",
		include_borderline: true,
	});

	assert.equal(result.grants.length, 2);
	assert.deepEqual(
		new Set(result.grants.map((grant) => grant.id)),
		new Set(["grant_biology", "grant_imaging"]),
	);
});

test("filter_grants requires a single query token to match", () => {
	const grants = [
		grant_record({
			id: "grant_neuroscience",
			title: "Neuroscience Program",
			excerpt: "Supports translational neuroscience collaborations.",
		}),
		grant_record({
			id: "grant_biology_only",
			title: "Biology Program",
			excerpt: "Supports cellular biology methods.",
		}),
	];

	const result = filter_grants(grants, {
		min_score: 0,
		limit: 10,
		query: "neuroscience",
		include_borderline: true,
	});

	assert.deepEqual(
		result.grants.map((grant) => grant.id),
		["grant_neuroscience"],
	);
});

test("should_auto_refresh_snapshot triggers on empty snapshots", () => {
	assert.equal(
		should_auto_refresh_snapshot({
			auto_refresh_if_stale: false,
			snapshot_is_stale: false,
			snapshot_grant_count: 0,
		}),
		true,
	);
	assert.equal(
		should_auto_refresh_snapshot({
			auto_refresh_if_stale: false,
			snapshot_is_stale: false,
			snapshot_grant_count: 4,
		}),
		false,
	);
	assert.equal(
		should_auto_refresh_snapshot({
			auto_refresh_if_stale: true,
			snapshot_is_stale: true,
			snapshot_grant_count: 4,
		}),
		true,
	);
});

const DAY_MS = 24 * 60 * 60 * 1000;

function grant_record(overrides: Partial<GrantRecord> = {}): GrantRecord {
	return {
		id: "grant_default",
		source_id: "nih-guide",
		source_name: "NIH Grants Guide",
		source_url: "https://grants.nih.gov/",
		url: "https://example.com/grant",
		title: "Grant title",
		excerpt: "Grant excerpt",
		open_score: 85,
		is_likely_open: true,
		reasons: ["deadline_in_future"],
		fetched_at: new Date().toISOString(),
		...overrides,
	};
}
