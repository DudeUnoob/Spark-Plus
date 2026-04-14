import { z } from "zod";
import { McpAgent } from "agents/mcp";
import { defineMcpServer, defineTool } from "../../shared/mcp-server-creator";
import { FirecrawlClient } from "./firecrawl-client";
import {
	build_comparison_payload,
	extract_grant_detail_summaries,
	grant_needs_detail_enrichment,
} from "./grant-details";
import { extract_grant_candidates, score_candidates } from "./grant-extractor";
import {
	filter_grants,
	resolve_grant_reference,
	should_auto_refresh_snapshot,
} from "./grant-logic";
import {
	ABSOLUTE_MAX_PAGES_PER_SOURCE,
	DEFAULT_MAX_RESULTS,
	DEFAULT_MIN_OPEN_SCORE,
	DEFAULT_REFRESH_INTERVAL_SECONDS,
	DEFAULT_STALE_AFTER_MS,
	GRANT_SOURCES,
	SNAPSHOT_MONTHLY_TTL_MS,
} from "./sources";
import { evaluate_refresh_preflight } from "./refresh-policy";
import {
	commit_budget_usage,
	get_budget_state,
	get_last_listed_results,
	get_schedule_id,
	get_snapshot,
	is_snapshot_stale,
	merge_grants_into_snapshot,
	release_budget_reservation,
	release_refresh_lock,
	reserve_budget_pages,
	save_schedule_id,
	save_last_listed_results,
	save_snapshot,
	try_acquire_refresh_lock,
} from "./snapshot-storage";
import type {
	BudgetState,
	FirecrawlPage,
	GrantRecord,
	GrantSourceConfig,
	GrantSnapshot,
	GrantsAgentRuntime,
	RefreshDecisionReason,
	RefreshMode,
	RefreshResult,
	SourceRefreshStats,
} from "./types";

const LOCK_TTL_MS = 1000 * 60 * 8;
const SCHEDULE_CALLBACK_NAME = "scheduled_refresh_tick";
const REQUIRED_FIELD_BY_INTENT = {
	amount_focus: "amount_summary",
	eligibility_focus: "eligibility_summary",
	scope_focus: "scope_summary",
} as const;
const COMPARISON_REQUIRED_FIELDS = [
	"amount_summary",
	"eligibility_summary",
	"scope_summary",
] as const;

type GrantSummaryField = keyof Pick<
	GrantRecord,
	"amount_summary" | "eligibility_summary" | "scope_summary" | "deadline_text" | "deadline_iso"
>;

