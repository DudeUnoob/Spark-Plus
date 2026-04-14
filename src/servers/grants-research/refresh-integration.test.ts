import assert from "node:assert/strict";
import { test } from "node:test";
import { FirecrawlClient } from "./firecrawl-client";
import { extract_grant_candidates } from "./grant-extractor";
import { ABSOLUTE_MAX_PAGES_PER_SOURCE, GRANT_SOURCES } from "./sources";

test("Firecrawl source pipeline: bounded subrequests and grant candidate extraction", async () => {
	const client = new FirecrawlClient("test-key", {
		max_retries: 0,
		min_delay_ms: 0,
		jitter_ms: 0,
	});

	const original_fetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input.toString();
		const pathname = new URL(url).pathname;

		if (pathname.endsWith("/search")) {
			return json_response({
				success: true,
				data: {
					web: [
						{
							url: "https://grants.nih.gov/grants/guide/notice-files/NOT-TEST-001.html",
							title: "NIH Neuroscience Opportunity",
							markdown: [
								"# NIH Neuroscience Opportunity",
								"Funding Opportunity Announcement",
								"Deadline: June 10, 2026",
								"Supports translational neuroscience research teams.",
							].join("\n"),
							links: [],
							metadata: {
								title: "NIH Neuroscience Opportunity",
								url: "https://grants.nih.gov/grants/guide/notice-files/NOT-TEST-001.html",
								sourceURL: "https://grants.nih.gov/grants/guide/notice-files/NOT-TEST-001.html",
								statusCode: 200,
							},
						},
					],
				},
			});
		}

		if (pathname.endsWith("/scrape")) {
			const request = JSON.parse(String(init?.body ?? "{}")) as { url?: string };
			const page = page_by_url(request.url ?? "unknown");
			return json_response({
				success: true,
				data: {
					markdown: page.markdown,
					links: [],
					metadata: {
						title: page.title,
						url: request.url,
						sourceURL: request.url,
						statusCode: 200,
					},
				},
			});
		}

		throw new Error(`Unexpected fetch: ${url}`);
	};

	const max_pages_per_source = 4;
	let total_pages = 0;
	const usage_start = client.get_usage_snapshot();
	const all_candidates: ReturnType<typeof extract_grant_candidates> = [];

	try {
		for (const source of GRANT_SOURCES) {
			const usage_before = client.get_usage_snapshot();
			let pages;

			if (source.strategy === "search") {
				const page_limit = Math.min(
					max_pages_per_source,
					source.search?.limit ?? max_pages_per_source,
					ABSOLUTE_MAX_PAGES_PER_SOURCE,
				);
				pages = await client.search_source(source, page_limit);
			} else if (source.strategy === "scrape") {
				pages = await client.scrape_source(source);
			} else {
				throw new Error(`Unsupported strategy in test: ${source.strategy}`);
			}

			const usage_delta = client.get_usage_delta(usage_before);
			assert.ok(
				usage_delta.total_subrequests >= 1,
				`expected at least one subrequest for ${source.id}`,
			);
			assert.equal(usage_delta.crawl_polls, 0);

			total_pages += pages.length;
			const candidates = extract_grant_candidates(source, pages);
			assert.ok(
				candidates.length >= 1,
				`expected candidates from ${source.id}, got ${candidates.length}`,
			);
			all_candidates.push(...candidates);
		}

		const usage_total = client.get_usage_delta(usage_start);
		assert.equal(usage_total.total_subrequests, 5);
		assert.equal(usage_total.crawl_polls, 0);
		assert.equal(total_pages, 5);
		assert.ok(all_candidates.length >= 5);
	} finally {
		globalThis.fetch = original_fetch;
	}
});

function page_by_url(url: string) {
	if (url.includes("nsf.gov")) {
		return {
			title: "NSF AI Agents Program",
			markdown: [
				"# NSF AI Agents Program",
				"Full Proposal Deadline:",
				"May 27, 2026",
				"Supports artificial intelligence and robotics research.",
			].join("\n"),
		};
	}
	if (url.includes("science.osti.gov")) {
		return {
			title: "DOE Quantum Systems FOA",
			markdown: [
				"# DOE Quantum Systems FOA",
				"Close Date:",
				"Thursday, May 21, 2026",
				"Funds quantum networking and systems research.",
			].join("\n"),
		};
	}
	if (url.includes("nifa.usda.gov")) {
		return {
			title: "USDA Crop Innovation Program",
			markdown: [
				"# USDA Crop Innovation Program",
				"This grant program invites applications for agricultural research funding.",
				"Closing Date",
				"Mon, 15 Jun 2026",
				"Supports agricultural innovation and extension projects.",
			].join("\n"),
		};
	}
	return {
		title: "DARPA Challenge Opportunity",
		markdown: [
			"# DARPA Challenge Opportunity",
			"Deadline date: June 2, 2026",
			"Seeks novel national security research proposals.",
		].join("\n"),
	};
}

function json_response(payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}
