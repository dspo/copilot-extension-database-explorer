import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { getDriverAdapter } from "./drivers";
import { firstNonEmpty, prepareExplainQuery, prepareReadOnlyQuery, stringOrEmpty } from "./drivers/shared";
import type {
    CommonToolArgs,
    Config,
    ConnectionProbe,
    ConnectionTestResult,
    DatabaseDriver,
    DatabaseDriverAdapter,
    DatabaseSummary,
    ExportedSchema,
    HealthCheckResult,
    HealthProbe,
    PostgresProfile,
    Profile,
    QueryArgs,
    SampleRowsArgs,
    SearchArgs,
    SqliteProfile,
    TableDescription,
    TableToolArgs,
    TabularData,
} from "./drivers/types";

const KEYWORD_PATTERN =
    /\b(mysql|postgres|postgresql|sqlite|database|schema|table structure|table schema|sample rows?|read-only sql|select query|sql optimize|sql optimization|describe table|show create table|database connection|test connection|health check|foreign key|index|column|explain query)\b/i;
const PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SESSION_START_CONTEXT =
    "database-explorer extension loaded. For MySQL, PostgreSQL, or SQLite exploration tasks, use the bundled database-explorer SKILL guidance in this session and prefer the database_explorer_* tools over external binaries.";

export interface ToolParameterDefinition {
    type: "string" | "integer" | "object";
    description?: string;
    properties?: Record<string, ToolParameterDefinition>;
    required?: string[];
    additionalProperties?: boolean;
}

export interface DatabaseExplorerToolFactoryOptions {
    getCwd: () => string;
    defaultConfig?: string;
}

export interface DatabaseExplorerToolDefinition {
    name: string;
    description: string;
    parameters: ToolParameterDefinition;
    execute: (args: unknown) => Promise<unknown>;
}

export function getDatabaseExplorerPattern(): RegExp {
    return KEYWORD_PATTERN;
}

export function getDatabaseExplorerSessionStartContext(): string {
    return SESSION_START_CONTEXT;
}

export function buildDatabaseExplorerAdditionalContext(skillText: string): string {
    return [
        "database-explorer extension loaded.",
        "When the request involves MySQL, PostgreSQL, SQLite, schema inspection, tables, columns, indexes, foreign keys, sample data, connection checks, health checks, explain plans, or read-only SQL, prefer the database_explorer_* tools available in this session.",
        "Each database_explorer_* tool accepts config as JSON text. Pass either one profile object or a profile array with name fields.",
        "JSON config may use ${ENV_VAR} placeholders; environment values are expanded before parsing.",
        "Start by listing configured database aliases, then use connection-test or health-check before deeper schema exploration when needed.",
        "Use the focused tools for tables, columns, indexes, foreign keys, explain, and search before falling back to general query execution.",
        "Safety constraints: read-only queries only, small default result sets, and sensitive values provided via environment variables.",
        "",
        "Bundled guidance:",
        skillText,
    ].join("\n");
}