const { McpServerClass: GrantsResearchBase, metadata: grantsResearchDataBase } =
	defineMcpServer({
		name: "Grants Research",
		version: "1.0.0",
		binding: "grantsResearch",
		url_prefix: "/grants-research",
		tools: [
			defineTool({
				name: "refresh_grants",
				description:
					"Fetches grant opportunities from NIH, NSF, DOE, USDA, and DARPA using Firecrawl and stores them in cache. Call this when total_grants is 0 or results are stale.",
				inputSchema: {
					force: z.boolean().optional(),
					max_pages_per_source: z.number().int().min(1).max(15).optional(),
					min_open_score: z.number().int().min(0).max(100).optional(),
				},
				function: async function (
					this: unknown,
					{
						force,
						max_pages_per_source,
						min_open_score,
					}: {
						force?: boolean;
						max_pages_per_source?: number;
						min_open_score?: number;
					},
				) {
					try {
						const agent = this as GrantsAgentRuntime;
						await ensure_refresh_schedule(agent);
						const result = await refresh_snapshot(agent, {
							mode: "manual",
							force: force ?? false,
							max_pages_per_source: max_pages_per_source ?? 6,
						});
						const min_score = min_open_score ?? DEFAULT_MIN_OPEN_SCORE;
						const grants = result.snapshot.grants.filter(
							(grant) => grant.open_score >= min_score,
						);

						return tool_success({
							refreshed: result.refreshed,
							message: result.message,
							refresh_decision_reason: result.decision_reason,
							pages_used_this_refresh: result.pages_used_this_refresh,
							pages_remaining:
								result.snapshot.budget?.pages_remaining ??
								0,
							fresh_until: result.snapshot.fresh_until,
							min_open_score: min_score,
							open_grants: grants.length,
							snapshot_stats: result.snapshot.stats,
							sources: result.snapshot.sources,
							errors: result.snapshot.errors,
							budget: result.snapshot.budget,
							grants,
						});
					} catch (error) {
						return tool_error("refresh_grants", error);
					}
				},
			}),
			defineTool({
				name: "list_open_grants",
				description:
					"Lists open grants from cache with semantic filtering. If the cache is empty, this tool auto-refreshes first. Supports natural-language queries like 'all grants', 'NIH neuroscience', 'grants closing in 60 days', and 'who can apply for biology grants'. Each result includes the official opportunity URL for follow-up.",
				inputSchema: {
					source_id: z.string().optional(),
					min_score: z.number().int().min(0).max(100).optional(),
					limit: z.number().int().min(1).max(200).optional(),
					query: z.string().min(1).optional(),
					closing_within_days: z.number().int().min(1).max(365).optional(),
					include_borderline: z.boolean().optional(),
					auto_refresh_if_stale: z.boolean().optional(),
					enrich_details: z.boolean().optional(),
				},
				function: async function (
					this: unknown,
					{
						source_id,
						min_score,
						limit,
						query,
						closing_within_days,
						include_borderline,
						auto_refresh_if_stale,
						enrich_details,
					}: {
						source_id?: string;
						min_score?: number;
						limit?: number;
						query?: string;
						closing_within_days?: number;
						include_borderline?: boolean;
						auto_refresh_if_stale?: boolean;
						enrich_details?: boolean;
					},
				) {
					try {
						const agent = this as GrantsAgentRuntime;
						await ensure_refresh_schedule(agent);
						let budget_state = await get_budget_state(agent.ctx.storage);
						let snapshot = await get_snapshot(agent.ctx.storage);
						const should_auto_refresh = should_auto_refresh_snapshot({
							auto_refresh_if_stale,
							snapshot_is_stale: is_snapshot_stale(snapshot, DEFAULT_STALE_AFTER_MS),
							snapshot_grant_count: snapshot?.grants.length ?? 0,
						});

						let refresh_decision_reason: RefreshDecisionReason | undefined;
						if (should_auto_refresh) {
							const refresh_result = await refresh_snapshot(agent, {
								mode: "auto",
								force: false,
								max_pages_per_source: 6,
							});
							snapshot = refresh_result.snapshot;
							refresh_decision_reason = refresh_result.decision_reason;
							budget_state = await get_budget_state(agent.ctx.storage);
						}

						if (!snapshot) {
							return tool_success({
								message: "No cached grants available yet. Call refresh_grants first.",
								pages_remaining: budget_state.pages_remaining,
								refresh_decision_reason: "fresh_cache",
								budget: budget_payload(budget_state, 0),
								grants: [],
							});
						}

						const normalized_snapshot = with_snapshot_defaults(
							snapshot,
							budget_state,
							refresh_decision_reason,
						);
						const filtered = filter_grants(snapshot.grants, {
							source_id,
							min_score: min_score ?? DEFAULT_MIN_OPEN_SCORE,
							limit: limit ?? DEFAULT_MAX_RESULTS,
							query,
							closing_within_days,
							include_borderline: include_borderline ?? true,
						});
						const required_fields = required_fields_for_intents(
							filtered.applied_filters.query_intents,
						);
						const should_enrich_for_fields =
							enrich_details !== false &&
							required_fields.length > 0 &&
							filtered.grants.some((grant) =>
								grant_needs_detail_enrichment(grant, required_fields),
							);
						const enrichment_mode = enrich_details === true
							? "explicit"
							: should_enrich_for_fields
								? "required_fields"
								: "cache_only";
						const enrichment = enrichment_mode === "cache_only"
							? {
									grants: filtered.grants,
									enriched_count: 0,
									errors: [] as string[],
									budget_state,
									pages_used: 0,
								}
							: await enrich_grants(agent, filtered.grants, {
									max_grants: enrichment_mode === "explicit" ? 6 : 3,
									required_fields:
										enrichment_mode === "required_fields"
											? required_fields
											: undefined,
								});
						budget_state = enrichment.budget_state;
						await save_last_listed_results(agent.ctx.storage, {
							grant_ids: enrichment.grants.map((grant) => grant.id),
							query,
							saved_at: new Date().toISOString(),
						});
						const response_grants = grants_for_response(enrichment.grants);

						return tool_success({
							updated_at: normalized_snapshot.updated_at,
							fresh_until: normalized_snapshot.fresh_until,
							next_scheduled_refresh_at:
								normalized_snapshot.next_scheduled_refresh_at,
							refresh_decision_reason:
								normalized_snapshot.refresh_decision_reason,
							total_grants: normalized_snapshot.stats.total_grants,
							returned_grants: enrichment.grants.length,
							pages_remaining: budget_state.pages_remaining,
							budget: budget_payload(budget_state, enrichment.pages_used),
							applied_filters: filtered.applied_filters,
							explainability: filtered.explainability,
							field_coverage: summarize_field_coverage(enrichment.grants),
							enrichment: {
								mode: enrichment_mode,
								enriched_grants: enrichment.enriched_count,
								pages_used: enrichment.pages_used,
								errors: enrichment.errors,
							},
							grants: response_grants,
						});
					} catch (error) {
						return tool_error("list_open_grants", error);
					}
				},
			}),
			defineTool({
				name: "compare_grants",
				description:
					"Compares two grants from the latest shown results or by explicit grant id/url and highlights deadline, funding, eligibility, and scope tradeoffs.",
				inputSchema: {
					first_grant_ref: z.string().min(1),
					second_grant_ref: z.string().min(1),
					enrich_details: z.boolean().optional(),
				},
				function: async function (
					this: unknown,
					{
						first_grant_ref,
						second_grant_ref,
						enrich_details,
					}: {
						first_grant_ref: string;
						second_grant_ref: string;
						enrich_details?: boolean;
					},
				) {
					try {
						const agent = this as GrantsAgentRuntime;
						await ensure_refresh_schedule(agent);
						let budget_state = await get_budget_state(agent.ctx.storage);
						const snapshot = await get_snapshot(agent.ctx.storage);
						if (!snapshot) {
							return tool_success({
								message: "No cached grants available yet. Call refresh_grants first.",
								pages_remaining: budget_state.pages_remaining,
								budget: budget_payload(budget_state, 0),
							});
						}

						const last_listed_results = await get_last_listed_results(agent.ctx.storage);
						const first_grant = resolve_grant_reference(
							snapshot.grants,
							last_listed_results?.grant_ids ?? [],
							first_grant_ref,
						);
						const second_grant = resolve_grant_reference(
							snapshot.grants,
							last_listed_results?.grant_ids ?? [],
							second_grant_ref,
						);
						let compared_grants = [first_grant, second_grant];
						const should_enrich_for_compare =
							enrich_details !== false &&
							compared_grants.some((grant) =>
								grant_needs_detail_enrichment(grant, COMPARISON_REQUIRED_FIELDS),
							);
						const enrichment_mode = enrich_details === true
							? "explicit"
							: should_enrich_for_compare
								? "required_fields"
								: "cache_only";
						const enrichment = enrichment_mode === "cache_only"
							? {
									grants: compared_grants,
									enriched_count: 0,
									errors: [] as string[],
									budget_state,
									pages_used: 0,
								}
							: await enrich_grants(agent, compared_grants, {
									max_grants: 2,
									required_fields:
										enrichment_mode === "required_fields"
											? COMPARISON_REQUIRED_FIELDS
											: undefined,
								});
						compared_grants = enrichment.grants;
						budget_state = enrichment.budget_state;

						return tool_success({
							budget: budget_payload(budget_state, enrichment.pages_used),
							field_coverage: summarize_field_coverage(compared_grants),
							resolved_references: {
								first_grant_ref,
								second_grant_ref,
								first_grant_id: compared_grants[0]?.id,
								second_grant_id: compared_grants[1]?.id,
							},
							comparison_explainability: {
								first_missing_fields: list_missing_fields(compared_grants[0], [
									...COMPARISON_REQUIRED_FIELDS,
									"deadline_text",
									"deadline_iso",
								]),
								second_missing_fields: list_missing_fields(compared_grants[1], [
									...COMPARISON_REQUIRED_FIELDS,
									"deadline_text",
									"deadline_iso",
								]),
							},
							enrichment: {
								mode: enrichment_mode,
								enriched_grants: enrichment.enriched_count,
								pages_used: enrichment.pages_used,
								errors: enrichment.errors,
							},
							comparison: build_comparison_payload(
								compared_grants[0],
								compared_grants[1],
							),
						});
					} catch (error) {
						return tool_error("compare_grants", error);
					}
				},
			}),
			defineTool({
				name: "get_grant",
				description:
					"Returns one grant from the latest listed results or by explicit grant id/url, including the official opportunity link and optional detail enrichment.",
				inputSchema: {
					grant_ref: z.string().min(1),
					enrich_details: z.boolean().optional(),
				},
				function: async function (
					this: unknown,
					{
						grant_ref,
						enrich_details,
					}: {
						grant_ref: string;
						enrich_details?: boolean;
					},
				) {
					try {
						const agent = this as GrantsAgentRuntime;
						await ensure_refresh_schedule(agent);
						let budget_state = await get_budget_state(agent.ctx.storage);
						const snapshot = await get_snapshot(agent.ctx.storage);
						if (!snapshot) {
							return tool_success({
								message: "No cached grants available yet. Call refresh_grants first.",
								pages_remaining: budget_state.pages_remaining,
								budget: budget_payload(budget_state, 0),
							});
						}

						const last_listed_results = await get_last_listed_results(agent.ctx.storage);
						let grant = resolve_grant_reference(
							snapshot.grants,
							last_listed_results?.grant_ids ?? [],
							grant_ref,
						);
						const should_enrich =
							enrich_details !== false &&
							grant_needs_detail_enrichment(grant, [
								...COMPARISON_REQUIRED_FIELDS,
								"deadline_text",
								"deadline_iso",
							]);
						const enrichment = should_enrich
							? await enrich_grants(agent, [grant], { max_grants: 1 })
							: {
									grants: [grant],
									enriched_count: 0,
									errors: [] as string[],
									budget_state,
									pages_used: 0,
								};
						grant = enrichment.grants[0];
						budget_state = enrichment.budget_state;

						return tool_success({
							resolved_reference: {
								grant_ref,
								grant_id: grant.id,
							},
							budget: budget_payload(budget_state, enrichment.pages_used),
							field_coverage: summarize_field_coverage([grant]),
							enrichment: {
								mode: should_enrich ? "explicit" : "cache_only",
								enriched_grants: enrichment.enriched_count,
								pages_used: enrichment.pages_used,
								errors: enrichment.errors,
							},
							grant: grants_for_response([grant])[0],
						});
					} catch (error) {
						return tool_error("get_grant", error);
					}
				},
			}),
			defineTool({
				name: "get_grant_snapshot_meta",
				description:
					"Returns metadata and source health for the last grant snapshot refresh.",
				function: async function () {
					try {
						const agent = this as unknown as GrantsAgentRuntime;
						await ensure_refresh_schedule(agent);
						const budget_state = await get_budget_state(agent.ctx.storage);
						const snapshot = await get_snapshot(agent.ctx.storage);
						if (!snapshot) {
							return tool_success({
								message: "Snapshot is empty. Run refresh_grants to fetch data.",
								has_snapshot: false,
								pages_remaining: budget_state.pages_remaining,
								budget: budget_payload(budget_state, 0),
							});
						}
						const normalized_snapshot = with_snapshot_defaults(
							snapshot,
							budget_state,
						);

						return tool_success({
							has_snapshot: true,
							updated_at: normalized_snapshot.updated_at,
							fresh_until: normalized_snapshot.fresh_until,
							next_scheduled_refresh_at:
								normalized_snapshot.next_scheduled_refresh_at,
							last_refresh_mode: normalized_snapshot.last_refresh_mode,
							refresh_decision_reason:
								normalized_snapshot.refresh_decision_reason,
							stats: normalized_snapshot.stats,
							sources: normalized_snapshot.sources,
							errors: normalized_snapshot.errors,
							budget: normalized_snapshot.budget,
						});
					} catch (error) {
						return tool_error("get_grant_snapshot_meta", error);
					}
				},
			}),
		],
	});

