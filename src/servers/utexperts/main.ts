import { parseHTML } from "linkedom";
import { z } from "zod";
import { defineMcpServer, defineTool } from "../../shared/mcp-server-creator";

const BASE = "https://experts.utexas.edu";
const RESULTS_URL = `${BASE}/search/results`;
const REFERER = `${BASE}/search/`;

type UTExpertsResearcher = {
	name: string;
	path: string;
	url: string;
	imageUrl: string | null;
	title: string | null;
	email: string | null;
	phone: string | null;
	expertise: string | null;
};

type UTExpertsPayload = {
	source: string;
	query: { type: string; value: string };
	count: number;
	noResults: boolean;
	researchers: UTExpertsResearcher[];
};

async function searchUTExperts(input: {
	keyword?: string;
	school?: string;
	lastname?: string;
}): Promise<UTExpertsPayload> {
	const { keyword, school, lastname } = input ?? {};
	const modes = [keyword, school, lastname].filter(
		(v) => v != null && String(v).trim() !== "",
	);
	if (modes.length !== 1) {
		throw new Error(
			"Provide exactly one of: keyword, school, lastname (non-empty string).",
		);
	}

	const body = new URLSearchParams();
	let type: string;
	let value: string;
	if (keyword != null && String(keyword).trim() !== "") {
		type = "keyword";
		value = String(keyword).trim();
		body.set("keyword", value);
		body.set("go_keyword", "Search");
	} else if (school != null && String(school).trim() !== "") {
		type = "school";
		value = String(school).trim();
		body.set("school", value);
		body.set("go_school", "Search");
	} else {
		type = "lastname";
		value = String(lastname).trim();
		body.set("lastname", value);
		body.set("go_lastname", "Search");
	}

	const res = await fetch(RESULTS_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Referer: REFERER,
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		},
		body: body.toString(),
	});

	const html = await res.text();
	if (!res.ok) {
		throw new Error(`UT Experts HTTP ${res.status} ${res.statusText}`);
	}

	const { document } = parseHTML(html);
	const researchers = parseResearchers(document);
	const noResults = researchers.length === 0 && isNoResultsHtml(html);

	return {
		source: RESULTS_URL,
		query: { type, value },
		count: researchers.length,
		noResults,
		researchers,
	};
}

function isNoResultsHtml(html: string): boolean {
	return (
		html.includes("We were unable to find a suitable match") ||
		html.includes("No results found.")
	);
}

function parseResearchers(document: Document): UTExpertsResearcher[] {
	const units = Array.from(
		document.querySelectorAll(".promo-field.promo-unit"),
	);
	const researchers: UTExpertsResearcher[] = [];
	for (const unit of units) {
		const head = unit.querySelector("a.headline-link");
		const img = unit.querySelector("img.promo-image");
		const copyP = unit.querySelector("div.promo-copy p");
		if (!head) continue;

		const path = head.getAttribute("href") || "";
		const name = (head.textContent || "").trim();
		const imageUrl = img?.getAttribute("src")?.trim() ?? null;
		const alt = img?.getAttribute("alt")?.trim() ?? null;

		let title: string | null = null;
		let email: string | null = null;
		let phone: string | null = null;
		let expertise: string | null = null;

		if (copyP) {
			const strong = copyP.querySelector("strong");
			if (strong) title = (strong.textContent || "").trim();

			const mail = copyP.querySelector('a[href^="mailto:"]');
			if (mail) {
				const href = mail.getAttribute("href") || "";
				email =
					decodeURIComponent(href.replace(/^mailto:/i, "").split("?")[0] || "").trim() ||
					null;
			}

			const fullText = (copyP.textContent || "").replace(/\s+/g, " ").trim();
			const phoneMatch = fullText.match(/\+1\s*\d{3}\s*\d{3}\s*\d{4}/);
			if (phoneMatch) phone = phoneMatch[0].replace(/\s+/g, " ");

			const expIdx = fullText.search(/Expertise:\s*/i);
			if (expIdx >= 0) {
				expertise = fullText.slice(expIdx + "Expertise:".length).trim();
			}
		}

		researchers.push({
			name: name || alt || "",
			path,
			url: path.startsWith("http")
				? path
				: `${BASE}${path.startsWith("/") ? "" : "/"}${path}`,
			imageUrl,
			title,
			email,
			phone,
			expertise,
		});
	}
	return researchers;
}

export const { McpServerClass: UTExperts, metadata: utExpertsData } =
	defineMcpServer({
		name: "UTExperts",
		version: "1.0.0",
		binding: "utexasexperts",
		url_prefix: "/utexperts",
		tools: [
			defineTool({
				name: "searchExperts",
				description:
					"Searches UT Austin Experts (experts.utexas.edu) by exactly one of: keyword, school (College/School/Unit label), or lastname. Returns JSON with source, query, count, noResults, and researchers.",
				inputSchema: {
					keyword: z.string().optional(),
					school: z.string().optional(),
					lastname: z.string().optional(),
					pretty: z.boolean().optional(),
				},
				function: async function ({
					keyword,
					school,
					lastname,
					pretty,
				}: {
					keyword?: string;
					school?: string;
					lastname?: string;
					pretty?: boolean;
				}) {
					const provided = [keyword, school, lastname].filter(
						(v) => v != null && String(v).trim() !== "",
					);
					if (provided.length !== 1) {
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{
											error:
												"Provide exactly one non-empty field: keyword, school, or lastname.",
										},
										null,
										pretty ? 2 : undefined,
									),
								},
							],
							isError: true,
						};
					}
					try {
						const payload = await searchUTExperts({
							keyword,
							school,
							lastname,
						});
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(payload, null, pretty ? 2 : undefined),
								},
							],
						};
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{ error: "searchExperts failed", details: message },
										null,
										pretty ? 2 : undefined,
									),
								},
							],
							isError: true,
						};
					}
				},
			}),
		],
	});
