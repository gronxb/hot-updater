import type {
  BundleDownloadedInfo,
  UpdateCheckResult,
  UpdateError,
  UpdateHttpResponse,
} from "@hot-updater/protocol";

import type { LaunchReporter } from "./appReady";
import { takeNativeUpdateEvents } from "./native";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Reports the update checks native code ran without JavaScript, such as a
 * brownfield app's native `HotUpdaterInstance`, with the catalog and artifact
 * responses they received, to the instance's plugins before this launch's
 * report, which they precede. Native takes and clears them in one step, so
 * each is reported at most once. A native error carries a message instead of
 * the caught error, and each event keeps the time it happened as
 * `occurredAt`.
 */
export const replayNativeUpdateEvents = (emit: LaunchReporter["emit"]) => {
  let value: string | null;
  try {
    value = takeNativeUpdateEvents();
  } catch {
    return;
  }
  if (value === null) return;

  let entries: unknown;
  try {
    entries = JSON.parse(value);
  } catch {
    return;
  }
  if (!Array.isArray(entries)) return;

  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.payload)) continue;
    const payload =
      typeof entry.occurredAt === "number"
        ? { ...entry.payload, occurredAt: entry.occurredAt }
        : entry.payload;
    switch (entry.name) {
      case "onUpdateCheck":
        emit("onUpdateCheck", () => payload as unknown as UpdateCheckResult);
        break;
      case "onBundleDownloaded":
        emit(
          "onBundleDownloaded",
          () => payload as unknown as BundleDownloadedInfo,
        );
        break;
      case "onHttpResponse":
        emit("onHttpResponse", () => payload as unknown as UpdateHttpResponse);
        break;
      case "onUpdateError": {
        const { message, ...error } = payload;
        emit(
          "onUpdateError",
          () =>
            ({
              ...error,
              cause: new Error(
                typeof message === "string"
                  ? message
                  : "The native update check failed",
              ),
            }) as unknown as UpdateError,
        );
        break;
      }
    }
  }
};