export class GrantsResearchServer extends GrantsResearchBase {
	override async onStart(props?: Record<string, unknown>): Promise<void> {
		await super.onStart(props);
		await ensure_refresh_schedule(this as unknown as GrantsAgentRuntime);
	}

	async scheduled_refresh_tick(): Promise<void> {
		await refresh_snapshot(this as unknown as GrantsAgentRuntime, {
			mode: "scheduled",
			force: false,
			max_pages_per_source: 4,
		});
	}
}

export const grantsResearchData = {
	...grantsResearchDataBase,
	server: GrantsResearchServer as unknown as typeof McpAgent,
};

type RefreshSnapshotParams = {
	mode: RefreshMode;
	force: boolean;
	max_pages_per_source: number;
};

export async function refresh_snapshot(
	agent: GrantsAgentRuntime,
	{
		mode,
		force,
		max_pages_per_source,
	}: RefreshSnapshotParams,
): Promise<RefreshResult> {
	const budget_before = await get_budget_state(agent.ctx.storage);
	const snapshot_before_raw = await get_snapshot(agent.ctx.storage);
	const snapshot_before = snapshot_before_raw
		? with_snapshot_defaults(snapshot_before_raw, budget_before)
		: null;
	const preflight = evaluate_refresh_preflight({
		snapshot_before,
		budget_state: budget_before,
		force,
		max_pages_per_source,
		now_ms: Date.now(),
	});

	if (!preflight.should_refresh) {
		if (snapshot_before) {
			const snapshot = with_snapshot_defaults(
				snapshot_before,
				budget_before,
				preflight.reason,
			);
			return {
				snapshot,
				refreshed: false,
				message: preflight.message,
				decision_reason: preflight.reason,
				pages_used_this_refresh: 0,
			};
		}

		const empty_snapshot = create_empty_snapshot({
			mode,
			reason: preflight.reason,
			budget_state: budget_before,
			message: preflight.message,
		});
		return {
			snapshot: empty_snapshot,
			refreshed: false,
			message: preflight.message,
			decision_reason: preflight.reason,
			pages_used_this_refresh: 0,
		};
	}

	const lock_acquired = await try_acquire_refresh_lock(agent.ctx.storage, LOCK_TTL_MS);
	if (!lock_acquired) {
		const existing = await get_snapshot(agent.ctx.storage);
		const budget_now = await get_budget_state(agent.ctx.storage);
		if (existing) {
			const snapshot = with_snapshot_defaults(existing, budget_now);
			return {
				snapshot,
				refreshed: false,
				message: "Refresh skipped because another refresh is currently running.",
				decision_reason: snapshot.refresh_decision_reason ?? "fresh_cache",
				pages_used_this_refresh: 0,
			};
		}
		throw new Error("Refresh lock is held and no snapshot is available yet.");
	}

	let budget_reserved = false;
	try {
		const reserved_pages = await reserve_budget_pages(
			agent.ctx.storage,
			preflight.max_pages_this_run,
			LOCK_TTL_MS,
		);
		if (reserved_pages <= 0) {
			const reason: RefreshDecisionReason =
				budget_before.pages_remaining <= 0 ? "budget_exhausted" : "budget_low";
			const existing = await get_snapshot(agent.ctx.storage);
			if (existing) {
				const snapshot = with_snapshot_defaults(existing, budget_before, reason);
				return {
					snapshot,
					refreshed: false,
					message: "Skipped refresh because remaining page budget is too low.",
					decision_reason: reason,
					pages_used_this_refresh: 0,
				};
			}
			const empty_snapshot = create_empty_snapshot({
				mode,
				reason,
				budget_state: budget_before,
				message: "Skipped refresh because remaining page budget is too low.",
			});
			return {
				snapshot: empty_snapshot,
				refreshed: false,
				message: "Skipped refresh because remaining page budget is too low.",
				decision_reason: reason,
				pages_used_this_refresh: 0,
			};
		}
		budget_reserved = true;

		const firecrawl_api_key = get_firecrawl_api_key(agent.env);
		const firecrawl = new FirecrawlClient(firecrawl_api_key, {
			max_retries: 2,
			min_delay_ms: 700,
			jitter_ms: 350,
		});

		const now_iso = new Date().toISOString();
		const source_stats: SourceRefreshStats[] = [];
		const errors: string[] = [];
		const all_candidates: ReturnType<typeof extract_grant_candidates> = [];
		let total_pages = 0;
		let remaining_run_budget = reserved_pages;

		for (const source of GRANT_SOURCES) {
			if (remaining_run_budget <= 0) break;
			const started_at = Date.now();
			const usage_before = firecrawl.get_usage_snapshot();
			try {
				const page_limit =
					source.strategy === "scrape"
						? Math.min(1, remaining_run_budget)
						: Math.min(
								max_pages_per_source,
								ABSOLUTE_MAX_PAGES_PER_SOURCE,
								remaining_run_budget,
							);
				if (page_limit <= 0) break;

				const source_fetch = await fetch_source_pages(
					firecrawl,
					source,
					page_limit,
				);
				const usage_delta = firecrawl.get_usage_delta(usage_before);
				const pages = source_fetch.pages.slice(0, remaining_run_budget);
				const candidates = extract_grant_candidates(source, pages);
				const warning = collect_source_warning({
					fetch_warning: source_fetch.warning,
					candidates_count: candidates.length,
				});

				total_pages += pages.length;
				remaining_run_budget -= pages.length;
				all_candidates.push(...candidates);
				if (warning) errors.push(`Source ${source.id}: ${warning}`);
				source_stats.push({
					source_id: source.id,
					source_name: source.name,
					source_url: source.entry_url,
					strategy: source.strategy,
					pages_fetched: pages.length,
					candidates_extracted: candidates.length,
					subrequests_made: usage_delta.total_subrequests,
					poll_attempts: usage_delta.crawl_polls,
					duration_ms: Date.now() - started_at,
					status: "ok",
					warning,
				});
			} catch (error) {
				const error_message = error_to_string(error);
				const usage_delta = firecrawl.get_usage_delta(usage_before);
				errors.push(`Source ${source.id}: ${error_message}`);
				source_stats.push({
					source_id: source.id,
					source_name: source.name,
					source_url: source.entry_url,
					strategy: source.strategy,
					pages_fetched: 0,
					candidates_extracted: 0,
					subrequests_made: usage_delta.total_subrequests,
					poll_attempts: usage_delta.crawl_polls,
					duration_ms: Date.now() - started_at,
					status: "error",
					error: error_message,
				});
			}
		}

		const scored_grants = score_candidates(all_candidates, now_iso);
		const open_grants = scored_grants.filter(
			(grant) => grant.open_score >= DEFAULT_MIN_OPEN_SCORE,
		).length;
		const budget_after = await commit_budget_usage(agent.ctx.storage, {
			actual_pages_used: total_pages,
			refreshed_at_iso: now_iso,
			was_early_refresh: preflight.is_early_refresh,
		});
		budget_reserved = false;

		const snapshot: GrantSnapshot = {
			version: "1.0.0",
			updated_at: now_iso,
			fresh_until: compute_fresh_until(now_iso),
			next_scheduled_refresh_at: new Date(
				Date.now() + DEFAULT_REFRESH_INTERVAL_SECONDS * 1000,
			).toISOString(),
			last_refresh_mode: mode,
			refresh_decision_reason: preflight.reason,
			budget: budget_payload(budget_after, total_pages),
			stats: {
				total_sources: GRANT_SOURCES.length,
				total_pages: total_pages,
				total_candidates: all_candidates.length,
				total_grants: scored_grants.length,
				open_grants: open_grants,
			},
			sources: source_stats,
			grants: scored_grants,
			errors,
		};

		await save_snapshot(agent.ctx.storage, snapshot);
		return {
			snapshot,
			refreshed: true,
			message: `Refresh completed in ${mode} mode.`,
			decision_reason: preflight.reason,
			pages_used_this_refresh: total_pages,
		};
	} finally {
		if (budget_reserved) await release_budget_reservation(agent.ctx.storage);
		await release_refresh_lock(agent.ctx.storage);
	}
}

