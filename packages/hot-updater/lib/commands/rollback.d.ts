import type { Platform } from "@hot-updater/internal";
import { z } from "zod";
export interface RollbackOptions {
    platform?: Platform;
    targetVersion?: string;
}
export declare const options: z.ZodObject<{
    platform: z.ZodOptional<z.ZodUnion<[z.ZodLiteral<"ios">, z.ZodLiteral<"android">]>>;
    targetVersion: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    platform?: "ios" | "android" | undefined;
    targetVersion?: string | undefined;
}, {
    platform?: "ios" | "android" | undefined;
    targetVersion?: string | undefined;
}>;
interface Props {
    options: z.infer<typeof options>;
}
export default function Rollback({ options }: Props): import("react/jsx-runtime").JSX.Element;
export {};
