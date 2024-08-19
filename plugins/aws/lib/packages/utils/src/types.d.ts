export interface HotUpdaterReadStrategy {
    getListObjects(prefix?: string): Promise<string[]>;
}
export interface PluginArgs {
    platform: "ios" | "android";
    cwd: string;
    server: string;
    secretKey: string;
}