async function fetch_source_pages(
	firecrawl: FirecrawlClient,
	source: GrantSourceConfig,
	page_limit: number,
): Promise<{ pages: FirecrawlPage[]; warning?: string }> {
	if (source.strategy === "search") {
		const pages = await firecrawl.search_source(source, page_limit);
		return { pages };
	}

	if (source.strategy === "scrape") {
		const pages = await firecrawl.scrape_source(source);
		return { pages };
	}

	try {
		const pages = await firecrawl.crawl_source(source, page_limit);
		return { pages };
	} catch (error) {
		const fallback_pages = await firecrawl.scrape_source(source);
		return {
			pages: fallback_pages,
			warning: `Crawl failed and scrape fallback was used: ${error_to_string(error)}`,
		};
	}
}

function collect_source_warning({
	fetch_warning,
	candidates_count,
}: {
	fetch_warning?: string;
	candidates_count: number;
}): string | undefined {
	const warnings: string[] = [];
	if (fetch_warning) warnings.push(fetch_warning);
	if (candidates_count === 0) warnings.push("No grant candidates were extracted from this source.");
	return warnings.length > 0 ? warnings.join(" ") : undefined;
}

function required_fields_for_intents(
	intents: ReturnType<typeof filter_grants>["applied_filters"]["query_intents"],
): GrantSummaryField[] {
	const required = new Set<GrantSummaryField>();
	if (intents.amount_focus) required.add(REQUIRED_FIELD_BY_INTENT.amount_focus);
	if (intents.eligibility_focus) required.add(REQUIRED_FIELD_BY_INTENT.eligibility_focus);
	if (intents.scope_focus) required.add(REQUIRED_FIELD_BY_INTENT.scope_focus);
	return [...required];
}

