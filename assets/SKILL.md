# Database Explorer（Copilot）

This file is the main workflow guide for the `database-explorer` Copilot CLI extension.

When a task involves MySQL, PostgreSQL, or SQLite exploration, schema discovery, connection checks, health checks, table structure, columns, indexes, foreign keys, sample rows, or read-only SQL queries, follow this guidance.

## Execution rules

1. Prefer the `database_explorer_*` tools registered by this extension.
2. Provide `config` as JSON text in tool arguments (single profile object or profile array).
3. The MCP server may be started with a default `--config '<json text>'`; tool-level `config` overrides that default.
4. Do not build or call external Go binaries for database exploration.

## JSON config format (required)

Single profile object:

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

Profile array:

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
    "path": "./data/app.sqlite",
    "namespace": "main"
  }
]
```

`${ENV_VAR}` placeholders are expanded before parsing.

## Workflow

1. Resolve/generate the JSON config text first.
2. Start by listing configured database aliases.
3. Use `database_explorer_health_check` first for connectivity checks: `mode: "quick"` for fast reachability/queryability, `mode: "full"` for latency and current database/schema details.
4. Prefer focused tools such as `database_explorer_find_table`, `database_explorer_find_column`, `database_explorer_list_columns`, `database_explorer_list_indexes`, and `database_explorer_list_foreign_keys` before falling back to general SQL.
6. Use `database_explorer_describe_table` for DDL + columns + indexes + foreign keys in one call.
7. Use `database_explorer_explain_query` for plan inspection and `database_explorer_table_stats` for per-table summary data.
8. Continue as needed with sample, query, describe, or export-schema operations.
9. The tools already return structured output, so consume the tool result directly instead of reparsing plain text.

## Safety constraints

1. Only read-only queries are allowed.
   - If you need `SHOW CREATE TABLE`, use `database_explorer_describe_table` instead of manual SQL in `database_explorer_query`.
2. Keep default result sizes small.
3. Provide sensitive values via environment variables instead of hardcoding them.