export function createDatabaseExplorerDefinitions(options: DatabaseExplorerToolFactoryOptions): DatabaseExplorerToolDefinition[] {
    const { getCwd, defaultConfig } = options;
    const withAdapter = <TArgs, TResult>(run: (adapter: DatabaseDriverAdapter, profile: Profile, alias: string, args: TArgs) => Promise<TResult>) =>
        async (args: TArgs): Promise<TResult> => {
            const selected = loadSelectedDriverProfile(args as CommonToolArgs, getCwd, defaultConfig);
            return run(selected.adapter, selected.profile, selected.alias, args);
        };

    return [
        createToolDefinition(
            "database_explorer_list_databases",
            "List database aliases from config JSON",
            sharedConfigParameters([]),
            readCommonToolArgs,
            async (args) => {
                const config = loadConfigFromArgs(args, getCwd, defaultConfig);
                return listAliases(config).map((alias) => getDriverAdapter(config.databases[alias].driver).summarize(alias, config.databases[alias]));
            },
        ),
        createToolDefinition(
            "database_explorer_test_connection",
            "Test whether a configured database alias is reachable and can execute a simple query",
            sharedConfigParameters([]),
            readCommonToolArgs,
            withAdapter(async (adapter, profile, alias, args) => toConnectionTestResult(alias, profile.driver, await adapter.testConnection(profile, args))),
        ),
        createToolDefinition(
            "database_explorer_health_check",
            "Run a deeper connectivity and readiness check for a configured database alias",
            sharedConfigParameters([]),
            readCommonToolArgs,
            withAdapter(async (adapter, profile, alias, args) => toHealthCheckResult(alias, profile.driver, await adapter.healthCheck(profile, args))),
        ),
        createToolDefinition(
            "database_explorer_list_schemas",
            "List schemas or namespaces visible in a configured database",
            sharedConfigParameters([]),
            readCommonToolArgs,
            withAdapter(async (adapter, profile, alias, args) => adapter.listSchemas(profile, args)),
        ),
        createToolDefinition(
            "database_explorer_list_tables",
            "List tables in the configured database or schema",
            sharedConfigParameters([]),
            readCommonToolArgs,
            withAdapter(async (adapter, profile, alias, args) => adapter.listTables(profile, args)),
        ),
        createToolDefinition(
            "database_explorer_find_table",
            "Search table names in the configured database or schema",
            searchToolParameters("Substring to search for in table names"),
            readSearchArgs,
            withAdapter(async (adapter, profile, alias, args) => adapter.findTable(profile, args)),
        ),
        createToolDefinition(
            "database_explorer_find_column",
            "Search column names across tables in the configured database or schema",
            searchToolParameters("Substring to search for in column names"),
            readSearchArgs,
            withAdapter(async (adapter, profile, alias, args) => adapter.findColumn(profile, args)),
        ),
        createToolDefinition(
            "database_explorer_list_columns",
            "List columns for one table",
            tableToolParameters("Table name to inspect"),
            readTableToolArgs,
            withAdapter(async (adapter, profile, alias, args) => adapter.listColumns(profile, args)),
        ),
        createToolDefinition(
            "database_explorer_describe_table",
            "Describe one table including columns, create statement, and indexes",
            tableToolParameters("Table name to describe"),
            readTableToolArgs,
            withAdapter(async (adapter, profile, alias, args) => adapter.describeTable(profile, args)),
        ),
        createToolDefinition(
            "database_explorer_show_create_table",
            "Return a CREATE TABLE statement plus foreign keys for one table",
            tableToolParameters("Table name to inspect"),
            readTableToolArgs,
            withAdapter(async (adapter, profile, alias, args) => {
                const description = await adapter.describeTable(profile, args);
                const foreignKeys = await adapter.listForeignKeys(profile, args);
                return {
                    table: description.table,
                    createStatement: description.createStatement,
                    foreignKeys,
                };
            }),
        ),
        createToolDefinition(
            "database_explorer_sample_rows",
            "Fetch a small sample of rows from one table",
            {
                type: "object",
                properties: {
                    ...sharedParameterProperties(),
                    table: {
                        type: "string",
                        description: "Table name to sample from",
                    },
                    limit: {
                        type: "integer",
                        description: "Maximum rows to return when sampling. Defaults to 10.",
                    },
                },
                required: ["table"],
                additionalProperties: false,
            },
            readSampleRowsArgs,
            withAdapter(async (adapter, profile, alias, args) => adapter.sampleRows(profile, args)),
        ),
        createToolDefinition(
            "database_explorer_query",
            "Run a read-only SELECT query against a configured database",
            queryToolParameters("Single read-only SELECT statement to execute"),
            readQueryArgs,
            withAdapter(async (adapter, profile, alias, args) => adapter.query(profile, args, prepareReadOnlyQuery(args.sql, args.limit))),
        ),
        createToolDefinition(
            "database_explorer_explain_query",
            "Explain a read-only SELECT query against a configured database",
            queryToolParameters("Single read-only SELECT statement to explain"),
            readQueryArgs,
            withAdapter(async (adapter, profile, alias, args) => adapter.explainQuery(profile, args, prepareExplainQuery(args.sql))),
        ),
        createToolDefinition(
            "database_explorer_table_stats",
            "Return summary statistics for one table",
            tableToolParameters("Table name to inspect"),
            readTableToolArgs,
            withAdapter(async (adapter, profile, alias, args) => adapter.tableStats(profile, args)),
        ),
        createToolDefinition(
            "database_explorer_list_indexes",
            "List indexes defined on one table",
            tableToolParameters("Table name to inspect"),
            readTableToolArgs,
            withAdapter(async (adapter, profile, alias, args) => adapter.listIndexes(profile, args)),
        ),
        createToolDefinition(
            "database_explorer_list_foreign_keys",
            "List foreign keys defined on one table",
            tableToolParameters("Table name to inspect"),
            readTableToolArgs,
            withAdapter(async (adapter, profile, alias, args) => adapter.listForeignKeys(profile, args)),
        ),
        createToolDefinition(
            "database_explorer_export_schema",
            "Export the schema description for every table in a configured database or schema",
            sharedConfigParameters([]),
            readCommonToolArgs,
            withAdapter(async (adapter, profile, alias, args) => adapter.exportSchema(profile, args)),
        ),
    ];
}

