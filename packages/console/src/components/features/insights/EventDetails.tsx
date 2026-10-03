import {
  Activity,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";

import { HashValueDisplay } from "@/components/HashValueDisplay";
import { Badge } from "@/components/ui/badge";
import { describeFailure } from "@/lib/insights-failures";
import type { InsightsEventRow } from "@/lib/insights-view";

type EventHistoryRow = InsightsEventRow;

const eventTypes = {
  UPDATE_DOWNLOADED: {
    label: "Downloaded",
    description:
      "Download complete. Waiting for the app to restart and apply it.",
    variant: "default",
    icon: Download,
  },
  UPDATE_APPLIED: {
    label: "Update applied",
    description: "The app started using the downloaded update.",
    variant: "success",
    icon: Check,
  },
  RECOVERED: {
    label: "Recovered",
    description: "Recovered from a crashed bundle.",
    variant: "warning",
    icon: RotateCcw,
  },
  UPDATE_FAILED: {
    label: "Update failed",
    description: "An update check, download, or install failed.",
    variant: "destructive",
    icon: CircleAlert,
  },
  UNCHANGED: {
    label: "No change",
    description: "No download or apply was reported at this point.",
    variant: "secondary",
    icon: Activity,
  },
} as const;

export function useInsightsTimeFormat() {
  const [timeZone, setTimeZone] = useState("UTC");
  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  return new Intl.DateTimeFormat("en", {
    timeZone,
    timeZoneName: "shortOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

export function formatInsightsTimestamp(
  value: number,
  formatter: Intl.DateTimeFormat,
) {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(value))
      .map(({ type, value }) => [type, value]),
  );
  const offset = parts.timeZoneName === "GMT" ? "GMT+0" : parts.timeZoneName;
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${offset}`;
}

export function EventTimestamp({
  value,
  formatter,
  touch = false,
}: {
  readonly value: number;
  readonly formatter: Intl.DateTimeFormat;
  readonly touch?: boolean;
}) {
  const date = new Date(value);
  const localTime = formatInsightsTimestamp(value, formatter);
  return (
    <details className="group/time">
      <summary
        className={`cursor-pointer list-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden ${touch ? "flex min-h-11 items-center" : ""}`}
      >
        <span className="flex items-center gap-1">
          <time dateTime={date.toISOString()} className="whitespace-nowrap">
            {localTime}
          </time>
          <ChevronDown
            aria-hidden="true"
            className="size-3 text-muted-foreground group-open/time:rotate-180"
          />
        </span>
      </summary>
      <p className="mt-2 text-muted-foreground">
        {date.toISOString().replace("T", " ").replace("Z", " UTC")}
      </p>
    </details>
  );
}

const deliveries: Readonly<Record<string, string>> = {
  patch: "A patch delivered it.",
  manifest: "Only the changed files were downloaded.",
  archive: "The full archive was downloaded.",
};

/** What the event's report added: where an update failed, how a bundle arrived, why a process exited. */
const eventNote = (
  event: Pick<
    EventHistoryRow,
    "type" | "failure" | "delivery" | "patchFallback" | "previousProcessExit"
  >,
): string | null => {
  if (event.type === "UPDATE_FAILED" && event.failure) {
    return describeFailure(event.failure);
  }
  if (event.type === "UPDATE_DOWNLOADED" && event.delivery) {
    const delivered = deliveries[event.delivery] ?? null;
    return event.patchFallback
      ? `The patch failed. ${delivered ?? ""}`.trim()
      : delivered;
  }
  if (event.type === "RECOVERED" && event.previousProcessExit) {
    return `The crashed process exited with ${event.previousProcessExit}.`;
  }
  return null;
};

export function EventTypeDetails({
  event,
}: {
  readonly event: Pick<
    EventHistoryRow,
    "type" | "failure" | "delivery" | "patchFallback" | "previousProcessExit"
  >;
}) {
  const eventType = eventTypes[event.type];
  const Icon = eventType.icon;
  const note = eventNote(event);
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <Badge
        variant={eventType.variant}
        className="gap-1 whitespace-nowrap [&_svg]:size-3"
      >
        <Icon aria-hidden="true" />
        {eventType.label}
      </Badge>
      <p className="max-w-56 whitespace-pre-wrap wrap-anywhere text-xs text-muted-foreground">
        {event.type === "UPDATE_FAILED" && note ? note : eventType.description}
      </p>
      {event.type === "UPDATE_FAILED" && event.failure?.errorStack ? (
        <details className="w-full max-w-56 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Stack trace
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap wrap-anywhere font-mono">
            {event.failure.errorStack}
          </pre>
        </details>
      ) : null}
      {event.type !== "UPDATE_FAILED" && note ? (
        <p className="max-w-56 whitespace-normal text-xs text-muted-foreground">
          {note}
        </p>
      ) : null}
    </div>
  );
}

export function EventBundleTransition({
  event,
  touch = false,
}: {
  readonly event: Pick<
    EventHistoryRow,
    "type" | "fromBundleId" | "toBundleId" | "failure"
  >;
  readonly touch?: boolean;
}) {
  const downloaded = event.type === "UPDATE_DOWNLOADED";
  const failed = event.type === "UPDATE_FAILED";
  // A failed check targets no bundle: it names the one running.
  const targeted = !failed || event.failure?.stage !== "check";
  const changed =
    downloaded ||
    failed ||
    event.type === "UPDATE_APPLIED" ||
    event.type === "RECOVERED";
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
      {event.fromBundleId && changed ? (
        <>
          <dt className="text-muted-foreground">
            {downloaded || failed ? "Running" : "From"}
          </dt>
          <dd>
            <HashValueDisplay
              value={event.fromBundleId}
              buttonClassName={touch ? "min-h-11 px-3" : undefined}
            />
          </dd>
        </>
      ) : null}
      {targeted ? (
        <>
          <dt className="text-muted-foreground">
            {downloaded
              ? "Pending"
              : failed
                ? "Target"
                : changed
                  ? "To"
                  : "Current"}
          </dt>
          <dd>
            <HashValueDisplay
              value={event.toBundleId}
              buttonClassName={touch ? "min-h-11 px-3" : undefined}
            />
          </dd>
        </>
      ) : null}
    </dl>
  );
}
