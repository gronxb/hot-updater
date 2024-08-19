import { type DeployPlugin, type Platform } from "@hot-updater/internal";
export interface UpdateSourcesOptions {
    deployPlugin: DeployPlugin;
    targetVersion?: string;
    platform?: Platform;
}
export declare const useUpdateSources: (options: UpdateSourcesOptions) => {
    updateSources: import("@hot-updater/internal").UpdateSource[];
    refresh: () => Promise<import("@hot-updater/internal").UpdateSource[] | null>;
};