function grants_for_response(grants: GrantRecord[]) {
	return grants.map((grant) => {
		const missing_fields = list_missing_fields(grant, [
			"amount_summary",
			"eligibility_summary",
			"scope_summary",
			"deadline_text",
			"deadline_iso",
		]);
		return {
			...grant,
			missing_fields,
			amount_summary_display: grant.amount_summary ?? "Unknown in cache (no detail evidence yet).",
			eligibility_summary_display:
				grant.eligibility_summary ?? "Unknown in cache (no detail evidence yet).",
			scope_summary_display: grant.scope_summary ?? "Unknown in cache (no detail evidence yet).",
			deadline_display:
				grant.deadline_text ??
				grant.deadline_iso ??
				"Unknown in cache (no deadline evidence yet).",
		};
	});
}

function summarize_field_coverage(grants: GrantRecord[]) {
	if (grants.length === 0) {
		return {
			total_grants: 0,
			with_amount_summary: 0,
			with_eligibility_summary: 0,
			with_scope_summary: 0,
			with_deadline: 0,
		};
	}
	return {
		total_grants: grants.length,
		with_amount_summary: grants.filter((grant) => has_non_empty_value(grant.amount_summary))
			.length,
		with_eligibility_summary: grants.filter((grant) =>
			has_non_empty_value(grant.eligibility_summary),
		).length,
		with_scope_summary: grants.filter((grant) => has_non_empty_value(grant.scope_summary))
			.length,
		with_deadline: grants.filter(
			(grant) =>
				has_non_empty_value(grant.deadline_text) ||
				has_non_empty_value(grant.deadline_iso),
		).length,
	};
}