export async function readSkillText(path: string): Promise<string> {
    return (await readFile(path, "utf8")).trim();
}

export { prepareReadOnlyQuery };

export function formatDatabaseExplorerResult(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

export async function loadConfigForTests(configText: string, cwd: string): Promise<Config> {
    return parseConfigText(configText, cwd);
}

function createToolDefinition<TArgs>(
    name: string,
    description: string,
    parameters: ToolParameterDefinition,
    readArgs: (value: unknown) => TArgs,
    execute: (args: TArgs) => Promise<unknown>,
): DatabaseExplorerToolDefinition {
    return {
        name,
        description,
        parameters,
        execute: async (rawArgs) => execute(readArgs(rawArgs)),
    };
}

function sharedConfigParameters(requiredKeys: string[]): ToolParameterDefinition {
    return {
        type: "object",
        properties: sharedParameterProperties(),
        required: requiredKeys,
        additionalProperties: false,
    };
}

function tableToolParameters(tableDescription: string): ToolParameterDefinition {
    return {
        type: "object",
        properties: {
            ...sharedParameterProperties(),
            table: {
                type: "string",
                description: tableDescription,
            },
        },
        required: ["table"],
        additionalProperties: false,
    };
}

function queryToolParameters(sqlDescription: string): ToolParameterDefinition {
    return {
        type: "object",
        properties: {
            ...sharedParameterProperties(),
            sql: {
                type: "string",
                description: sqlDescription,
            },
            limit: {
                type: "integer",
                description: "Optional default LIMIT to append when the query does not already include one. Defaults to 10 for database_explorer_query.",
            },
        },
        required: ["sql"],
        additionalProperties: false,
    };
}

function searchToolParameters(searchDescription: string): ToolParameterDefinition {
    return {
        type: "object",
        properties: {
            ...sharedParameterProperties(),
            search: {
                type: "string",
                description: searchDescription,
            },
            limit: {
                type: "integer",
                description: "Maximum matches to return. Defaults to 20.",
            },
        },
        required: ["search"],
        additionalProperties: false,
    };
}

function sharedParameterProperties(): Record<string, ToolParameterDefinition> {
    return {
        config: {
            type: "string",
            description:
                "JSON text describing either one database profile object or an array of profile objects. Supports ${ENV_VAR} placeholders.",
        },
        db: {
            type: "string",
            description: "Database alias to select from config JSON entries",
        },
        database: {
            type: "string",
            description: "Optional database name override. For MySQL this selects the active database; for PostgreSQL this selects the connection database.",
        },
        schema: {
            type: "string",
            description: "Optional schema or namespace override. Used for PostgreSQL schemas and SQLite namespaces.",
        },
    };
}

function loadSelectedDriverProfile(
    args: CommonToolArgs,
    getCwd: () => string,
    defaultConfig?: string,
): { alias: string; profile: Profile; adapter: DatabaseDriverAdapter } {
    const config = loadConfigFromArgs(args, getCwd, defaultConfig);
    const selection = resolveProfileSelection(config, args.db);
    return {
        ...selection,
        adapter: getDriverAdapter(selection.profile.driver),
    };
}

function loadConfigFromArgs(
    args: CommonToolArgs,
    getCwd: () => string,
    defaultConfig?: string,
): Config {
    const cwd = getCwd();
    const configText = firstNonEmpty(args.config, defaultConfig);
    if (configText === "") {
        throw new Error("missing config JSON; pass config as a JSON string or start MCP with --config '<json>'");
    }
    return parseConfigText(configText, cwd);
}

function parseConfigText(configText: string, cwd: string): Config {
    const expanded = expandPlaceholders(configText);
    const parsed = parseJson(expanded);
    const databases: Record<string, Profile> = {};

    if (Array.isArray(parsed)) {
        for (const entry of parsed) {
            const { alias, profile } = normalizeInputProfile(entry, cwd, true);
            if (databases[alias]) {
                throw new Error(`duplicate database name ${JSON.stringify(alias)} in config array`);
            }
            databases[alias] = profile;
        }
    } else {
        const { alias, profile } = normalizeInputProfile(parsed, cwd, false);
        databases[alias] = profile;
    }

    if (Object.keys(databases).length === 0) {
        throw new Error("config JSON must include at least one database profile");
    }

    return { databases };
}

function parseJson(input: string): unknown {
    try {
        return JSON.parse(input);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`config must be valid JSON: ${message}`);
    }
}

