import { Client } from "pg";

import {
    buildContainsPattern,
    extractSingleColumnStrings,
    firstNonEmpty,
    normalizeLimit,
    normalizeRows,
    readNormalizedString,
    validateIdentifier,
} from "./shared";
import type {
    CommonToolArgs,
    ConnectionProbe,
    DatabaseDriverAdapter,
    ExportedSchema,
    NormalizedRow,
    PostgresProfile,
    QueryArgs,
    SampleRowsArgs,
    SearchArgs,
    TableDescription,
    TableToolArgs,
    TabularData,
} from "./types";

export const postgresDriver: DatabaseDriverAdapter<PostgresProfile> = {
    driver: "postgres",
    summarize(alias, profile) {
        return {
            alias,
            description: firstNonEmpty(profile.description, "No description"),
            driver: profile.driver,
            target: formatPostgresTarget(profile),
            host: profile.host,
            port: normalizePostgresPort(profile.port),
            database: profile.database,
            schema: profile.schema,
        };
    },
    async testConnection(profile, args) {
        return withPostgresConnection(profile, args.database, async (client) => {
            const result = await queryPostgresTabular(
                client,
                "SELECT current_database() AS database_name, current_schema() AS schema_name, version() AS version, session_user AS session_user, 1 AS ok",
            );
            const details = result.rows[0] ?? {};
            return {
                target: formatPostgresTarget(profile, args.database),
                version: firstNonEmpty(details.version, "unknown"),
                currentDatabase: firstNonEmpty(details.database_name),
                currentSchema: firstNonEmpty(details.schema_name),
                details,
            };
        });
    },
    async healthCheck(profile, args) {
        return withPostgresConnection(profile, args.database, async (client) => {
            const startedAt = Date.now();
            const result = await queryPostgresTabular(
                client,
                "SELECT current_database() AS database_name, current_schema() AS schema_name, version() AS version, current_setting('transaction_read_only') AS read_only, session_user AS session_user, 1 AS ok",
            );
            const latencyMs = Date.now() - startedAt;
            const details = result.rows[0] ?? {};
            return {
                target: formatPostgresTarget(profile, args.database),
                version: firstNonEmpty(details.version, "unknown"),
                currentDatabase: firstNonEmpty(details.database_name),
                currentSchema: firstNonEmpty(details.schema_name),
                latencyMs,
                details,
            };
        });
    },
    async listSchemas(profile, args) {
        return withPostgresConnection(profile, args.database, async (client) => {
            const result = await queryPostgresTabular(
                client,
                "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
            );
            return extractSingleColumnStrings(result.rows).sort();
        });
    },
    async listTables(profile, args) {
        const schema = resolvePostgresSchema(profile, args);
        return withPostgresConnection(profile, args.database, async (client) => listTableNames(client, schema));
    },
    async listColumns(profile, args) {
        const schema = resolvePostgresSchema(profile, args);
        const table = validateIdentifier(args.table, "table");
        return withPostgresConnection(profile, args.database, async (client) => listColumnsWithClient(client, schema, table));
    },
    async describeTable(profile, args) {
        const schema = resolvePostgresSchema(profile, args);
        const table = validateIdentifier(args.table, "table");
        return withPostgresConnection(profile, args.database, async (client) => describeTableWithClient(client, schema, table));
    },
    async sampleRows(profile, args) {
        const schema = resolvePostgresSchema(profile, args);
        const table = validateIdentifier(args.table, "table");
        const limit = normalizeLimit(args.limit);
        return withPostgresConnection(profile, args.database, async (client) =>
            queryPostgresTabular(client, `SELECT * FROM ${qualifyPostgresTable(schema, table)} LIMIT ${limit}`),
        );
    },
    async query(profile, args, sqlText) {
        return withPostgresConnection(profile, args.database, async (client) => queryPostgresTabular(client, sqlText));
    },
    async explainQuery(profile, args, sqlText) {
        return withPostgresConnection(profile, args.database, async (client) =>
            queryPostgresTabular(client, `EXPLAIN ${sqlText}`),
        );
    },
    async exportSchema(profile, args) {
        const schema = resolvePostgresSchema(profile, args);
        const targetDatabase = firstNonEmpty(args.database, profile.database);
        return withPostgresConnection(profile, args.database, async (client) => {
            const tables = await listTableNames(client, schema);
            const result: ExportedSchema = {
                database: `${targetDatabase}.${schema}`,
                tables: {},
            };

            for (const table of tables) {
                result.tables[table] = await describeTableWithClient(client, schema, table);
            }

            return result;
        });
    },
    async findTable(profile, args) {
        const schema = resolvePostgresSchema(profile, args);
        const limit = normalizeLimit(args.limit, 20);
        const pattern = buildContainsPattern(args.search);
        return withPostgresConnection(profile, args.database, async (client) =>
            queryPostgresTabular(
                client,
                `
                    SELECT
                        table_schema AS schema_name,
                        table_name,
                        table_type
                    FROM information_schema.tables
                    WHERE table_schema = $1
                        AND table_name ILIKE $2 ESCAPE '\\'
                    ORDER BY table_name
                    LIMIT ${limit}
                `,
                [schema, pattern],
            ),
        );
    },
    async findColumn(profile, args) {
        const schema = resolvePostgresSchema(profile, args);
        const limit = normalizeLimit(args.limit, 20);
        const pattern = buildContainsPattern(args.search);
        return withPostgresConnection(profile, args.database, async (client) =>
            queryPostgresTabular(
                client,
                `
                    SELECT
                        table_schema AS schema_name,
                        table_name,
                        column_name,
                        data_type,
                        is_nullable,
                        column_default
                    FROM information_schema.columns
                    WHERE table_schema = $1
                        AND column_name ILIKE $2 ESCAPE '\\'
                    ORDER BY table_name, ordinal_position
                    LIMIT ${limit}
                `,
                [schema, pattern],
            ),
        );
    },
    async tableStats(profile, args) {
        const schema = resolvePostgresSchema(profile, args);
        const table = validateIdentifier(args.table, "table");
        return withPostgresConnection(profile, args.database, async (client) =>
            queryPostgresTabular(
                client,
                `
                    SELECT
                        $1::text AS schema_name,
                        $2::text AS table_name,
                        c.reltuples::bigint AS estimated_rows,
                        pg_total_relation_size(c.oid) AS total_bytes,
                        pg_relation_size(c.oid) AS table_bytes,
                        pg_indexes_size(c.oid) AS index_bytes
                    FROM pg_catalog.pg_class AS c
                    INNER JOIN pg_catalog.pg_namespace AS n
                        ON n.oid = c.relnamespace
                    WHERE n.nspname = $1
                        AND c.relname = $2
                `,
                [schema, table],
            ),
        );
    },
    async listIndexes(profile, args) {
        const schema = resolvePostgresSchema(profile, args);
        const table = validateIdentifier(args.table, "table");
        return withPostgresConnection(profile, args.database, async (client) => listIndexesWithClient(client, schema, table));
    },
    async listForeignKeys(profile, args) {
        const schema = resolvePostgresSchema(profile, args);
        const table = validateIdentifier(args.table, "table");
        return withPostgresConnection(profile, args.database, async (client) =>
            queryPostgresTabular(
                client,
                `
                    SELECT
                        tc.constraint_name,
                        kcu.column_name,
                        ccu.table_schema AS referenced_schema,
                        ccu.table_name AS referenced_table,
                        ccu.column_name AS referenced_column
                    FROM information_schema.table_constraints AS tc
                    INNER JOIN information_schema.key_column_usage AS kcu
                        ON tc.constraint_name = kcu.constraint_name
                        AND tc.table_schema = kcu.table_schema
                    INNER JOIN information_schema.constraint_column_usage AS ccu
                        ON tc.constraint_name = ccu.constraint_name
                        AND tc.table_schema = ccu.table_schema
                    WHERE tc.constraint_type = 'FOREIGN KEY'
                        AND tc.table_schema = $1
                        AND tc.table_name = $2
                    ORDER BY tc.constraint_name, kcu.ordinal_position
                `,
                [schema, table],
            ),
        );
    },
};

