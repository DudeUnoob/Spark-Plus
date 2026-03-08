import { z } from "zod";
import { defineAgent, defineTool } from "../../shared/agent-creator";
import { MCPResponse } from "../../shared/types";

const zodOperation = z.enum(["add", "subtract", "multiply", "divide"]);
type Operation = z.infer<typeof zodOperation>;

async function calculate(
	operation: Operation,
	a: number,
	b: number,
): MCPResponse<"text"> {
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
}

export const { AgentClass: BasicTester, metadata } = defineAgent({
	name: "Basic Tester",
	version: "1.0.0",
	binding: "basic",
	url_prefix: "/basic-tester",
	tools: [
		defineTool({
			name: "add",
			inputSchema: { a: z.number(), b: z.number() },
			function: async ({ a, b }) => ({
				content: [{ type: "text", text: String(a + b) }],
			}),
		}),
		defineTool({
			name: "subtract",
			inputSchema: { a: z.number(), b: z.number() },
			function: async ({ a, b }) => ({
				content: [{ type: "text", text: String(a - b) }],
			}),
		}),
		defineTool({
			name: "calculate",
			inputSchema: {
				operation: zodOperation,
				a: z.number(),
				b: z.number(),
			},
			function: ({ operation, a, b }) => calculate(operation, a, b),
		}),
	],
});
