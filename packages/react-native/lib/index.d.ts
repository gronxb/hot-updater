export type * from "./init";
export type * from "./checkForUpdate";
export type * from "./native";
export declare const HotUpdater: {
    init: (config: import("./init").HotUpdaterInitConfig) => Promise<void>;
    reload: () => void;
    checkForUpdate: (updateSources: import("@hot-updater/internal").UpdateSourceArg) => Promise<{
        bundleVersion: number;
        forceUpdate: boolean;
        file: null;
        hash: null;
        status: import("./checkForUpdate").UpdateStatus;
    } | {
        bundleVersion: number;
        forceUpdate: boolean;
        file: string;
        hash: string;
        status: import("./checkForUpdate").UpdateStatus;
    } | null>;
    getAppVersion: () => Promise<string | null>;
    getBundleVersion: () => Promise<number>;
};
