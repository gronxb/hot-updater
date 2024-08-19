/// <reference types="react" />
import type { Config } from "./helper.js";
export interface CliContextValue {
    config: Config;
    cwd: string;
}
export declare const CliContext: import("react").Context<CliContextValue | null>;
export declare const useLoadConfig: () => Config;
export declare const useCwd: () => string;
