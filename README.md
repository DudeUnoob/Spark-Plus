# Spark Plus

A **collection of multiple separate but related MCP servers** on Cloudflare Workers for UT's AI Spark system. Each server runs as a Durable Object with its own tools and URL path, so it is treated as a separate MCP server for all intents and purposes.

## What’s in this repo

- **Servers** – MCP servers defined with `defineMcpServer` / `defineTool`, each bound to a Durable Object and a route.
- **Shared** –  All shared funcionality between servers.`src/shared/mcp-server-creator.ts` is where the `defineMcpServer` function which is how all servers are created.

## Quick start

```bash
npm install
npm run dev
```

The Worker runs at `http://localhost:8787`. Each MCP server is served at its path (e.g. `http://localhost:8787/basic-tester`, `http://localhost:8787/other`).

## Deploy

```bash
npm run deploy
```

Uses the `spark-plus` Worker name in `wrangler.jsonc`. After deploy, server URLs are `https://spark-plus.<your-subdomain>.workers.dev/<server-path>`.

## Adding a server

1. **Implement the server** in `src/servers/<name>/main.ts` using `defineMcpServer` and `defineTool` from `src/shared/mcp-server-creator.ts`.
2. **Register the Durable Object** in `wrangler.jsonc`: add a migration for the new class and a binding in `durable_objects.bindings`.
3. **Wire the route** in `src/project-source.ts`: import the server class and its metadata, add the metadata to the `MCP_SERVERS` array, and export the class in the `export { ... }` at the bottom.

The request handler in `src/project-source.ts` matches the request path to each server’s `url_prefix` and forwards to that server.

## Testing with MCP Inspector

This project uses **Streamable HTTP**, not stdio:

1. Run `npm run dev` so the Worker is at `http://localhost:8787`.
2. Run `npx @modelcontextprotocol/inspector@latest` and open the URL it prints.
3. In the Inspector, choose **“Enter URL”** (do not use “Run command (stdio)”).
4. Enter a server URL, e.g. `http://localhost:8787/basic-tester`, then Connect and List tools.

## Scripts

| Command              | Purpose                                       |
| -------------------- | --------------------------------------------- |
| `npm run dev`        | Local development                             |
| `npm run cf-typegen` | Regenerate Worker types after binding changes |
| `npm run type-check` | TypeScript check                              |
| `npm run lint`       | Lint; `npm run lint:fix` to fix               |

For Cloudflare Workers and product limits, see [AGENTS.md](./AGENTS.md).
