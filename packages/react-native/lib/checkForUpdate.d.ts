import type { UpdateSourceArg } from "@hot-updater/internal";
export type UpdateStatus = "ROLLBACK" | "UPDATE";
export declare const checkForUpdate: (updateSources: UpdateSourceArg) => Promise<{
    bundleVersion: number;
    forceUpdate: boolean;
    file: null;
    hash: null;
    status: UpdateStatus;
} | {
    bundleVersion: number;
    forceUpdate: boolean;
    file: string;
    hash: string;
    status: UpdateStatus;
} | null>;
