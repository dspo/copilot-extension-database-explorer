import type { NormalizedRow, NormalizedValue, TabularData } from "./types";

export const DEFAULT_LIMIT = 10;
export const DEFAULT_SEARCH_LIMIT = 20;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/;
const SELECT_PATTERN = /^\s*select\b/is;
const SHOW_CREATE_TABLE_PATTERN = /^\s*show\s+create\s+table\b/is;
const LIMIT_PATTERN = /\blimit\b/is;

export function validateSelectStatement(sqlText: string): string {
    const trimmed = String(sqlText ?? "").trim().replace(/;+$/u, "").trim();
    if (trimmed.length === 0) {
        throw new Error("query cannot be empty");
    }
    if (trimmed.includes(";")) {
        throw new Error("multiple statements are not allowed");
    }
    if (SHOW_CREATE_TABLE_PATTERN.test(trimmed)) {
        throw new Error(
            "safety restriction: only SELECT queries are allowed; use database_explorer_show_create_table (or database_explorer_describe_table) instead",
        );
    }
    if (!SELECT_PATTERN.test(trimmed)) {
        throw new Error("safety restriction: only SELECT queries are allowed");
    }

    return trimmed;
}

export function prepareReadOnlyQuery(sqlText: string, limit?: number): string {
    const trimmed = validateSelectStatement(sqlText);
    const normalizedLimit = normalizeLimit(limit);
    if (LIMIT_PATTERN.test(trimmed)) {
        return trimmed;
    }

    return `${trimmed} LIMIT ${normalizedLimit}`;
}

export function prepareExplainQuery(sqlText: string): string {
    return validateSelectStatement(sqlText);
}

export function validateIdentifier(identifier: string, label: string): string {
    const trimmed = String(identifier ?? "").trim();
    if (!IDENTIFIER_PATTERN.test(trimmed)) {
        throw new Error(`invalid ${label} ${JSON.stringify(identifier)}`);
    }
    return trimmed;
}

export function normalizeLimit(limit: number | undefined, defaultValue = DEFAULT_LIMIT): number {
    if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) {
        return limit;
    }
    return defaultValue;
}

export function buildContainsPattern(search: string): string {
    const trimmed = String(search ?? "").trim();
    if (trimmed === "") {
        throw new Error("search is required");
    }
    const escaped = trimmed.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    return `%${escaped}%`;
}

export function stringOrEmpty(value: unknown): string {
    return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

export function firstNonEmpty(...values: Array<unknown>): string {
    for (const value of values) {
        const normalized = stringOrEmpty(value);
        if (normalized !== "") {
            return normalized;
        }
    }
    return "";
}

export function normalizeRows(rows: unknown): NormalizedRow[] {
    if (!Array.isArray(rows)) {
        return [];
    }

    const normalizedRows: NormalizedRow[] = [];
    for (const row of rows) {
        if (!isRecord(row)) {
            continue;
        }

        const normalized: NormalizedRow = {};
        for (const [key, value] of Object.entries(row)) {
            normalized[key] = normalizeValue(value);
        }
        normalizedRows.push(normalized);
    }

    return normalizedRows;
}

export function normalizeValue(value: unknown): NormalizedValue {
    if (value == null) {
        return null;
    }
    if (Buffer.isBuffer(value)) {
        return value.toString("utf8");
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value).toString("utf8");
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => normalizeValue(item));
    }
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]));
    }

    return String(value);
}

export function extractFieldNames(fields: unknown, rows: NormalizedRow[]): string[] {
    if (!Array.isArray(fields)) {
        return inferColumns(rows);
    }

    const names = fields
        .map((field) => {
            if (!isRecord(field) || !("name" in field)) {
                return "";
            }
            return String(field.name ?? "");
        })
        .filter((name) => name !== "");

    return names.length > 0 ? names : inferColumns(rows);
}

export function inferColumns(rows: NormalizedRow[]): string[] {
    if (rows.length === 0) {
        return [];
    }
    return Object.keys(rows[0]);
}

export function tabularFromRows(rows: NormalizedRow[], columns?: string[]): TabularData {
    return {
        columns: columns && columns.length > 0 ? columns : inferColumns(rows),
        rows,
    };
}

export function extractSingleColumnStrings(rows: unknown): string[] {
    return normalizeRows(rows)
        .map((row) => {
            const value = Object.values(row)[0];
            return value == null ? "" : String(value);
        })
        .filter((value) => value !== "");
}

export function readNormalizedString(row: NormalizedRow, key: string): string {
    return stringOrEmpty(row[key]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
