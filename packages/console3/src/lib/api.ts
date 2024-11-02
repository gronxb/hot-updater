import type { AppType } from "@/src-server/index";
import { hc } from "hono/client";

export const api = hc<AppType>("/");
