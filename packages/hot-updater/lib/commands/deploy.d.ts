import { type Platform } from "@hot-updater/internal";
import { z } from "zod";
export interface DeployOptions {
    targetVersion?: string;
    platform: Platform;
    forceUpdate: boolean;
}
export declare const options: z.ZodObject<{
    platform: z.ZodOptional<z.ZodUnion<[z.ZodLiteral<"ios">, z.ZodLiteral<"android">]>>;
    forceUpdate: z.ZodDefault<z.ZodBoolean>;
    targetVersion: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    forceUpdate: boolean;
    platform?: "ios" | "android" | undefined;
    targetVersion?: string | undefined;
    description?: string | undefined;
}, {
    platform?: "ios" | "android" | undefined;
    forceUpdate?: boolean | undefined;
    targetVersion?: string | undefined;
    description?: string | undefined;
}>;
interface Props {
    options: z.infer<typeof options>;
}
export default function Deploy({ options }: Props): import("react/jsx-runtime").JSX.Element | null;
export {};
