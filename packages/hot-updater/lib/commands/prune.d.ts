import type { Platform } from "@hot-updater/internal";
import { z } from "zod";
export interface PruneOptions {
    platform?: Platform;
}
export declare const options: z.ZodObject<{
    platform: z.ZodUnion<[z.ZodLiteral<"ios">, z.ZodLiteral<"android">]>;
}, "strip", z.ZodTypeAny, {
    platform: "ios" | "android";
}, {
    platform: "ios" | "android";
}>;
interface Props {
    options: z.infer<typeof options>;
}
export default function Prune({ options }: Props): import("react/jsx-runtime").JSX.Element;
export {};
