import type { FirecrawlPage, GrantSourceConfig } from "./types";

type FirecrawlClientOptions = {
	base_url?: string;
	max_retries?: number;
	min_delay_ms?: number;
	jitter_ms?: number;
	poll_interval_ms?: number;
	max_poll_attempts?: number;
};

type ScrapeResponse = {
	success?: boolean;
	data?: {
		markdown?: string;
		links?: string[];
		metadata?: {
			title?: string;
			url?: string;
			sourceURL?: string;
			statusCode?: number;
		};
		warning?: string;
	};
};

type CrawlStartResponse = {
	success?: boolean;
	id?: string;
};

type CrawlStatusResponse = {
	status?: string;
	data?: Array<{
		markdown?: string;
		links?: string[];
		metadata?: {
			title?: string;
			url?: string;
			sourceURL?: string;
			statusCode?: number;
		};
		warning?: string;
	}>;
};

type SearchResponse = {
	success?: boolean;
	data?: {
		web?: Array<{
			url?: string;
			title?: string;
			description?: string;
			markdown?: string;
			links?: string[];
			metadata?: {
				title?: string;
				url?: string;
				sourceURL?: string;
				statusCode?: number;
			};
			warning?: string;
		}>;
	};
};

type FirecrawlUsageSnapshot = {
	total_subrequests: number;
	crawl_polls: number;
};

const DEFAULT_OPTIONS: Required<FirecrawlClientOptions> = {
	base_url: "https://api.firecrawl.dev/v2",
	max_retries: 2,
	min_delay_ms: 600,
	jitter_ms: 250,
	poll_interval_ms: 2000,
	max_poll_attempts: 6,
};

export class FirecrawlClient {
	private readonly api_key: string;
	private readonly options: Required<FirecrawlClientOptions>;
	private readonly last_request_by_domain = new Map<string, number>();
	private readonly usage = {
		total_subrequests: 0,
		crawl_polls: 0,
	};

