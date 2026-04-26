# Copilot instructions for this repository

## Build and validation commands

Use the npm scripts in `package.json`:

- `npm install`
- `npm run typecheck` — strict TypeScript check with `tsc --noEmit`
- `npm run build` — builds all distributable artifacts into `dist/`
- `npm run build:runtime` — rebuild only the shared CommonJS runtime
- `npm run build:extension` — rebuild only the Copilot extension entrypoint
- `npm run build:mcp` — rebuild only the stdio MCP server bundle
- `npm run build:cli` — rebuild only the package CLI
- `npm run build:assets` — copy `assets/SKILL.md` and the SQLite wasm asset into `dist/`

There is currently no dedicated `test` or `lint` script in this package, so there is no repo-specific single-test command to run.

## High-level architecture

This package ships the same database-explorer behavior through two surfaces: a Copilot CLI extension and a standalone MCP server.

- `src/core.ts` is now an orchestration layer. It defines the shared tool schemas, parses arguments, resolves config files, expands `${ENV_VAR}` placeholders in YAML, and dispatches each request through a driver adapter.
- `src/drivers/types.ts` defines the shared contracts for profiles, tool args, result types, and the `DatabaseDriverAdapter` interface.
- `src/drivers/mysql.ts`, `src/drivers/postgres.ts`, and `src/drivers/sqlite.ts` implement the strategy pattern. Each adapter owns connection management and driver-specific behavior for the entire tool surface, including connection probes, search, explain, stats, and schema inspection.
- `src/drivers/shared.ts` contains cross-driver SQL safety and normalization helpers such as identifier validation, SELECT-only guards, result normalization, and search-pattern escaping.
- `src/runtime.ts` adapts the shared definitions into the Copilot extension tool format. It also wraps every tool call so success and failure responses are returned as JSON text for the LLM.
- `src/extension.ts` is the Copilot extension entrypoint. It loads the bundled `SKILL.md`, tracks the active session `cwd`, injects startup context for new sessions, and injects extra database-explorer guidance only when the prompt matches the database-related keyword regex from `core.ts`.
- `src/mcp.ts` exposes the same shared tool definitions as a stdio MCP server. It converts the repo's custom `ToolParameterDefinition` objects into Zod schemas for `@modelcontextprotocol/sdk`.
- `src/cli.ts` is the package entrypoint used by `npx`. `install` copies the built extension artifacts into a target repo under `.github/extensions/database-explorer/`; `mcp` dynamically loads `dist/mcp.cjs` and starts the server against a chosen working directory.
- `scripts/copy-assets.mjs` is part of the build pipeline; it copies both `assets/SKILL.md` and `node_modules/sql.js/dist/sql-wasm.wasm` into `dist/` so the installed extension ships its prompt guidance and SQLite runtime asset alongside the code.

The shipped extension is artifact-based, not source-based. `npm run build` must produce the files in `dist/` before `install`, `prepack`, or local CLI testing will work.

## Key conventions

- Keep tool registration centralized in `src/core.ts`, but put driver-specific SQL and connection handling into the adapter modules under `src/drivers/`. Do not reintroduce driver switches across the codebase.
- Tool schemas use the local `ToolParameterDefinition` format first, then each surface adapts from that. Avoid defining one-off input schemas directly in `src/runtime.ts` or `src/mcp.ts`.
- Config resolution order is intentional: explicit `configPath` argument -> provided `defaultConfigPath` -> upward search for `.github/database-explorer/database-config.yaml` starting from the current session/project `cwd`.
- Supported drivers are normalized in `normalizeProfile()`: MySQL is the default, PostgreSQL accepts `postgres` / `postgresql` / `pg`, and SQLite accepts `sqlite` / `sqlite3`. SQLite file paths are resolved relative to the config file location, not the process cwd.
- Query safety is enforced in shared helpers, not just docs: `prepareReadOnlyQuery()` accepts only a single `SELECT` statement and appends `LIMIT 10` when the caller does not provide one; `prepareExplainQuery()` enforces the same SELECT-only rule without rewriting the SQL.
- Table names and schema/namespace names are treated as identifiers, not free-form SQL. `validateIdentifier()` only accepts `[A-Za-z0-9_]+`, and callers use driver-specific quoting helpers before interpolating names into SQL.
- Result formatting is deliberately consistent across both surfaces: driver adapters return JSON-safe shapes, and cross-driver normalization lives in `src/drivers/shared.ts`.
- The shared tool surface now includes focused discovery tools (`find_table`, `find_column`, `list_columns`, `list_indexes`, `list_foreign_keys`), diagnostics (`test_connection`, `health_check`, `table_stats`), and planning aids (`explain_query`). When adding future capabilities, extend the adapter interface and register the new shared definition once in `src/core.ts`.
- The installer only manages `SKILL.md`, `extension.mjs`, `runtime.cjs`, and `sql-wasm.wasm` inside `.github/extensions/database-explorer/`. `src/cli.ts` refuses to overwrite extra files in that directory unless `--force` is passed.
