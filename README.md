# copilot-extension-database-explorer

Standalone npm package for:

1. installing the `database-explorer` Copilot CLI extension into a target project
2. running the same database explorer as an MCP server

Supported database drivers: MySQL, PostgreSQL, and SQLite.

## Exposed tools

The extension and MCP server expose the same shared tool surface:

- `database_explorer_list_databases`
- `database_explorer_health_check`
- `database_explorer_list_schemas`
- `database_explorer_list_tables`
- `database_explorer_find_table`
- `database_explorer_find_column`
- `database_explorer_list_columns`
- `database_explorer_describe_table`
- `database_explorer_sample_rows`
- `database_explorer_query`
- `database_explorer_explain_query`
- `database_explorer_table_stats`
- `database_explorer_list_indexes`
- `database_explorer_list_foreign_keys`
- `database_explorer_export_schema`

## Install into a project

From the target project root:

```bash
npx copilot-extension-database-explorer install
```

Or install into another directory:

```bash
npx copilot-extension-database-explorer install --target /path/to/project
```

Install into Copilot CLI user-level extensions (`~/.copilot/extensions/database-explorer`):

```bash
npx copilot-extension-database-explorer install --user
```

`--global` is accepted as an alias for `--user`.

## Run directly from GitHub

The repository is set up so `npx` can execute it straight from GitHub without committing `dist/`:

```bash
npx github:dspo/copilot-extension-database-explorer --help
npx github:dspo/copilot-extension-database-explorer install
npx github:dspo/copilot-extension-database-explorer install --user
```

This relies on the package `prepare` script to build `dist/` during Git-based installs.

The installer writes only these files into the target project:

```text
.github/extensions/database-explorer/
  SKILL.md
  extension.mjs
  runtime.cjs
  sql-wasm.wasm
```

## Run as an MCP server

Start the stdio MCP server from a project root:

```bash
npx -y copilot-extension-database-explorer mcp --cwd /path/to/project
```

If you want the server to use default config JSON for all tool calls, pass `--config`:

```bash
npx -y copilot-extension-database-explorer mcp \
  --cwd /path/to/project \
  --config '[{"name":"postgres_app","driver":"postgres","host":"127.0.0.1","port":5432,"username":"${PGUSER}","password":"${PGPASSWORD}","database":"app_db","schema":"public"}]'
```

### Generic MCP JSON

```json
{
  "mcpServers": {
    "database-explorer": {
      "command": "npx",
      "args": [
        "-y",
        "copilot-extension-database-explorer",
        "mcp",
        "--cwd",
        "/path/to/project"
      ]
    }
  }
}
```

### Claude Desktop

```json
{
  "mcpServers": {
    "database-explorer": {
      "command": "npx",
      "args": [
        "-y",
        "copilot-extension-database-explorer",
        "mcp",
        "--cwd",
        "/path/to/project"
      ]
    }
  }
}
```

### Cursor

```json
{
  "mcpServers": {
    "database-explorer": {
      "command": "npx",
      "args": [
        "-y",
        "copilot-extension-database-explorer",
        "mcp",
        "--cwd",
        "/path/to/project"
      ]
    }
  }
}
```

## Configuration

Both the installed Copilot extension and the MCP server use `config` JSON text (no config-file path input on tools).

The `config` field accepts either:

1. one profile object
2. an array of profile objects (each with `name`)

Supported `driver` values:

- `mysql` (default when omitted)
- `postgres`, `postgresql`, or `pg`
- `sqlite` or `sqlite3`

Example `config` JSON (single profile object):

```json
{
  "name": "postgres_app",
  "driver": "postgres",
  "host": "127.0.0.1",
  "port": 5432,
  "username": "${PGUSER}",
  "password": "${PGPASSWORD}",
  "database": "app_db",
  "schema": "public"
}
```

Example `config` JSON (array form):

```json
[
  {
    "name": "mysql_app",
    "driver": "mysql",
    "host": "127.0.0.1",
    "port": 3306,
    "username": "${MYSQL_USER}",
    "password": "${MYSQL_PASSWORD}",
    "database": "app_db"
  },
  {
    "name": "sqlite_app",
    "driver": "sqlite",
    "path": "./data/app.sqlite"
  }
]
```

`${ENV_VAR}` placeholders are expanded before JSON parsing.

After the config is in place, use `database_explorer_health_check` first to confirm connectivity.
Use `mode: "quick"` for fast reachability/queryability checks, and `mode: "full"` when you also want latency and current database/schema details.
Use `database_explorer_describe_table` when you need table columns, DDL, indexes, and foreign keys in one call.
Prefer these focused tools over `database_explorer_query` for connection checks and DDL inspection.

## Architecture

`src/core.ts` owns config loading, tool definitions, and dispatch. Database-specific behavior is implemented with a driver adapter strategy in `src/drivers/`:

- `src/drivers/mysql.ts`
- `src/drivers/postgres.ts`
- `src/drivers/sqlite.ts`

Each adapter implements the same shared contract, so adding or changing a tool in `src/core.ts` keeps the Copilot extension and MCP server in sync automatically.

## CI and releases

- `.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck`, `npm run build`, `npm run smoke:sqlite`, and a packaged CLI check via `npm pack` + `npx`.
- `.github/workflows/release.yml` runs the same validation on release builds, publishes a moving `dev` prerelease from `main`, and publishes versioned GitHub Releases for `v*` tags.

## Development

```bash
npm install
npm run build
npm run typecheck
npm run smoke:sqlite
```
