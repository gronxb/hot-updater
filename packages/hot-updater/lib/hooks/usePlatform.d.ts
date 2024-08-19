import type { Platform } from "@hot-updater/internal";
export interface PlatformSelectProps {
    onNext?: (platform: Platform) => void;
}
export declare const usePlatform: (initialPlatform: Platform | undefined) => {
    platform: "ios" | "android" | undefined;
    PlatformSelect: ({ onNext }: PlatformSelectProps) => import("react/jsx-runtime").JSX.Element;
};