function list_missing_fields(
	grant: GrantRecord,
	fields: readonly GrantSummaryField[],
): GrantSummaryField[] {
	const has_deadline = has_non_empty_value(grant.deadline_text) || has_non_empty_value(grant.deadline_iso);
	return fields.filter((field) => {
		if (field === "deadline_text" || field === "deadline_iso") return !has_deadline;
		return !has_non_empty_value(grant[field]);
	});
}

function has_non_empty_value(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}


function with_snapshot_defaults(
	snapshot: GrantSnapshot,
	budget_state: BudgetState,
	override_reason?: RefreshDecisionReason,
): GrantSnapshot {
	return {
		...snapshot,
		fresh_until: snapshot.fresh_until ?? compute_fresh_until(snapshot.updated_at),
		refresh_decision_reason:
			override_reason ?? snapshot.refresh_decision_reason ?? "monthly_refresh",
		budget: budget_payload(
			budget_state,
			snapshot.budget?.pages_used_this_refresh ?? snapshot.stats.total_pages,
		),
	};
}

function budget_payload(budget_state: BudgetState, pages_used_this_refresh: number) {
	return {
		total_pages_cap: budget_state.total_pages_cap,
		pages_used_total: budget_state.pages_used_total,
		pages_remaining: budget_state.pages_remaining,
		pages_used_this_refresh: Math.max(0, pages_used_this_refresh),
	};
}

