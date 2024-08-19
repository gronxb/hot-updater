export interface UpdateSource {
    [appVersion: string]: {
        bundleVersion: number;
        forceUpdate: boolean;
        enabled: boolean;
        files: string[];
    }[];
}
export type UpdateSourceArg = string | UpdateSource | (() => Promise<UpdateSource>) | (() => UpdateSource);
