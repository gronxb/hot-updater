import { createAgentDeviceClient, isAgentDeviceError } from "agent-device";

import type { MobileContext } from "./context.ts";

export type IosAlert = { title: string; buttons: string[] };

export function createIosAlertReader(
  target: Pick<MobileContext, "session" | "deviceId">,
  readSignal: () => AbortSignal,
  client = createAgentDeviceClient({ session: `${target.session}-0` }),
) {
  return {
    async get(): Promise<IosAlert | null> {
      const signal = readSignal();
      signal.throwIfAborted();
      try {
        // SDK 0.10.0 uses <session>-<worker slot>; this runner fixes workers=1.
        // alert get is a presented-surface query, unlike app snapshots which
        // can activate a background AUT. The pinned SDK bounds the native
        // getter at 10s and its RPC at 90s; private daemon teardown drains it.
        const value = await client.command.alert({
          action: "get",
          platform: "ios",
          udid: target.deviceId,
        });
        signal.throwIfAborted();
        if (
          typeof value.message !== "string" ||
          !Array.isArray(value.items) ||
          !value.items.every((item) => typeof item === "string")
        ) {
          throw new Error("Native iOS alert returned an invalid presentation");
        }
        return { title: value.message, buttons: value.items };
      } catch (error) {
        signal.throwIfAborted();
        if (
          isAgentDeviceError(error) &&
          (error.code === "ALERT_NOT_FOUND" ||
            error.details?.runnerErrorCode === "ALERT_NOT_FOUND" ||
            error.details?.reason === "alert-not-found")
        )
          return null;
        throw error;
      }
    },
  };
}