async function describeTableWithClient(client: Client, schema: string, table: string): Promise<TableDescription> {
    const columns = await listColumnsWithClient(client, schema, table);
    const constraints = await queryPostgresTabular(
        client,
        `
            SELECT
                conname AS constraint_name,
                pg_get_constraintdef(oid) AS definition
            FROM pg_catalog.pg_constraint
            WHERE conrelid = to_regclass($1)
            ORDER BY conname
        `,
        [`${schema}.${table}`],
    );
    const indexes = await listIndexesWithClient(client, schema, table);

    return {
        table,
        columns,
        createStatement: buildPostgresCreateStatement(schema, table, columns.rows, constraints.rows),
        indexes,
    };
}

async function listColumnsWithClient(client: Client, schema: string, table: string): Promise<TabularData> {
    return queryPostgresTabular(
        client,
        `
            SELECT
                column_name,
                data_type,
                is_nullable,
                column_default,
                udt_name,
                ordinal_position
            FROM information_schema.columns
            WHERE table_schema = $1
                AND table_name = $2
            ORDER BY ordinal_position
        `,
        [schema, table],
    );
}

async function listTableNames(client: Client, schema: string): Promise<string[]> {
    const result = await queryPostgresTabular(
        client,
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
        [schema],
    );
    return extractSingleColumnStrings(result.rows).sort();
}