function create_empty_snapshot({
	mode,
	reason,
	budget_state,
	message,
}: {
	mode: RefreshMode;
	reason: RefreshDecisionReason;
	budget_state: BudgetState;
	message: string;
}): GrantSnapshot {
	const now_iso = new Date().toISOString();
	return {
		version: "1.0.0",
		updated_at: now_iso,
		fresh_until: compute_fresh_until(now_iso),
		next_scheduled_refresh_at: new Date(
			Date.now() + DEFAULT_REFRESH_INTERVAL_SECONDS * 1000,
		).toISOString(),
		last_refresh_mode: mode,
		refresh_decision_reason: reason,
		budget: budget_payload(budget_state, 0),
		stats: {
			total_sources: GRANT_SOURCES.length,
			total_pages: 0,
			total_candidates: 0,
			total_grants: 0,
			open_grants: 0,
		},
		sources: [],
		grants: [],
		errors: [message],
	};
}

function compute_fresh_until(updated_at_iso: string): string {
	const updated_at = new Date(updated_at_iso).getTime();
	const baseline = Number.isNaN(updated_at) ? Date.now() : updated_at;
	return new Date(baseline + SNAPSHOT_MONTHLY_TTL_MS).toISOString();
}


async function ensure_refresh_schedule(agent: GrantsAgentRuntime): Promise<void> {
	const schedules = agent.getSchedules({ type: "interval" });
	const existing_matching = schedules.find(
		(schedule) => schedule.callback === SCHEDULE_CALLBACK_NAME,
	);
	if (existing_matching) {
		await save_schedule_id(agent.ctx.storage, existing_matching.id);
		return;
	}

	const known_schedule_id = await get_schedule_id(agent.ctx.storage);
	if (known_schedule_id) await agent.cancelSchedule(known_schedule_id);

	const created = await agent.scheduleEvery(
		DEFAULT_REFRESH_INTERVAL_SECONDS,
		SCHEDULE_CALLBACK_NAME,
	);
	await save_schedule_id(agent.ctx.storage, created.id);
}

