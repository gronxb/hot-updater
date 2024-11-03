import type { RpcType } from "@/src-server/rpc";
import { hc } from "hono/client";

export const api = hc<RpcType>("/rpc");
