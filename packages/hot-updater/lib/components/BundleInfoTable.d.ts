import type { UpdateSource } from "@hot-updater/internal";
export declare const BundleInfoTable: ({ source, renders, widths, }: {
    source: UpdateSource;
    renders?: {
        active?: () => React.ReactNode;
        createdAt?: () => React.ReactNode;
        platform?: () => React.ReactNode;
        description?: () => React.ReactNode;
        forceUpdate?: () => React.ReactNode;
    };
    widths?: {
        active?: number;
        createdAt?: number;
        platform?: number;
        description?: number;
        forceUpdate?: number;
    };
}) => import("react/jsx-runtime").JSX.Element;
