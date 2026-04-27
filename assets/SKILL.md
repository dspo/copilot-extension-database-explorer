# Database Explorer（Copilot）

This file is the main workflow guide for the `database-explorer` Copilot CLI extension.

When a task involves MySQL, PostgreSQL, or SQLite exploration, schema discovery, connection checks, health checks, table structure, columns, indexes, foreign keys, sample rows, or read-only SQL queries, follow this guidance.

## Execution rules

1. Prefer the `database_explorer_*` tools registered by this extension.
2. The default database config path is `./.github/database-explorer/database-config.yaml`.
3. If the project stores config elsewhere, either pass `configPath` explicitly or call `database_explorer_set_default_config_path` once per session.
4. Do not build or call external Go binaries for database exploration.

## YAML config format (required)

`databases` must be an **object keyed by alias** (not a YAML list):

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
    namespace: main
```

## Workflow

1. Resolve the database config file path first.
2. Start by listing configured database aliases.
3. Use `database_explorer_test_connection` before deeper exploration when you need to confirm connectivity and queryability.
4. Use `database_explorer_health_check` when you need readiness details such as latency and current database/schema.
5. Prefer focused tools such as `database_explorer_find_table`, `database_explorer_find_column`, `database_explorer_list_columns`, `database_explorer_list_indexes`, and `database_explorer_list_foreign_keys` before falling back to general SQL.
6. Use `database_explorer_show_create_table` for DDL + foreign keys in one call.
7. Use `database_explorer_explain_query` for plan inspection and `database_explorer_table_stats` for per-table summary data.
8. Continue as needed with sample, query, describe, or export-schema operations.
9. The tools already return structured output, so consume the tool result directly instead of reparsing plain text.

## Safety constraints

1. Only read-only queries are allowed.
   - If you need `SHOW CREATE TABLE`, use `database_explorer_show_create_table` (or `database_explorer_describe_table`).
2. Keep default result sizes small.
3. Provide sensitive values via environment variables instead of hardcoding them.
