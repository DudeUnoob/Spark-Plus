import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { test } from "./pcl-parsing.js";

async function queryLibCal() {
	return test();
	// const response = await fetch(
	// 	`https://libcal.lib.utexas.edu/spaces?lid=16542&gid=35011`,
	// );
	// const text = await response.text();
	// return text;
}

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Authless Calculator",
		version: "1.0.0",
	});

	async init() {
		// Simple addition tool
		this.server.tool("queryLibCal", {}, async () => {
			const data = await queryLibCal();
			return {
				content: [{ type: "text", text: JSON.stringify(data) }],
			};
		});

		this.server.tool(
			"add",
			{ a: z.number(), b: z.number() },
			async ({ a, b }) => ({
				content: [{ type: "text", text: String(a + b) }],
			}),
		);

		// Calculator tool with multiple operations
		this.server.tool(
			"calculate",
			{
				operation: z.enum(["add", "subtract", "multiply", "divide"]),
				a: z.number(),
				b: z.number(),
			},
			async ({ operation, a, b }) => {
				let result: number;
				switch (operation) {
					case "add":
						result = a + b;
						break;
					case "subtract":
						result = a - b;
						break;
					case "multiply":
						result = a * b;
						break;
					case "divide":
						if (b === 0)
							return {
								content: [
									{
										type: "text",
										text: "Error: Cannot divide by zero",
									},
								],
							};
						result = a / b;
						break;
				}
				return { content: [{ type: "text", text: String(result) }] };
			},
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			// Some MCP clients (and the Inspector proxy) may probe the endpoint with a GET
			// before a session is established. Treat "GET without session" as unsupported.
			if (
				request.method === "GET" &&
				!request.headers.get("mcp-session-id") &&
				!request.headers.get("Mcp-Session-Id")
			) {
				return new Response("Method Not Allowed", { status: 405 });
			}
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