async function enrich_grants(
	agent: GrantsAgentRuntime,
	grants: GrantRecord[],
	options?: {
		max_grants?: number;
		required_fields?: readonly GrantSummaryField[];
	},
): Promise<{
	grants: GrantRecord[];
	enriched_count: number;
	errors: string[];
	budget_state: BudgetState;
	pages_used: number;
}> {
	let budget_state = await get_budget_state(agent.ctx.storage);
	const capped_grants = grants.slice(0, Math.max(1, options?.max_grants ?? grants.length));
	const pending_grants = capped_grants.filter((grant) => {
		const still_needs_details = grant_needs_detail_enrichment(
			grant,
			options?.required_fields,
		);
		if (!still_needs_details) return false;
		if (!grant.detail_enriched_at) return true;
		return still_needs_details;
	});
	if (pending_grants.length === 0) {
		return {
			grants,
			enriched_count: 0,
			errors: [],
			budget_state,
			pages_used: 0,
		};
	}

	let firecrawl: FirecrawlClient;
	try {
		firecrawl = create_firecrawl_client(agent.env);
	} catch (error) {
		return {
			grants,
			enriched_count: 0,
			errors: [`Detail enrichment unavailable: ${error_to_string(error)}`],
			budget_state,
			pages_used: 0,
		};
	}

	const reserved_pages = await reserve_budget_pages(agent.ctx.storage, pending_grants.length);
	if (reserved_pages <= 0) {
		return {
			grants,
			enriched_count: 0,
			errors: ["Detail enrichment skipped because the remaining page budget is too low."],
			budget_state,
			pages_used: 0,
		};
	}
	const updated_grants = new Map(grants.map((grant) => [grant.id, grant]));
	const merged_snapshot_grants: GrantRecord[] = [];
	const errors: string[] = [];
	const now_iso = new Date().toISOString();
	let pages_used = 0;
	let budget_reserved = true;

	try {
		/* eslint-disable no-await-in-loop */
		for (const grant of pending_grants.slice(0, reserved_pages)) {
			try {
				const page = await firecrawl.scrape_url(grant.url, grant.source_url, 1200);
				pages_used++;
				const details = extract_grant_detail_summaries(page.markdown);
				const merged_grant = {
					...grant,
					deadline_text: details.deadline_text ?? grant.deadline_text,
					deadline_iso: details.deadline_iso ?? grant.deadline_iso,
					amount_summary: details.amount_summary ?? grant.amount_summary,
					eligibility_summary:
						details.eligibility_summary ?? grant.eligibility_summary,
					scope_summary: details.scope_summary ?? grant.scope_summary,
					detail_enriched_at: now_iso,
				} satisfies GrantRecord;
				updated_grants.set(merged_grant.id, merged_grant);
				merged_snapshot_grants.push(merged_grant);
			} catch (error) {
				errors.push(`Grant ${grant.id}: ${error_to_string(error)}`);
			}
		}
		/* eslint-enable no-await-in-loop */

		if (pages_used > 0) {
			budget_state = await commit_budget_usage(agent.ctx.storage, {
				actual_pages_used: pages_used,
				refreshed_at_iso: now_iso,
				was_early_refresh: false,
				count_as_refresh: false,
			});
		} else {
			await release_budget_reservation(agent.ctx.storage);
		}
		budget_reserved = false;
		if (merged_snapshot_grants.length > 0) {
			await merge_grants_into_snapshot(agent.ctx.storage, merged_snapshot_grants);
		}

		return {
			grants: grants.map((grant) => updated_grants.get(grant.id) ?? grant),
			enriched_count: merged_snapshot_grants.length,
			errors,
			budget_state,
			pages_used,
		};
	} finally {
		if (budget_reserved) await release_budget_reservation(agent.ctx.storage);
	}
}

function create_firecrawl_client(env: Env): FirecrawlClient {
	return new FirecrawlClient(get_firecrawl_api_key(env), {
		max_retries: 2,
		min_delay_ms: 700,
		jitter_ms: 350,
	});
}

function get_firecrawl_api_key(env: Env): string {
	const maybe_key = (env as unknown as Record<string, unknown>).FIRECRAWL_API_KEY;
	if (typeof maybe_key !== "string" || maybe_key.trim().length === 0) {
		throw new Error(
			"Missing FIRECRAWL_API_KEY. Set it with `wrangler secret put FIRECRAWL_API_KEY`.",
		);
	}
	return maybe_key.trim();
}

function error_to_string(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "Unknown error";
}

function tool_error(tool_name: string, error: unknown) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(
					{
						error: `Tool ${tool_name} failed`,
						details: error_to_string(error),
					},
					null,
					2,
				),
			},
		],
		isError: true,
	};
}

function tool_success(payload: unknown) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(payload, null, 2),
			},
		],
	};
}
