import mysql from "mysql2/promise";

import {
    buildContainsPattern,
    extractFieldNames,
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
    MySqlProfile,
    NormalizedRow,
    QueryArgs,
    SampleRowsArgs,
    SearchArgs,
    TableDescription,
    TableToolArgs,
    TabularData,
} from "./types";

type MySQLConnection = Awaited<ReturnType<typeof mysql.createConnection>>;

export const mysqlDriver: DatabaseDriverAdapter<MySqlProfile> = {
    driver: "mysql",
    summarize(alias, profile) {
        return {
            alias,
            description: firstNonEmpty(profile.description, "No description"),
            driver: profile.driver,
            target: formatMySqlTarget(profile),
            host: profile.host,
            port: normalizeMySqlPort(profile.port),
            database: profile.database,
        };
    },
    async testConnection(profile, args) {
        return withMySqlConnection(profile, args.database, async (connection) => {
            const rows = await queryRowsOnly(
                connection,
                "SELECT DATABASE() AS database_name, VERSION() AS version, CURRENT_USER() AS current_user, 1 AS ok",
            );
            const details = rows[0] ?? {};
            return {
                target: formatMySqlTarget(profile, args.database),
                version: firstNonEmpty(details.version, "unknown"),
                currentDatabase: firstNonEmpty(details.database_name),
                details,
            };
        });
    },
    async healthCheck(profile, args) {
        return withMySqlConnection(profile, args.database, async (connection) => {
            const startedAt = Date.now();
            const rows = await queryRowsOnly(
                connection,
                "SELECT DATABASE() AS database_name, VERSION() AS version, @@hostname AS server_host, @@port AS server_port, @@transaction_read_only AS read_only, CURRENT_USER() AS current_user, 1 AS ok",
            );
            const latencyMs = Date.now() - startedAt;
            const details = rows[0] ?? {};
            return {
                target: formatMySqlTarget(profile, args.database),
                version: firstNonEmpty(details.version, "unknown"),
                currentDatabase: firstNonEmpty(details.database_name),
                currentSchema: firstNonEmpty(details.database_name),
                latencyMs,
                details,
            };
        });
    },
    async listSchemas(profile, args) {
        return withMySqlConnection(profile, args.database, async (connection) => {
            const [rows] = await connection.query("SHOW DATABASES");
            return extractSingleColumnStrings(rows).sort();
        });
    },
    async listTables(profile, args) {
        return withMySqlConnection(profile, args.database, async (connection) => listTableNames(connection));
    },
    async listColumns(profile, args) {
        const table = validateIdentifier(args.table, "table");
        return withMySqlConnection(profile, args.database, async (connection) =>
            queryMySqlTabular(connection, `SHOW FULL COLUMNS FROM ${quoteMysqlIdentifier(table)}`),
        );
    },
    async describeTable(profile, args) {
        const table = validateIdentifier(args.table, "table");
        return withMySqlConnection(profile, args.database, async (connection) => describeTableWithConnection(connection, table));
    },
    async sampleRows(profile, args) {
        const table = validateIdentifier(args.table, "table");
        const limit = normalizeLimit(args.limit);
        return withMySqlConnection(profile, args.database, async (connection) =>
            queryMySqlTabular(connection, `SELECT * FROM ${quoteMysqlIdentifier(table)} LIMIT ${limit}`),
        );
    },
    async query(profile, args, sqlText) {
        return withMySqlConnection(profile, args.database, async (connection) => queryMySqlTabular(connection, sqlText));
    },
    async explainQuery(profile, args, sqlText) {
        return withMySqlConnection(profile, args.database, async (connection) =>
            queryMySqlTabular(connection, `EXPLAIN ${sqlText}`),
        );
    },
    async exportSchema(profile, args) {
        const targetDatabase = firstNonEmpty(args.database, profile.database);
        return withMySqlConnection(profile, args.database, async (connection) => {
            const tables = await listTableNames(connection);
            const result: ExportedSchema = {
                database: targetDatabase,
                tables: {},
            };

            for (const table of tables) {
                result.tables[table] = await describeTableWithConnection(connection, table);
            }

            return result;
        });
    },
    async findTable(profile, args) {
        const databaseName = resolveMySqlDatabase(profile, args);
        const limit = normalizeLimit(args.limit, 20);
        const pattern = buildContainsPattern(args.search);
        return withMySqlConnection(profile, args.database, async (connection) =>
            queryMySqlTabular(
                connection,
                `
                    SELECT
                        TABLE_SCHEMA AS schema_name,
                        TABLE_NAME AS table_name,
                        TABLE_TYPE AS table_type
                    FROM information_schema.tables
                    WHERE TABLE_SCHEMA = ?
                        AND TABLE_NAME LIKE ? ESCAPE '\\'
                    ORDER BY TABLE_NAME
                    LIMIT ${limit}
                `,
                [databaseName, pattern],
            ),
        );
    },
    async findColumn(profile, args) {
        const databaseName = resolveMySqlDatabase(profile, args);
        const limit = normalizeLimit(args.limit, 20);
        const pattern = buildContainsPattern(args.search);
        return withMySqlConnection(profile, args.database, async (connection) =>
            queryMySqlTabular(
                connection,
                `
                    SELECT
                        TABLE_SCHEMA AS schema_name,
                        TABLE_NAME AS table_name,
                        COLUMN_NAME AS column_name,
                        COLUMN_TYPE AS column_type,
                        IS_NULLABLE AS is_nullable,
                        COLUMN_DEFAULT AS column_default
                    FROM information_schema.columns
                    WHERE TABLE_SCHEMA = ?
                        AND COLUMN_NAME LIKE ? ESCAPE '\\'
                    ORDER BY TABLE_NAME, ORDINAL_POSITION
                    LIMIT ${limit}
                `,
                [databaseName, pattern],
            ),
        );
    },
    async tableStats(profile, args) {
        const table = validateIdentifier(args.table, "table");
        return withMySqlConnection(profile, args.database, async (connection) =>
            queryMySqlTabular(connection, "SHOW TABLE STATUS LIKE ?", [table]),
        );
    },
    async listIndexes(profile, args) {
        const table = validateIdentifier(args.table, "table");
        return withMySqlConnection(profile, args.database, async (connection) => listIndexesWithConnection(connection, table));
    },
    async listForeignKeys(profile, args) {
        const table = validateIdentifier(args.table, "table");
        const databaseName = resolveMySqlDatabase(profile, args);
        return withMySqlConnection(profile, args.database, async (connection) =>
            queryMySqlTabular(
                connection,
                `
                    SELECT
                        CONSTRAINT_NAME AS constraint_name,
                        COLUMN_NAME AS column_name,
                        REFERENCED_TABLE_SCHEMA AS referenced_schema,
                        REFERENCED_TABLE_NAME AS referenced_table,
                        REFERENCED_COLUMN_NAME AS referenced_column
                    FROM information_schema.key_column_usage
                    WHERE TABLE_SCHEMA = ?
                        AND TABLE_NAME = ?
                        AND REFERENCED_TABLE_NAME IS NOT NULL
                    ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION
                `,
                [databaseName, table],
            ),
        );
    },
};

