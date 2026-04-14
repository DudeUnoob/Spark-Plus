import assert from "node:assert/strict";
import { test } from "node:test";
import {
	build_comparison_payload,
	extract_grant_detail_summaries,
	grant_needs_detail_enrichment,
} from "./grant-details";
import { resolve_grant_reference } from "./grant-logic";
import type { GrantRecord } from "./types";

test("extract_grant_detail_summaries captures deadline amount eligibility and scope", () => {
	const details = extract_grant_detail_summaries(`
# Neuroscience Research Program

Purpose: Supports clinical and translational neuroscience research on memory disorders.
Eligibility: Domestic universities, medical schools, and nonprofit research institutes may apply.
Award ceiling: Up to $750,000 total costs per year.
Application deadline: May 30, 2026.
`);

	assert.match(details.amount_summary ?? "", /\$750,000/i);
	assert.match(details.eligibility_summary ?? "", /domestic universities/i);
	assert.match(details.scope_summary ?? "", /translational neuroscience/i);
	assert.match(details.deadline_text ?? "", /may 30, 2026/i);
	assert.ok(details.deadline_iso);
});

test("resolve_grant_reference supports option index id and url", () => {
	const first = grant_record({ id: "grant_1", url: "https://example.com/1" });
	const second = grant_record({ id: "grant_2", url: "https://example.com/2" });
	const grants = [first, second];
	const last_results = ["grant_1", "grant_2"];

	assert.equal(resolve_grant_reference(grants, last_results, "option 2").id, "grant_2");
	assert.equal(resolve_grant_reference(grants, last_results, "grant_1").id, "grant_1");
	assert.equal(
		resolve_grant_reference(grants, last_results, "https://example.com/2").id,
		"grant_2",
	);
	assert.throws(
		() => resolve_grant_reference(grants, last_results, "option 3"),
		/Could not resolve grant option 3/,
	);
});

test("resolve_grant_reference handles ordinal words and numeric-like URLs safely", () => {
	const first = grant_record({ id: "grant_1", url: "https://example.com/opportunity/2026/1" });
	const second = grant_record({ id: "grant_2", url: "https://example.com/opportunity/2026/2" });
	const third = grant_record({ id: "grant_3", url: "https://example.com/opportunity/2026/3" });
	const grants = [first, second, third];
	const last_results = ["grant_1", "grant_2", "grant_3"];

	assert.equal(resolve_grant_reference(grants, last_results, "first").id, "grant_1");
	assert.equal(resolve_grant_reference(grants, last_results, "option second").id, "grant_2");
	assert.equal(resolve_grant_reference(grants, last_results, "last").id, "grant_3");
	assert.equal(
		resolve_grant_reference(grants, last_results, "https://example.com/opportunity/2026/2")
			.id,
		"grant_2",
	);
});

test("build_comparison_payload highlights funding eligibility and scope differences", () => {
	const comparison = build_comparison_payload(
		grant_record({
			id: "grant_left",
			title: "Neuroscience Pilot",
			amount_summary: "Up to $250,000 per year",
			eligibility_summary: "Open to medical schools only",
			scope_summary: "Pilot neuroscience projects in cognition",
			deadline_text: "Deadline: May 30, 2026",
		}),
		grant_record({
			id: "grant_right",
			title: "Neuroscience Center Grant",
			amount_summary: "Up to $1,200,000 total costs per year",
			eligibility_summary: "Open to universities and nonprofits",
			scope_summary: "Large center-scale neuroscience infrastructure",
			deadline_text: "Deadline: June 15, 2026",
		}),
	);

	assert.match(comparison.key_differences[0] ?? "", /\$250,000/i);
	assert.match(comparison.key_differences[1] ?? "", /medical schools/i);
	assert.match(comparison.key_differences[2] ?? "", /center-scale/i);
	assert.match(comparison.deadline_difference ?? "", /closes sooner/i);
	assert.match(comparison.comparison_summary ?? "", /offers/i);
});

test("build_comparison_payload falls back to Unknown when fields are missing", () => {
	const comparison = build_comparison_payload(
		grant_record({ id: "grant_left", title: "Minimal Left", excerpt: "Left excerpt" }),
		grant_record({ id: "grant_right", title: "Minimal Right", excerpt: "Right excerpt" }),
	);

	assert.equal(comparison.first_grant.funding_amount, "Unknown");
	assert.equal(comparison.second_grant.eligibility, "Unknown");
	assert.match(comparison.first_grant.scope, /Left excerpt/);
});

test("grant_needs_detail_enrichment stays true when a prior enrichment left required fields empty", () => {
	const grant = grant_record({
		detail_enriched_at: "2026-04-14T00:00:00.000Z",
		scope_summary: "Still present",
		deadline_iso: "2026-06-01T00:00:00.000Z",
	});

	assert.equal(
		grant_needs_detail_enrichment(grant, ["amount_summary", "scope_summary"]),
		true,
	);
});

test("grant_needs_detail_enrichment treats either deadline field as sufficient coverage", () => {
	const grant = grant_record({
		amount_summary: "Up to $500,000",
		eligibility_summary: "Universities",
		scope_summary: "Neuroscience",
		deadline_iso: "2026-06-01T00:00:00.000Z",
	});

	assert.equal(
		grant_needs_detail_enrichment(grant, [
			"amount_summary",
			"eligibility_summary",
			"scope_summary",
			"deadline_text",
		]),
		false,
	);
});

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
