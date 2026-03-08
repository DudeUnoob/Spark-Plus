import { z } from "zod";
import { defineMcpServer, defineTool } from "../../shared/mcp-server-creator";

function calculate(
	operation: "add" | "subtract" | "multiply" | "divide",
	a: number,
	b: number,
): string {
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
			if (b === 0) return "Error: Cannot divide by zero";
			result = a / b;
			break;
	}
	return String(result);
}

export const { McpServerClass: BasicTester, metadata: basicTesterData } =
	defineMcpServer({
		name: "Basic Tester",
		version: "1.0.0",
		binding: "basic",
		url_prefix: "/basic-tester",
		tools: [
			defineTool({
				name: "add",
				inputSchema: { a: z.number(), b: z.number() },
				function: ({ a, b }) => ({
					content: [{ type: "text", text: String(a + b) }],
				}),
			}),
			defineTool({
				name: "subtract",
				inputSchema: { a: z.number(), b: z.number() },
				function: ({ a, b }) => ({
					content: [{ type: "text", text: String(a - b) }],
				}),
			}),
			defineTool({
				name: "calculate",
				inputSchema: {
					operation: z.enum(["add", "subtract", "multiply", "divide"]),
					a: z.number(),
					b: z.number(),
				},
				function: ({ operation, a, b }) => ({
					content: [{ type: "text", text: calculate(operation, a, b) }],
				}),
			}),
		],
	});
