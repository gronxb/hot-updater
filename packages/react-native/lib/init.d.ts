import type { UpdateSourceArg } from "@hot-updater/internal";
import { HotUpdaterError } from "./error";
export type HotUpdaterStatus = "INSTALLING_UPDATE" | "UP_TO_DATE";
export interface HotUpdaterInitConfig {
    source: UpdateSourceArg;
    onSuccess?: (status: HotUpdaterStatus) => void;
    onError?: (error: HotUpdaterError) => void;
}
export declare const init: (config: HotUpdaterInitConfig) => Promise<void>;