function normalizeInputProfile(value: unknown, cwd: string, requireName: boolean): { alias: string; profile: Profile } {
    if (!isRecord(value)) {
        throw new Error("each config profile must be a JSON object");
    }
    const name = readOptionalString(value, "name");
    if (requireName && name === "") {
        throw new Error("each profile in config array must include a non-empty name");
    }
    const alias = firstNonEmpty(name, "default");
    return {
        alias,
        profile: normalizeProfile(alias, value, cwd),
    };
}

function normalizeProfile(alias: string, profileValue: unknown, configDirectory: string): Profile {
    if (!isRecord(profileValue)) {
        throw new Error(`database ${JSON.stringify(alias)} must be an object`);
    }

    const description = readOptionalString(profileValue, "description");
    const driver = normalizeDriver(readOptionalString(profileValue, "driver"));

    switch (driver) {
        case "mysql": {
            const profile = {
                description,
                driver,
                host: readOptionalString(profileValue, "host"),
                port: readOptionalInteger(profileValue, "port"),
                username: readOptionalString(profileValue, "username"),
                password: readOptionalString(profileValue, "password"),
                database: readOptionalString(profileValue, "database"),
            };

            if (profile.host === "") {
                throw new Error(`database ${JSON.stringify(alias)} missing host`);
            }
            if (profile.username === "") {
                throw new Error(`database ${JSON.stringify(alias)} missing username`);
            }
            if (profile.password === "") {
                throw new Error(`database ${JSON.stringify(alias)} missing password`);
            }

            return profile;
        }
        case "postgres": {
            const profile: PostgresProfile = {
                description,
                driver,
                host: readOptionalString(profileValue, "host"),
                port: readOptionalInteger(profileValue, "port"),
                username: readOptionalString(profileValue, "username"),
                password: readOptionalString(profileValue, "password"),
                database: readOptionalString(profileValue, "database"),
                schema: firstNonEmpty(readOptionalString(profileValue, "schema"), "public"),
                ssl: readOptionalBoolean(profileValue, "ssl"),
            };

            if (profile.host === "") {
                throw new Error(`database ${JSON.stringify(alias)} missing host`);
            }
            if (profile.username === "") {
                throw new Error(`database ${JSON.stringify(alias)} missing username`);
            }
            if (profile.password === "") {
                throw new Error(`database ${JSON.stringify(alias)} missing password`);
            }
            if (profile.database === "") {
                throw new Error(`database ${JSON.stringify(alias)} missing database`);
            }

            return profile;
        }
        case "sqlite": {
            const path = readOptionalString(profileValue, "path");
            if (path === "") {
                throw new Error(`database ${JSON.stringify(alias)} missing path`);
            }

            const profile: SqliteProfile = {
                description,
                driver,
                path: isAbsolute(path) ? path : resolve(configDirectory, path),
                namespace: firstNonEmpty(
                    readOptionalString(profileValue, "namespace"),
                    readOptionalString(profileValue, "schema"),
                    readOptionalString(profileValue, "database"),
                    "main",
                ),
            };

            return profile;
        }
    }
}

function normalizeDriver(driver: string): DatabaseDriver {
    const normalized = firstNonEmpty(driver, "mysql").toLowerCase();
    switch (normalized) {
        case "mysql":
            return "mysql";
        case "postgres":
        case "postgresql":
        case "pg":
            return "postgres";
        case "sqlite":
        case "sqlite3":
            return "sqlite";
        default:
            throw new Error(`unsupported driver ${JSON.stringify(driver)}; supported drivers: mysql, postgres, sqlite`);
    }
}

