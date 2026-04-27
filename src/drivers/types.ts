export type DatabaseDriver = "mysql" | "postgres" | "sqlite";

export type NormalizedScalar = string | number | boolean | null;
export type NormalizedValue = NormalizedScalar | NormalizedValue[] | { [key: string]: NormalizedValue };
export type NormalizedRow = Record<string, NormalizedValue>;

export interface BaseProfile {
    description: string;
    driver: DatabaseDriver;
}

export interface MySqlProfile extends BaseProfile {
    driver: "mysql";
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
}

export interface PostgresProfile extends BaseProfile {
    driver: "postgres";
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    schema: string;
    ssl: boolean;
}

export interface SqliteProfile extends BaseProfile {
    driver: "sqlite";
    path: string;
    namespace: string;
}

export type Profile = MySqlProfile | PostgresProfile | SqliteProfile;

export interface Config {
    databases: Record<string, Profile>;
}

export interface CommonToolArgs {
    config?: string;
    db?: string;
    database?: string;
    schema?: string;
}

export interface TableToolArgs extends CommonToolArgs {
    table: string;
}

export interface SampleRowsArgs extends TableToolArgs {
    limit?: number;
}

export interface QueryArgs extends CommonToolArgs {
    sql: string;
    limit?: number;
}

export interface SearchArgs extends CommonToolArgs {
    search: string;
    limit?: number;
}

export interface TabularData {
    columns: string[];
    rows: NormalizedRow[];
}

export interface TableDescription {
    table: string;
    columns: TabularData;
    createStatement: string;
    indexes: TabularData;
}

export interface ExportedSchema {
    database: string;
    tables: Record<string, TableDescription>;
}

export interface DatabaseSummary {
    alias: string;
    description: string;
    driver: string;
    target: string;
    host?: string;
    port?: number;
    database?: string;
    schema?: string;
    path?: string;
}

export interface ConnectionProbe {
    target: string;
    version: string;
    details: Record<string, NormalizedValue>;
    currentDatabase?: string;
    currentSchema?: string;
}

export interface HealthProbe extends ConnectionProbe {
    latencyMs: number;
}

export interface ConnectionTestResult {
    alias: string;
    driver: DatabaseDriver;
    usable: true;
    target: string;
    version: string;
    details: Record<string, NormalizedValue>;
}

export interface HealthCheckResult extends ConnectionTestResult {
    mode: "quick" | "full";
    latencyMs?: number;
    currentDatabase?: string;
    currentSchema?: string;
}

export interface DatabaseDriverAdapter<TProfile extends Profile = Profile> {
    readonly driver: TProfile["driver"];
    summarize(alias: string, profile: TProfile): DatabaseSummary;
    testConnection(profile: TProfile, args: CommonToolArgs): Promise<ConnectionProbe>;
    healthCheck(profile: TProfile, args: CommonToolArgs): Promise<HealthProbe>;
    listSchemas(profile: TProfile, args: CommonToolArgs): Promise<string[]>;
    listTables(profile: TProfile, args: CommonToolArgs): Promise<string[]>;
    listColumns(profile: TProfile, args: TableToolArgs): Promise<TabularData>;
    describeTable(profile: TProfile, args: TableToolArgs): Promise<TableDescription>;
    sampleRows(profile: TProfile, args: SampleRowsArgs): Promise<TabularData>;
    query(profile: TProfile, args: QueryArgs, sqlText: string): Promise<TabularData>;
    explainQuery(profile: TProfile, args: QueryArgs, sqlText: string): Promise<TabularData>;
    exportSchema(profile: TProfile, args: CommonToolArgs): Promise<ExportedSchema>;
    findTable(profile: TProfile, args: SearchArgs): Promise<TabularData>;
    findColumn(profile: TProfile, args: SearchArgs): Promise<TabularData>;
    tableStats(profile: TProfile, args: TableToolArgs): Promise<TabularData>;
    listIndexes(profile: TProfile, args: TableToolArgs): Promise<TabularData>;
    listForeignKeys(profile: TProfile, args: TableToolArgs): Promise<TabularData>;
}
