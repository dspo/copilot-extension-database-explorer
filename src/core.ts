import { readFile } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";

import YAML from "yaml";

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

const DEFAULT_CONFIG_RELATIVE_PATH = ".github/database-explorer/database-config.yaml";
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
    defaultConfigPath?: string;
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
        "The default database config path is .github/database-explorer/database-config.yaml; pass configPath when a project stores config elsewhere.",
        "Start by listing configured database aliases, then use connection-test or health-check before deeper schema exploration when needed.",
        "Use the focused tools for tables, columns, indexes, foreign keys, explain, and search before falling back to general query execution.",
        "Safety constraints: read-only queries only, small default result sets, and sensitive values provided via environment variables.",
        "",
        "Bundled guidance:",
        skillText,
    ].join("\n");
}

export function createDatabaseExplorerDefinitions(options: DatabaseExplorerToolFactoryOptions): DatabaseExplorerToolDefinition[] {
    const { getCwd, defaultConfigPath } = options;
    const sessionDefaultConfigPathByCwd = new Map<string, string>();
    const resolveSessionDefaultConfigPath = (cwd: string): string | undefined => sessionDefaultConfigPathByCwd.get(cwd);
    const withAdapter = <TArgs, TResult>(run: (adapter: DatabaseDriverAdapter, profile: Profile, alias: string, args: TArgs) => Promise<TResult>) =>
        async (args: TArgs): Promise<TResult> => {
            const selected = await loadSelectedDriverProfile(
                args as CommonToolArgs,
                getCwd,
                defaultConfigPath,
                resolveSessionDefaultConfigPath,
            );
            return run(selected.adapter, selected.profile, selected.alias, args);
        };

    return [
        createToolDefinition(
            "database_explorer_set_default_config_path",
            "Set a session-level default config path so subsequent database_explorer_* calls can omit configPath",
            {
                type: "object",
                properties: {
                    configPath: {
                        type: "string",
                        description: "Absolute or project-relative path to the database config YAML file",
                    },
                },
                required: ["configPath"],
                additionalProperties: false,
            },
            readSetDefaultConfigArgs,
            async (args) => {
                const cwd = getCwd();
                const resolved = await resolveConfigPath(args.configPath, cwd, undefined, undefined);
                await loadConfig(resolved);
                sessionDefaultConfigPathByCwd.set(cwd, resolved);
                return {
                    cwd,
                    defaultConfigPath: resolved,
                };
            },
        ),
        createToolDefinition(
            "database_explorer_list_databases",
            "List configured database aliases from the database-explorer config",
            sharedConfigParameters([]),
            readCommonToolArgs,
            async (args) => {
                const config = await loadConfigFromArgs(args, getCwd, defaultConfigPath);
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

export async function loadConfigForTests(configPath: string): Promise<Config> {
    return loadConfig(configPath);
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
        configPath: {
            type: "string",
            description:
                "Optional absolute or project-relative path to the database config YAML file. Defaults to .github/database-explorer/database-config.yaml when present.",
        },
        db: {
            type: "string",
            description: "Configured database alias from the YAML file",
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

async function loadSelectedDriverProfile(
    args: CommonToolArgs,
    getCwd: () => string,
    defaultConfigPath?: string,
    getSessionDefaultConfigPath?: (cwd: string) => string | undefined,
): Promise<{ alias: string; profile: Profile; adapter: DatabaseDriverAdapter }> {
    const config = await loadConfigFromArgs(args, getCwd, defaultConfigPath, getSessionDefaultConfigPath);
    const selection = resolveProfileSelection(config, args.db);
    return {
        ...selection,
        adapter: getDriverAdapter(selection.profile.driver),
    };
}

async function loadConfigFromArgs(
    args: CommonToolArgs,
    getCwd: () => string,
    defaultConfigPath?: string,
    getSessionDefaultConfigPath?: (cwd: string) => string | undefined,
): Promise<Config> {
    const cwd = getCwd();
    const configPath = await resolveConfigPath(args.configPath, cwd, getSessionDefaultConfigPath?.(cwd), defaultConfigPath);
    return loadConfig(configPath);
}

async function resolveConfigPath(
    inputPath: string | undefined,
    cwd: string,
    sessionDefaultConfigPath?: string,
    defaultConfigPath?: string,
): Promise<string> {
    if (typeof inputPath === "string" && inputPath.trim() !== "") {
        const trimmedPath = inputPath.trim();
        return isAbsolute(trimmedPath) ? trimmedPath : resolve(cwd, trimmedPath);
    }

    if (typeof sessionDefaultConfigPath === "string" && sessionDefaultConfigPath.trim() !== "") {
        const trimmedPath = sessionDefaultConfigPath.trim();
        return isAbsolute(trimmedPath) ? trimmedPath : resolve(cwd, trimmedPath);
    }

    if (typeof defaultConfigPath === "string" && defaultConfigPath.trim() !== "") {
        const trimmedPath = defaultConfigPath.trim();
        return isAbsolute(trimmedPath) ? trimmedPath : resolve(cwd, trimmedPath);
    }

    const discovered = await findConfigPath(cwd);
    if (discovered) {
        return discovered;
    }

    throw new Error(
        "unable to locate database config automatically; pass configPath explicitly or create .github/database-explorer/database-config.yaml",
    );
}

async function findConfigPath(startDir: string): Promise<string> {
    let currentDir = startDir || process.cwd();
    const { root } = parse(currentDir);

    while (true) {
        const candidate = resolve(currentDir, DEFAULT_CONFIG_RELATIVE_PATH);
        try {
            await readFile(candidate);
            return candidate;
        } catch (error) {
            if (!isErrnoException(error) || error.code !== "ENOENT") {
                throw error;
            }
            if (currentDir === root) {
                return "";
            }
            currentDir = parse(currentDir).dir;
        }
    }
}

async function loadConfig(configPath: string): Promise<Config> {
    const raw = await readFile(configPath, "utf8");
    const expanded = expandPlaceholders(raw);
    const parsed = parseYamlRoot(YAML.parse(expanded), parse(configPath).dir);
    if (Object.keys(parsed.databases).length === 0) {
        throw new Error(
            `config ${configPath} must define at least one database under databases (object form: databases: { alias: { ... } })`,
        );
    }
    return parsed;
}

function parseYamlRoot(value: unknown, configDirectory: string): Config {
    if (!isRecord(value)) {
        throw new Error("config root must be an object");
    }

    const databasesValue = value.databases;
    if (Array.isArray(databasesValue)) {
        throw new Error(
            "config.databases must be an object keyed by alias, not a YAML list. Example:\n" +
                "databases:\n" +
                "  main:\n" +
                "    driver: mysql\n" +
                "    host: 127.0.0.1\n" +
                "    username: ${MYSQL_USER}\n" +
                "    password: ${MYSQL_PASSWORD}",
        );
    }
    if (!isRecord(databasesValue)) {
        throw new Error("config must define databases as an object keyed by alias");
    }

    const databases: Record<string, Profile> = {};
    for (const [alias, profileValue] of Object.entries(databasesValue)) {
        databases[alias] = normalizeProfile(alias, profileValue, configDirectory);
    }

    return { databases };
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
        configPath: readOptionalString(object, "configPath") || undefined,
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

function readSetDefaultConfigArgs(value: unknown): { configPath: string } {
    const object = readToolArgs(value);
    return {
        configPath: readRequiredString(object, "configPath"),
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

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
