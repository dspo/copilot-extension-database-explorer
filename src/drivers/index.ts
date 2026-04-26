import { mysqlDriver } from "./mysql";
import { postgresDriver } from "./postgres";
import { sqliteDriver } from "./sqlite";
import type { DatabaseDriver, DatabaseDriverAdapter, Profile } from "./types";

const DRIVER_ADAPTERS: Record<DatabaseDriver, DatabaseDriverAdapter> = {
    mysql: mysqlDriver,
    postgres: postgresDriver,
    sqlite: sqliteDriver,
};

export function getDriverAdapter<TProfile extends Profile>(driver: TProfile["driver"]): DatabaseDriverAdapter<TProfile> {
    return DRIVER_ADAPTERS[driver] as DatabaseDriverAdapter<TProfile>;
}
