// shared/classes.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	AnySchema,
	ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { McpAgent } from "agents/mcp";
import type {
	AgentMetadata,
	RegisterToolDefinition,
	RegisterToolDefinitionFunction,
	Version,
} from "./types";

/**
 * All the things required for an agent. Tools holds all the real functionality of the agent.
 */
type AgentConfig = {
	name: string;
	version: Version;
	binding: string;
	url_prefix: string;
	tools: RegisterToolDefinition<any, any>[];
};

/**
 * Creates a wrapper around `McpAgent` that defines an agent with a server and tools.
 *
 * Notes
 * -----
 * The returned class is always named `AgentClass`. Cloudflare requires agents to
 * have unique exported names, so when destructuring the result you should rename
 * the class to something descriptive.
 *
 * Example:
 * ```ts
 * const { AgentClass: MyAgent, metadata } = createAgent(config);
 * ```
 *
 * @param config Configuration for the agent.
 * Includes:
 * - `name` – agent name
 * - `version` – agent version
 * - `binding` – Cloudflare binding
 * - `url_prefix` – route prefix
 * - `tools` – array of tools created with `defineTool`
 *
 * @returns Object containing:
 * - `AgentClass` – the generated agent class
 * - `metadata` – associated metadata for the agent
 */
export function defineAgent(config: AgentConfig) {
	const AgentClass = class extends McpAgent {
		server = new McpServer({
			name: config.name,
			version: config.version,
		});

		async init() {
			for (const tool of config.tools) {
				this.server.registerTool(tool.name, tool.config, tool.cb);
			}
		}
	};

	const metadata: AgentMetadata = {
		title: config.name,
		version: config.version,
		binding: config.binding,
		url_prefix: config.url_prefix,
		server: AgentClass as unknown as typeof McpAgent,
	};

	return { AgentClass, metadata };
}

/**
 * Helper for defining MCP tools with improved type inference.
 *
 * This function wraps a `RegisterToolDefinitionFunction` and converts it into a
 * `RegisterToolDefinition`. It preserves strong typing for the tool's input and
 * output schemas while normalizing the structure expected by the MCP runtime.
 *
 * In particular, it:
 * - Infers input/output argument types from the provided schemas
 * - Maps the tool definition fields into the `{ name, config, cb }` format
 * - Returns a correctly typed `RegisterToolDefinition`
 *
 * @param def Tool definition describing the tool's metadata, schemas, and handler.
 *
 * @returns A normalized `RegisterToolDefinition` object suitable for agent
 * registration.
 */
export function defineTool<
	OutputArgs extends ZodRawShapeCompat | AnySchema,
	InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(def: RegisterToolDefinitionFunction<OutputArgs, InputArgs>) {
	return {
		name: def.name,
		config: {
			title: def.title,
			description: def.description,
			inputSchema: def.inputSchema,
			outputSchema: def.outputSchema,
			annotations: def.annotations,
			_meta: def._meta,
		},
		cb: def.function,
	} as RegisterToolDefinition<OutputArgs, InputArgs>;
}
