import type { UpdateSource } from "./types";
export interface NextUpdateOptions {
    files: string[];
    platform: "ios" | "android";
    targetVersion: string;
    forceUpdate?: boolean;
}
export declare const getNextUpdate: (options: NextUpdateOptions) => Promise<UpdateSource>;
