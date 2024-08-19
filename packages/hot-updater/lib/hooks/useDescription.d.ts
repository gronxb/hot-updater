import type { Platform } from "@hot-updater/internal";
export interface PlatformSelectProps {
    onNext?: (description: Platform) => void;
}
export declare const useDescription: (description: string | undefined) => {
    platform: string | undefined;
    PlatformSelect: ({ onNext }: PlatformSelectProps) => import("react/jsx-runtime").JSX.Element;
};