	constructor(api_key: string, options?: FirecrawlClientOptions) {
		this.api_key = api_key;
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	async scrape_source(source: GrantSourceConfig): Promise<FirecrawlPage[]> {
		const page = await this.scrape_url(
			source.entry_url,
			source.base_url,
			source.scrape_options?.wait_for_ms ?? 750,
		);
		return [page];
	}

	async scrape_url(
		url: string,
		source_url?: string,
		wait_for_ms = 750,
	): Promise<FirecrawlPage> {
		await this.wait_for_domain_slot(url);
		const payload = {
			url,
			formats: ["markdown", "links"],
			onlyMainContent: true,
			waitFor: wait_for_ms,
			timeout: 30000,
			blockAds: true,
			proxy: "auto",
			maxAge: 1000 * 60 * 60 * 12,
		};

		const response = await this.request_json<ScrapeResponse>("/scrape", {
			method: "POST",
			body: JSON.stringify(payload),
		});

		if (!response.success || !response.data?.markdown) {
			throw new Error(`Scrape failed for ${url}`);
		}

		return this.to_page(response.data, source_url ?? url);
	}

	async search_source(
		source: GrantSourceConfig,
		max_pages_per_source: number,
	): Promise<FirecrawlPage[]> {
		if (!source.search?.query) {
			throw new Error(`Search query missing for ${source.id}`);
		}
		await this.wait_for_domain_slot(source.base_url);
		const effective_limit = Math.max(
			1,
			Math.min(max_pages_per_source, source.search.limit ?? max_pages_per_source),
		);
		const response = await this.request_json<SearchResponse>("/search", {
			method: "POST",
			body: JSON.stringify({
				query: source.search.query,
				limit: effective_limit,
				tbs: source.search.tbs,
				scrapeOptions: {
					formats: ["markdown", "links"],
					onlyMainContent: true,
					timeout: 30000,
					waitFor: source.scrape_options?.wait_for_ms ?? 750,
					blockAds: true,
					proxy: "auto",
					maxAge: 1000 * 60 * 60 * 12,
				},
			}),
		});
		const pages = (response.data?.web ?? [])
			.filter((item) => Boolean(item.markdown))
			.map((item) => this.to_page(item, source.entry_url));
		if (pages.length === 0) {
			throw new Error(`Search returned no scraped grant pages for ${source.entry_url}`);
		}
		return pages;
	}

	async crawl_source(
		source: GrantSourceConfig,
		max_pages_per_source: number,
	): Promise<FirecrawlPage[]> {
		await this.wait_for_domain_slot(source.base_url);
		const effective_limit = Math.max(
			1,
			Math.min(max_pages_per_source, source.crawl?.limit ?? max_pages_per_source),
		);
		const crawl_payload = {
			url: source.entry_url,
			limit: effective_limit,
			includePaths: source.crawl?.include_paths,
			excludePaths: source.crawl?.exclude_paths,
			maxDiscoveryDepth: source.crawl?.max_discovery_depth ?? 1,
			delay: source.crawl?.delay_seconds ?? 1,
			maxConcurrency: source.crawl?.max_concurrency ?? 1,
			crawlEntireDomain: false,
			allowExternalLinks: false,
			allowSubdomains: false,
			scrapeOptions: {
				formats: ["markdown", "links"],
				onlyMainContent: true,
				timeout: 30000,
				waitFor: source.scrape_options?.wait_for_ms ?? 750,
				blockAds: true,
				proxy: "auto",
				maxAge: 1000 * 60 * 60 * 12,
			},
		};

		const start = await this.request_json<CrawlStartResponse>("/crawl", {
			method: "POST",
			body: JSON.stringify(crawl_payload),
		});

		if (!start.success || !start.id) {
			throw new Error(`Crawl start failed for ${source.entry_url}`);
		}

		for (let attempt = 0; attempt < this.options.max_poll_attempts; attempt++) {
			await sleep(this.options.poll_interval_ms);
			const status = await this.request_json<CrawlStatusResponse>(
				`/crawl/${start.id}`,
				{ method: "GET" },
			);

			if (status.status === "failed") {
				throw new Error(`Crawl failed for ${source.entry_url}`);
			}

			if (status.status !== "completed") continue;
			const pages = (status.data ?? [])
				.filter((item) => Boolean(item.markdown))
				.map((item) => this.to_page(item, source.entry_url));
			if (pages.length === 0) {
				throw new Error(`Crawl completed with no markdown pages for ${source.entry_url}`);
			}
			return pages;
		}

		throw new Error(
			`Crawl timed out for ${source.entry_url} after ${this.options.max_poll_attempts} polls`,
		);
	}

	get_usage_snapshot(): FirecrawlUsageSnapshot {
		return { ...this.usage };
	}

	get_usage_delta(before: FirecrawlUsageSnapshot): FirecrawlUsageSnapshot {
		return {
			total_subrequests: this.usage.total_subrequests - before.total_subrequests,
			crawl_polls: this.usage.crawl_polls - before.crawl_polls,
		};
	}

	private async request_json<T>(
		path: string,
		init: { method: "GET" | "POST"; body?: string },
	): Promise<T> {
		let attempt = 0;
		while (true) {
			try {
				this.record_request(path, init.method);
				const response = await fetch(`${this.options.base_url}${path}`, {
					method: init.method,
					headers: {
						Authorization: `Bearer ${this.api_key}`,
						"Content-Type": "application/json",
					},
					body: init.body,
				});

				if (response.ok) return (await response.json()) as T;

				const retryable = response.status === 429 || response.status >= 500;
				if (retryable && attempt < this.options.max_retries) {
					attempt++;
					await sleep(retry_backoff_ms(attempt));
					continue;
				}

				const body_text = await response.text();
				throw new Error(
					`Firecrawl request failed (${response.status}): ${body_text.slice(0, 240)}`,
				);
			} catch (error) {
				if (attempt >= this.options.max_retries) throw error;
				attempt++;
				await sleep(retry_backoff_ms(attempt));
			}
		}
	}

	private record_request(path: string, method: "GET" | "POST"): void {
		this.usage.total_subrequests++;
		if (method === "GET" && path.startsWith("/crawl/")) {
			this.usage.crawl_polls++;
		}
	}

	private async wait_for_domain_slot(url: string): Promise<void> {
		const domain = new URL(url).hostname.toLowerCase();
		const now = Date.now();
		const min_wait =
			this.options.min_delay_ms + Math.floor(Math.random() * this.options.jitter_ms);
		const next_allowed = (this.last_request_by_domain.get(domain) ?? 0) + min_wait;
		if (next_allowed > now) await sleep(next_allowed - now);
		this.last_request_by_domain.set(domain, Date.now());
	}

	private to_page(
		item: {
			markdown?: string;
			links?: string[];
			metadata?: {
				title?: string;
				url?: string;
				sourceURL?: string;
				statusCode?: number;
			};
			warning?: string;
		},
		source_url: string,
	): FirecrawlPage {
		const metadata = item.metadata ?? {};
		return {
			url: metadata.url ?? metadata.sourceURL ?? source_url,
			source_url: metadata.sourceURL ?? source_url,
			title: metadata.title,
			markdown: item.markdown ?? "",
			links: item.links ?? [],
			status_code: metadata.statusCode,
			warning: item.warning,
			raw: item,
		};
	}
}

function retry_backoff_ms(attempt: number): number {
	return 500 * 2 ** Math.max(0, attempt - 1);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
