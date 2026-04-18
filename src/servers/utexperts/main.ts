import { z } from "zod";
import { defineMcpServer, defineTool } from "../../shared/mcp-server-creator";
import { searchUTExperts } from "./utexas-experts-fetch.mjs";

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
					},
				) {
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
