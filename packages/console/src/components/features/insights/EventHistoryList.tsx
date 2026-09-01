import type { ReactNode } from "react";

import type { EventHistoryResult } from "@/lib/api";

import {
  EventBundleTransition,
  EventTimestamp,
  EventTypeBadge,
} from "./EventDetails";

export function EventHistoryList<
  T extends Omit<EventHistoryResult["data"][number], "installId">,
>({
  events,
  formatter,
  renderIdentity,
}: {
  readonly events: readonly T[];
  readonly formatter: Intl.DateTimeFormat;
  readonly renderIdentity?: (event: T) => ReactNode;
}) {
  return (
    <>
      <p className="px-4 pb-2 text-xs text-muted-foreground sm:px-6">
        Time in your browser zone
      </p>
      <ol aria-label="Events" className="divide-y border-y">
        {events.map((event) => (
          <li
            key={event.id}
            className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <EventTypeBadge type={event.type} />
              <div className="text-xs tabular-nums">
                <EventTimestamp
                  value={event.receivedAtMs}
                  formatter={formatter}
                  touch
                />
              </div>
            </div>
            {renderIdentity?.(event)}
            <dl className="flex flex-wrap gap-x-2 gap-y-1 text-sm">
              <div>
                <dt className="sr-only">App</dt>
                <dd>
                  {event.platform === "ios" ? "iOS" : "Android"}{" "}
                  {event.appVersion}
                </dd>
              </div>
              <div className="min-w-0 text-muted-foreground">
                <dt className="sr-only">Channel</dt>
                <dd className="wrap-anywhere">{event.channel}</dd>
              </div>
            </dl>
            <div className="text-xs" aria-label="Bundle">
              <EventBundleTransition event={event} touch />
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
