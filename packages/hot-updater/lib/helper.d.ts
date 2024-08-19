import type { BasePluginArgs, BuildPluginArgs, DeployPlugin } from "@hot-updater/internal";
export type Config = {
    server: string;
    secretKey: string;
    build: (args: BuildPluginArgs) => Promise<{
        buildPath: string;
        outputs: string[];
    }>;
    deploy: (args: BasePluginArgs) => DeployPlugin;
};
export declare const defineConfig: (config: Config | (() => Config)) => Config;