async function listIndexesWithClient(client: Client, schema: string, table: string): Promise<TabularData> {
    return queryPostgresTabular(
        client,
        "SELECT indexname, indexdef FROM pg_catalog.pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname",
        [schema, table],
    );
}

async function withPostgresConnection<T>(
    profile: PostgresProfile,
    databaseOverride: string | undefined,
    work: (client: Client) => Promise<T>,
): Promise<T> {
    const client = new Client({
        host: profile.host,
        port: normalizePostgresPort(profile.port),
        user: profile.username,
        password: profile.password,
        database: firstNonEmpty(databaseOverride, profile.database),
        connectionTimeoutMillis: 15_000,
        ssl: profile.ssl || undefined,
    });
    await client.connect();

    let result: T | undefined;
    let workError: unknown;

    try {
        result = await work(client);
    } catch (error) {
        workError = error;
    }

    try {
        await client.end();
    } catch (closeError) {
        if (workError !== undefined) {
            throw new Error(
                `${toErrorMessage(workError)}; additionally failed to close PostgreSQL connection: ${toErrorMessage(closeError)}`,
            );
        }
        throw closeError;
    }

    if (workError !== undefined) {
        throw workError;
    }

    return result as T;
}

async function queryPostgresTabular(client: Client, sqlText: string, values?: unknown[]): Promise<TabularData> {
    const result = values ? await client.query(sqlText, values) : await client.query(sqlText);
    const normalizedRows = normalizeRows(result.rows);
    return {
        columns: result.fields.map((field) => field.name).filter((name) => name !== ""),
        rows: normalizedRows,
    };
}

function buildPostgresCreateStatement(
    schema: string,
    table: string,
    columnRows: NormalizedRow[],
    constraintRows: NormalizedRow[],
): string {
    const lines: string[] = [];

    for (const row of columnRows) {
        const columnName = readNormalizedString(row, "column_name");
        const dataType = readNormalizedString(row, "data_type");
        const nullable = readNormalizedString(row, "is_nullable");
        const defaultValue = readNormalizedString(row, "column_default");

        if (columnName === "" || dataType === "") {
            continue;
        }

        const parts = [`  ${quotePostgresIdentifier(columnName)}`, dataType];
        if (defaultValue !== "") {
            parts.push(`DEFAULT ${defaultValue}`);
        }
        if (nullable === "NO") {
            parts.push("NOT NULL");
        }
        lines.push(parts.join(" "));
    }

    for (const row of constraintRows) {
        const constraintName = readNormalizedString(row, "constraint_name");
        const definition = readNormalizedString(row, "definition");
        if (constraintName === "" || definition === "") {
            continue;
        }
        lines.push(`  CONSTRAINT ${quotePostgresIdentifier(constraintName)} ${definition}`);
    }

    return `CREATE TABLE ${qualifyPostgresTable(schema, table)} (\n${lines.join(",\n")}\n);`;
}

function resolvePostgresSchema(profile: PostgresProfile, args: CommonToolArgs): string {
    return validateIdentifier(firstNonEmpty(args.schema, profile.schema, "public"), "schema");
}

function normalizePostgresPort(port: number): number {
    return Number.isInteger(port) && port > 0 ? port : 5432;
}

function quotePostgresIdentifier(identifier: string): string {
    return `"${identifier}"`;
}

function qualifyPostgresTable(schema: string, table: string): string {
    return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(table)}`;
}

function formatPostgresTarget(profile: PostgresProfile, databaseOverride?: string): string {
    const databaseName = firstNonEmpty(databaseOverride, profile.database);
    return `${profile.host}:${normalizePostgresPort(profile.port)}/${databaseName}`;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