async function describeTableWithConnection(connection: MySQLConnection, table: string): Promise<TableDescription> {
    const columns = await queryMySqlTabular(connection, `SHOW FULL COLUMNS FROM ${quoteMysqlIdentifier(table)}`);
    const createRows = await queryRowsOnly(connection, `SHOW CREATE TABLE ${quoteMysqlIdentifier(table)}`);
    const indexes = await listIndexesWithConnection(connection, table);

    return {
        table,
        columns,
        createStatement: extractCreateStatement(createRows, table),
        indexes,
    };
}

async function listTableNames(connection: MySQLConnection): Promise<string[]> {
    const [rows] = await connection.query("SHOW TABLES");
    return extractSingleColumnStrings(rows).sort();
}

async function listIndexesWithConnection(connection: MySQLConnection, table: string): Promise<TabularData> {
    return queryMySqlTabular(connection, `SHOW INDEX FROM ${quoteMysqlIdentifier(table)}`);
}

async function withMySqlConnection<T>(
    profile: MySqlProfile,
    databaseOverride: string | undefined,
    work: (connection: MySQLConnection) => Promise<T>,
): Promise<T> {
    const connection = await mysql.createConnection({
        host: profile.host,
        port: normalizeMySqlPort(profile.port),
        user: profile.username,
        password: profile.password,
        database: firstNonEmpty(databaseOverride, profile.database) || undefined,
        connectTimeout: 15_000,
        multipleStatements: false,
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
    });

    let result: T | undefined;
    let workError: unknown;

    try {
        result = await work(connection);
    } catch (error) {
        workError = error;
    }

    try {
        await connection.end();
    } catch (closeError) {
        if (workError !== undefined) {
            throw new Error(`${toErrorMessage(workError)}; additionally failed to close MySQL connection: ${toErrorMessage(closeError)}`);
        }
        throw closeError;
    }

    if (workError !== undefined) {
        throw workError;
    }

    return result as T;
}

async function queryRowsOnly(connection: MySQLConnection, sqlText: string, values?: unknown[]): Promise<NormalizedRow[]> {
    const [rows] = values ? await connection.query(sqlText, values) : await connection.query(sqlText);
    return normalizeRows(rows);
}

async function queryMySqlTabular(connection: MySQLConnection, sqlText: string, values?: unknown[]): Promise<TabularData> {
    const [rows, fields] = values ? await connection.query(sqlText, values) : await connection.query(sqlText);
    const normalizedRows = normalizeRows(rows);
    return {
        columns: extractFieldNames(fields, normalizedRows),
        rows: normalizedRows,
    };
}

function extractCreateStatement(rows: NormalizedRow[], table: string): string {
    if (rows.length === 0) {
        throw new Error(`show create table ${JSON.stringify(table)} returned no rows`);
    }

    for (const [column, value] of Object.entries(rows[0])) {
        if (column.toLowerCase() === "create table") {
            return String(value ?? "");
        }
    }

    throw new Error(`show create table ${JSON.stringify(table)} returned no create statement column`);
}

function resolveMySqlDatabase(profile: MySqlProfile, args: CommonToolArgs): string {
    return firstNonEmpty(args.database, profile.database);
}

function normalizeMySqlPort(port: number): number {
    return Number.isInteger(port) && port > 0 ? port : 3306;
}

function quoteMysqlIdentifier(identifier: string): string {
    return `\`${identifier}\``;
}

function formatMySqlTarget(profile: MySqlProfile, databaseOverride?: string): string {
    const databaseName = firstNonEmpty(databaseOverride, profile.database);
    return databaseName === ""
        ? `${profile.host}:${normalizeMySqlPort(profile.port)}`
        : `${profile.host}:${normalizeMySqlPort(profile.port)}/${databaseName}`;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
