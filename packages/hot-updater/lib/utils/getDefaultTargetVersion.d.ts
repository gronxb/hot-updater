import type { Platform } from "@hot-updater/internal";
export declare const getIOSVersion: (cwd: string) => Promise<string | null>;
export declare const getAndroidVersion: (cwd: string) => Promise<string | null>;
export declare const getDefaultTargetVersion: (cwd: string, platform: Platform) => Promise<string | null>;