function expandPlaceholders(input: string): string {
    const missing = new Set<string>();
    const expanded = input.replaceAll(PLACEHOLDER_PATTERN, (_, name: string) => {
        const value = process.env[name];
        if (value === undefined) {
            missing.add(name);
            return `\${${name}}`;
        }
        return value;
    });

    if (missing.size > 0) {
        throw new Error(`missing environment variables: ${Array.from(missing).sort().join(", ")}`);
    }

    return expanded;
}

function listAliases(config: Config): string[] {
    return Object.keys(config.databases).sort();
}

function resolveProfileSelection(config: Config, alias: string | undefined): { alias: string; profile: Profile } {
    const trimmedAlias = stringOrEmpty(alias);
    if (trimmedAlias !== "") {
        const profile = config.databases[trimmedAlias];
        if (!profile) {
            throw new Error(`database ${JSON.stringify(trimmedAlias)} not found in config; available: ${listAliases(config).join(", ")}`);
        }
        return { alias: trimmedAlias, profile };
    }

    const aliases = listAliases(config);
    if (aliases.length === 0) {
        throw new Error("no databases configured");
    }
    if (aliases.length > 1) {
        throw new Error(`multiple databases configured; choose db from: ${aliases.join(", ")}`);
    }

    return {
        alias: aliases[0],
        profile: config.databases[aliases[0]],
    };
}

function toConnectionTestResult(alias: string, driver: DatabaseDriver, probe: ConnectionProbe): ConnectionTestResult {
    return {
        alias,
        driver,
        usable: true,
        target: probe.target,
        version: probe.version,
        details: probe.details,
    };
}

function toHealthCheckResult(alias: string, driver: DatabaseDriver, probe: HealthProbe): HealthCheckResult {
    return {
        alias,
        driver,
        usable: true,
        target: probe.target,
        version: probe.version,
        details: probe.details,
        latencyMs: probe.latencyMs,
        currentDatabase: probe.currentDatabase,
        currentSchema: probe.currentSchema,
    };
}

function readCommonToolArgs(value: unknown): CommonToolArgs {
    const object = readToolArgs(value);
    return {
        config: readOptionalString(object, "config") || undefined,
        db: readOptionalString(object, "db") || undefined,
        database: readOptionalString(object, "database") || undefined,
        schema: readOptionalString(object, "schema") || undefined,
    };
}

function readTableToolArgs(value: unknown): TableToolArgs {
    const object = readToolArgs(value);
    return {
        ...readCommonToolArgs(object),
        table: readRequiredString(object, "table"),
    };
}

function readSampleRowsArgs(value: unknown): SampleRowsArgs {
    const object = readToolArgs(value);
    return {
        ...readTableToolArgs(object),
        limit: readOptionalInteger(object, "limit") || undefined,
    };
}

function readQueryArgs(value: unknown): QueryArgs {
    const object = readToolArgs(value);
    return {
        ...readCommonToolArgs(object),
        sql: readRequiredString(object, "sql"),
        limit: readOptionalInteger(object, "limit") || undefined,
    };
}

function readSearchArgs(value: unknown): SearchArgs {
    const object = readToolArgs(value);
    return {
        ...readCommonToolArgs(object),
        search: readRequiredString(object, "search"),
        limit: readOptionalInteger(object, "limit") || undefined,
    };
}

function readToolArgs(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

function readRequiredString(source: Record<string, unknown>, key: string): string {
    const value = readOptionalString(source, key);
    if (value === "") {
        throw new Error(`${key} is required`);
    }
    return value;
}

function readOptionalString(source: Record<string, unknown>, key: string): string {
    return stringOrEmpty(source[key]);
}

function readOptionalInteger(source: Record<string, unknown>, key: string): number {
    const value = source[key];
    if (typeof value === "number" && Number.isInteger(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number.parseInt(value, 10);
        return Number.isInteger(parsed) ? parsed : 0;
    }
    return 0;
}

function readOptionalBoolean(source: Record<string, unknown>, key: string): boolean {
    const value = source[key];
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true") {
            return true;
        }
        if (normalized === "false") {
            return false;
        }
    }
    return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
