# copilot-extension-database-explorer

Standalone npm package for:

1. installing the `database-explorer` Copilot CLI extension into a target project
2. running the same database explorer as an MCP server

Supported database drivers: MySQL, PostgreSQL, and SQLite.

## Exposed tools

The extension and MCP server expose the same shared tool surface:

- `database_explorer_list_databases`
- `database_explorer_test_connection`
- `database_explorer_health_check`
- `database_explorer_list_schemas`
- `database_explorer_list_tables`
- `database_explorer_find_table`
- `database_explorer_find_column`
- `database_explorer_list_columns`
- `database_explorer_describe_table`
- `database_explorer_show_create_table`
- `database_explorer_sample_rows`
- `database_explorer_query`
- `database_explorer_explain_query`
- `database_explorer_table_stats`
- `database_explorer_list_indexes`
- `database_explorer_list_foreign_keys`
- `database_explorer_export_schema`
- `database_explorer_set_default_config_path`

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

If you want the server to default to a nonstandard config path, pass `--config`:

```bash
npx -y copilot-extension-database-explorer mcp \
  --cwd /path/to/project \
  --config ./config/database-explorer.yaml
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

By default, both the installed Copilot extension and the MCP server look for database config at:

```text
.github/database-explorer/database-config.yaml
```

If a project uses another location, you can:

1. pass `--config` when starting the MCP server
2. call `database_explorer_set_default_config_path` once per session
3. pass `configPath` explicitly to the tools

Supported `driver` values:

- `mysql` (default when omitted)
- `postgres`, `postgresql`, or `pg`
- `sqlite` or `sqlite3`

Example config:

```yaml
databases:
  mysql_app:
    driver: mysql
    host: 127.0.0.1
    port: 3306
    username: ${MYSQL_USER}
    password: ${MYSQL_PASSWORD}
    database: app_db

  postgres_app:
    driver: postgres
    host: 127.0.0.1
    port: 5432
    username: ${PGUSER}
    password: ${PGPASSWORD}
    database: app_db
    schema: public

  sqlite_app:
    driver: sqlite
    path: ./data/app.sqlite
```

`databases` must be a map keyed by alias (object form above), not a YAML list.

After the config is in place, use `database_explorer_test_connection` first to confirm the selected alias can connect and execute a simple query.
Use `database_explorer_health_check` when you also want latency and readiness details.
Use `database_explorer_show_create_table` when you need DDL plus foreign keys in one call.

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
