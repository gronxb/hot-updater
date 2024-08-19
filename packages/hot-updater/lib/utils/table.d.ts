import type { UpdateSource } from "@hot-updater/internal";
import Table from "cli-table3";
export declare const createTable: () => {
    table: Table.Table;
    pushTable: (source: UpdateSource) => void;
};
