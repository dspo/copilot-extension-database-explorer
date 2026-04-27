import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import initSqlJs from "sql.js";

const require = createRequire(import.meta.url);
const runtime = require("../dist/runtime.cjs");
const tempDir = await mkdtemp(join(tmpdir(), "dbexp-smoke-"));

try {
    const SQL = await initSqlJs({
        locateFile: (file) => join(process.cwd(), "dist", file),
    });
    const db = new SQL.Database();
    db.run("PRAGMA foreign_keys = ON;");
    db.run("CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");
    db.run(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL, email TEXT NOT NULL, FOREIGN KEY(team_id) REFERENCES teams(id));",
    );
    db.run("CREATE INDEX idx_users_email ON users(email);");
    db.run("INSERT INTO teams (name) VALUES ('Platform'), ('Infra');");
    db.run("INSERT INTO users (team_id, email) VALUES (1, 'ada@example.com'), (2, 'grace@example.com');");

    const dbPath = join(tempDir, "app.sqlite");
    await writeFile(dbPath, Buffer.from(db.export()));
    db.close();

    const config = JSON.stringify({
        name: "local",
        driver: "sqlite",
        path: dbPath,
    });

    const tools = runtime.createDatabaseExplorerTools({ getCwd: () => tempDir });

    async function runTool(name, args = {}) {
        const tool = tools.find((entry) => entry.name === name);
        if (!tool) {
            throw new Error(`missing tool ${name}`);
        }
        const result = await tool.handler({ ...args, config, db: "local" });
        if (result.resultType !== "success") {
            throw new Error(`${name} failed: ${result.textResultForLlm}`);
        }
        return JSON.parse(result.textResultForLlm);
    }

    if (tools.length !== 15) {
        throw new Error(`expected 15 tools, received ${tools.length}`);
    }

    const healthQuick = await runTool("database_explorer_health_check", { mode: "quick" });
    const healthFull = await runTool("database_explorer_health_check", { mode: "full" });
    const findTable = await runTool("database_explorer_find_table", { search: "us" });
    const findColumn = await runTool("database_explorer_find_column", { search: "email" });
    const listColumns = await runTool("database_explorer_list_columns", { table: "users" });
    const describeTable = await runTool("database_explorer_describe_table", { table: "users" });
    const explain = await runTool("database_explorer_explain_query", {
        sql: 'SELECT * FROM users WHERE email = "ada@example.com"',
    });
    const tableStats = await runTool("database_explorer_table_stats", { table: "users" });
    const indexes = await runTool("database_explorer_list_indexes", { table: "users" });
    const foreignKeys = await runTool("database_explorer_list_foreign_keys", { table: "users" });

    if (healthQuick.usable !== true || healthQuick.mode !== "quick") {
        throw new Error("health_check quick mode did not report expected result");
    }
    if (healthFull.usable !== true || healthFull.mode !== "full" || typeof healthFull.latencyMs !== "number") {
        throw new Error("health_check full mode did not report expected result");
    }
    if (findTable.rows.length !== 1 || findTable.rows[0].table_name !== "users") {
        throw new Error("find_table did not locate users");
    }
    if (findColumn.rows.length !== 1 || findColumn.rows[0].column_name !== "email") {
        throw new Error("find_column did not locate email");
    }
    if (listColumns.rows.length !== 3) {
        throw new Error("list_columns did not return the expected columns");
    }
    if (typeof describeTable.createStatement !== "string" || describeTable.createStatement.trim() === "") {
        throw new Error("describe_table did not return a create statement");
    }
    if (!describeTable.foreignKeys || !Array.isArray(describeTable.foreignKeys.rows) || describeTable.foreignKeys.rows.length === 0) {
        throw new Error("describe_table did not return foreign keys");
    }
    if (explain.rows.length === 0) {
        throw new Error("explain_query returned no plan rows");
    }
    if (tableStats.rows.length !== 1) {
        throw new Error("table_stats returned no summary");
    }
    if (indexes.rows.length === 0) {
        throw new Error("list_indexes returned no indexes");
    }
    if (foreignKeys.rows.length === 0) {
        throw new Error("list_foreign_keys returned no foreign keys");
    }

    console.log("SQLite smoke test passed");
} finally {
    await rm(tempDir, { recursive: true, force: true });
}
