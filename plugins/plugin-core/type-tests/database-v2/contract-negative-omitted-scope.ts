import type { DatabaseConnectionV2 } from "@hot-updater/plugin-core/database-v2";

declare const connection: DatabaseConnectionV2<unknown>;

void connection.openSession();
