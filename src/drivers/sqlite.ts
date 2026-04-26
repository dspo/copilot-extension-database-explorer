import { readFile } from "node:fs/promises";
import { join } from "node:path";

import initSqlJs, { type Database, type QueryExecResult, type SqlJsStatic, type SqlValue } from "sql.js";

import {
    buildContainsPattern,
    extractSingleColumnStrings,
    firstNonEmpty,
    normalizeLimit,
    normalizeValue,
    tabularFromRows,
    validateIdentifier,
} from "./shared";
import type {
    CommonToolArgs,
    ConnectionProbe,
    DatabaseDriverAdapter,
    ExportedSchema,
    NormalizedRow,
    QueryArgs,
    SampleRowsArgs,
    SearchArgs,
    SqliteProfile,
    TableDescription,
    TableToolArgs,
    TabularData,
} from "./types";

let sqliteModulePromise: Promise<SqlJsStatic> | undefined;

export const sqliteDriver: DatabaseDriverAdapter<SqliteProfile> = {
    driver: "sqlite",
    summarize(alias, profile) {
        return {
            alias,
            description: firstNonEmpty(profile.description, "No description"),
            driver: profile.driver,
            target: profile.path,
            path: profile.path,
            schema: profile.namespace,
        };
    },
    async testConnection(profile, args) {
        return withSqliteDatabase(profile, async (database) => {
            const namespace = resolveSqliteNamespace(profile, args);
            ensureSqliteNamespaceExists(database, namespace);
            const result = querySqliteTabular(database, "SELECT sqlite_version() AS version, 1 AS ok");
            const versionRow = result.rows[0] ?? {};
            const details = {
                ...versionRow,
                namespace,
            };
            return {
                target: profile.path,
                version: firstNonEmpty(versionRow.version, "unknown"),
                currentDatabase: namespace,
                currentSchema: namespace,
                details,
            };
        });
    },
    async healthCheck(profile, args) {
        return withSqliteDatabase(profile, async (database) => {
            const namespace = resolveSqliteNamespace(profile, args);
            ensureSqliteNamespaceExists(database, namespace);

            const startedAt = Date.now();
            const versionResult = querySqliteTabular(database, "SELECT sqlite_version() AS version, 1 AS ok");
            const latencyMs = Date.now() - startedAt;
            const pageCount = querySqliteScalar(database, "PRAGMA page_count");
            const pageSize = querySqliteScalar(database, "PRAGMA page_size");
            const freeList = querySqliteScalar(database, "PRAGMA freelist_count");
            const quickCheck = querySqliteScalar(database, "PRAGMA quick_check");
            const versionRow = versionResult.rows[0] ?? {};
            const details = {
                ...versionRow,
                namespace,
                page_count: pageCount,
                page_size: pageSize,
                freelist_count: freeList,
                quick_check: quickCheck,
            };

            return {
                target: profile.path,
                version: firstNonEmpty(versionRow.version, "unknown"),
                currentDatabase: namespace,
                currentSchema: namespace,
                latencyMs,
                details,
            };
        });
    },
    async listSchemas(profile) {
        return withSqliteDatabase(profile, async (database) => listNamespaces(database));
    },
    async listTables(profile, args) {
        const namespace = resolveSqliteNamespace(profile, args);
        return withSqliteDatabase(profile, async (database) => listTableNames(database, namespace));
    },
    async listColumns(profile, args) {
        const namespace = resolveSqliteNamespace(profile, args);
        const table = validateIdentifier(args.table, "table");
        return withSqliteDatabase(profile, async (database) => listColumnsWithDatabase(database, namespace, table));
    },
    async describeTable(profile, args) {
        const namespace = resolveSqliteNamespace(profile, args);
        const table = validateIdentifier(args.table, "table");
        return withSqliteDatabase(profile, async (database) => describeTableWithDatabase(database, namespace, table));
    },
    async sampleRows(profile, args) {
        const namespace = resolveSqliteNamespace(profile, args);
        const table = validateIdentifier(args.table, "table");
        const limit = normalizeLimit(args.limit);
        return withSqliteDatabase(profile, async (database) => {
            ensureSqliteNamespaceExists(database, namespace);
            return querySqliteTabular(database, `SELECT * FROM ${qualifySqliteTable(namespace, table)} LIMIT ${limit}`);
        });
    },
    async query(profile, args, sqlText) {
        return withSqliteDatabase(profile, async (database) => querySqliteTabular(database, sqlText));
    },
    async explainQuery(profile, args, sqlText) {
        return withSqliteDatabase(profile, async (database) => querySqliteTabular(database, `EXPLAIN QUERY PLAN ${sqlText}`));
    },
    async exportSchema(profile, args) {
        const namespace = resolveSqliteNamespace(profile, args);
        return withSqliteDatabase(profile, async (database) => {
            const tables = await listTableNames(database, namespace);
            const result: ExportedSchema = {
                database: `${profile.path}#${namespace}`,
                tables: {},
            };

            for (const table of tables) {
                result.tables[table] = await describeTableWithDatabase(database, namespace, table);
            }

            return result;
        });
    },
    async findTable(profile, args) {
        const namespace = resolveSqliteNamespace(profile, args);
        const limit = normalizeLimit(args.limit, 20);
        const pattern = buildContainsPattern(args.search);
        return withSqliteDatabase(profile, async (database) => {
            ensureSqliteNamespaceExists(database, namespace);
            return querySqliteTabular(
                database,
                `SELECT name AS table_name, type AS table_type FROM ${quoteSqliteIdentifier(namespace)}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ${limit}`,
                [pattern],
            );
        });
    },
    async findColumn(profile, args) {
        const namespace = resolveSqliteNamespace(profile, args);
        const limit = normalizeLimit(args.limit, 20);
        const searchTerm = String(args.search ?? "").trim().toLowerCase();
        if (searchTerm === "") {
            throw new Error("search is required");
        }

        return withSqliteDatabase(profile, async (database) => {
            const tables = await listTableNames(database, namespace);
            const matches: NormalizedRow[] = [];

            for (const table of tables) {
                const columns = await listColumnsWithDatabase(database, namespace, table);
                for (const row of columns.rows) {
                    const columnName = String(row.name ?? "").toLowerCase();
                    if (!columnName.includes(searchTerm)) {
                        continue;
                    }
                    matches.push({
                        table_name: table,
                        column_name: row.name ?? "",
                        data_type: row.type ?? "",
                        is_nullable: Number(row.notnull ?? 0) === 1 ? "NO" : "YES",
                        column_default: row.dflt_value ?? null,
                        pk: row.pk ?? 0,
                    });
                    if (matches.length >= limit) {
                        return tabularFromRows(matches, [
                            "table_name",
                            "column_name",
                            "data_type",
                            "is_nullable",
                            "column_default",
                            "pk",
                        ]);
                    }
                }
            }

            return tabularFromRows(matches, [
                "table_name",
                "column_name",
                "data_type",
                "is_nullable",
                "column_default",
                "pk",
            ]);
        });
    },
    async tableStats(profile, args) {
        const namespace = resolveSqliteNamespace(profile, args);
        const table = validateIdentifier(args.table, "table");
        return withSqliteDatabase(profile, async (database) => {
            ensureSqliteNamespaceExists(database, namespace);
            const rowCount = querySqliteScalar(database, `SELECT COUNT(*) AS value FROM ${qualifySqliteTable(namespace, table)}`);
            const pageCount = querySqliteScalar(database, "PRAGMA page_count");
            const pageSize = querySqliteScalar(database, "PRAGMA page_size");
            const freeList = querySqliteScalar(database, "PRAGMA freelist_count");
            return tabularFromRows(
                [
                    {
                        table_name: table,
                        row_count: rowCount,
                        page_count: pageCount,
                        page_size: pageSize,
                        freelist_count: freeList,
                        file_bytes: typeof pageCount === "number" && typeof pageSize === "number" ? pageCount * pageSize : null,
                    },
                ],
                ["table_name", "row_count", "page_count", "page_size", "freelist_count", "file_bytes"],
            );
        });
    },
    async listIndexes(profile, args) {
        const namespace = resolveSqliteNamespace(profile, args);
        const table = validateIdentifier(args.table, "table");
        return withSqliteDatabase(profile, async (database) => {
            ensureSqliteNamespaceExists(database, namespace);
            return querySqliteTabular(database, `PRAGMA ${quoteSqliteIdentifier(namespace)}.index_list(${quoteSqliteIdentifier(table)})`);
        });
    },
    async listForeignKeys(profile, args) {
        const namespace = resolveSqliteNamespace(profile, args);
        const table = validateIdentifier(args.table, "table");
        return withSqliteDatabase(profile, async (database) => {
            ensureSqliteNamespaceExists(database, namespace);
            return querySqliteTabular(
                database,
                `PRAGMA ${quoteSqliteIdentifier(namespace)}.foreign_key_list(${quoteSqliteIdentifier(table)})`,
            );
        });
    },
};

