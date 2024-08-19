import type { HotUpdaterReadStrategy, MetaDataOptions, Version } from "./types";
export interface HotUpdaterOptions {
    config: HotUpdaterReadStrategy;
}
export declare class HotUpdater {
    private config;
    private sqids;
    constructor({ config }: HotUpdaterOptions);
    encodeVersion(version: Version): string;
    decodeVersion(hash: string): string;
    getVersionList(): Promise<string[]>;
    getMetaData({ version, reloadAfterUpdate, }: MetaDataOptions): Promise<{
        files: string[];
        id: string;
        version: Version;
        reloadAfterUpdate: boolean;
    }>;
    static create(options: HotUpdaterOptions): HotUpdater;
}