async function describeTableWithDatabase(database: Database, namespace: string, table: string): Promise<TableDescription> {
    const columns = await listColumnsWithDatabase(database, namespace, table);
    const indexes = querySqliteTabular(
        database,
        `PRAGMA ${quoteSqliteIdentifier(namespace)}.index_list(${quoteSqliteIdentifier(table)})`,
    );
    const createStatement = querySqliteScalar(
        database,
        `SELECT sql AS value FROM ${quoteSqliteIdentifier(namespace)}.sqlite_master WHERE type = 'table' AND name = ?`,
        [table],
    );

    if (typeof createStatement !== "string" || createStatement.trim() === "") {
        throw new Error(`sqlite schema lookup for table ${JSON.stringify(table)} returned no sql definition`);
    }

    return {
        table,
        columns,
        createStatement,
        indexes,
    };
}

async function listColumnsWithDatabase(database: Database, namespace: string, table: string): Promise<TabularData> {
    ensureSqliteNamespaceExists(database, namespace);
    return querySqliteTabular(
        database,
        `PRAGMA ${quoteSqliteIdentifier(namespace)}.table_info(${quoteSqliteIdentifier(table)})`,
    );
}

async function listTableNames(database: Database, namespace: string): Promise<string[]> {
    ensureSqliteNamespaceExists(database, namespace);
    const result = querySqliteTabular(
        database,
        `SELECT name FROM ${quoteSqliteIdentifier(namespace)}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    return extractSingleColumnStrings(result.rows).sort();
}

async function withSqliteDatabase<T>(profile: SqliteProfile, work: (database: Database) => Promise<T> | T): Promise<T> {
    const sqlite = await getSqlJs();
    const bytes = await readFile(profile.path);
    const database = new sqlite.Database(bytes);

    try {
        return await work(database);
    } finally {
        database.close();
    }
}

async function getSqlJs(): Promise<SqlJsStatic> {
    if (!sqliteModulePromise) {
        sqliteModulePromise = initSqlJs({
            locateFile: (file) => join(__dirname, file),
        });
    }
    return sqliteModulePromise;
}

function querySqliteScalar(database: Database, sqlText: string, params?: SqlValue[]): string | number | boolean | null {
    const result = querySqliteTabular(database, sqlText, params);
    if (result.rows.length === 0) {
        return null;
    }
    const value = Object.values(result.rows[0])[0];
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null ? value : String(value);
}

function querySqliteTabular(database: Database, sqlText: string, params?: SqlValue[]): TabularData {
    const results = params ? database.exec(sqlText, params) : database.exec(sqlText);
    const firstResult = results[0];
    if (!firstResult) {
        return {
            columns: [],
            rows: [],
        };
    }

    const rows = firstResult.values.map((rowValues) =>
        Object.fromEntries(firstResult.columns.map((column, index) => [column, normalizeValue(rowValues[index])])),
    );
    return {
        columns: firstResult.columns,
        rows,
    };
}

function listNamespaces(database: Database): string[] {
    const result = querySqliteTabular(database, "PRAGMA database_list");
    return result.rows
        .map((row) => firstNonEmpty(row.name))
        .filter((name) => name !== "")
        .sort();
}

function ensureSqliteNamespaceExists(database: Database, namespace: string): void {
    const namespaces = listNamespaces(database);
    if (!namespaces.includes(namespace)) {
        throw new Error(`sqlite namespace ${JSON.stringify(namespace)} not found; available: ${namespaces.join(", ")}`);
    }
}

function resolveSqliteNamespace(profile: SqliteProfile, args: CommonToolArgs): string {
    return validateIdentifier(firstNonEmpty(args.schema, args.database, profile.namespace, "main"), "namespace");
}

function qualifySqliteTable(namespace: string, table: string): string {
    return `${quoteSqliteIdentifier(namespace)}.${quoteSqliteIdentifier(table)}`;
}

function quoteSqliteIdentifier(identifier: string): string {
    return `"${identifier}"`;
}
