import dayjs from "dayjs";
import isBetween from "dayjs/plugin/isBetween";
import minMax from "dayjs/plugin/minMax";

dayjs.extend(minMax);
dayjs.extend(isBetween);

export interface TimeSeriesData {
  timestamp: string; // ISO date for bucket start
  label: string; // Display label (e.g., "Jan 5, 2PM")
  promoted: number;
  recovered: number;
  total: number;
}

export interface AppVersionData {
  appVersion: string;
  promoted: number;
  recovered: number;
  total: number;
  successRate: number; // (promoted / total) * 100
}

export interface DeviceEvent {
  id?: string;
  deviceId: string;
  bundleId: string;
  eventType: "PROMOTED" | "RECOVERED";
  platform: "ios" | "android";
  appVersion?: string;
  channel: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

/**
 * Filter events by date range
 * @param events Array of device events
 * @param startDate ISO date string (e.g., "2024-01-01")
 * @param endDate ISO date string (e.g., "2024-01-31")
 * @returns Filtered array of events
 */
export function filterEventsByDateRange(
  events: DeviceEvent[],
  startDate?: string,
  endDate?: string,
): DeviceEvent[] {
  if (!startDate && !endDate) {
    return events;
  }

  return events.filter((event) => {
    if (!event.createdAt) {
      return false; // Filter out events without timestamps
    }

    const eventDate = dayjs(event.createdAt);

    if (startDate && endDate) {
      return eventDate.isBetween(
        dayjs(startDate).startOf("day"),
        dayjs(endDate).endOf("day"),
        null,
        "[]",
      );
    }

    if (startDate) {
      return (
        eventDate.isAfter(dayjs(startDate).startOf("day")) ||
        eventDate.isSame(dayjs(startDate).startOf("day"))
      );
    }

    if (endDate) {
      return (
        eventDate.isBefore(dayjs(endDate).endOf("day")) ||
        eventDate.isSame(dayjs(endDate).endOf("day"))
      );
    }

    return true;
  });
}

/**
 * Determine bucket size based on date range
 */
function determineBucketSize(
  events: DeviceEvent[],
  explicitSize?: "hour" | "day" | "week" | "auto",
): "hour" | "day" | "week" {
  if (explicitSize && explicitSize !== "auto") {
    return explicitSize;
  }

  if (events.length === 0) {
    return "day";
  }

  // Find date range of events
  const timestamps = events
    .map((e) => e.createdAt)
    .filter((t): t is string => !!t)
    .map((t) => dayjs(t));

  if (timestamps.length === 0) {
    return "day";
  }

  const earliest = dayjs.min(timestamps);
  const latest = dayjs.max(timestamps);

  if (!earliest || !latest) {
    return "day";
  }

  const daysDiff = latest.diff(earliest, "day");

  // Auto-select bucket size based on range
  if (daysDiff < 2) {
    return "hour";
  }
  if (daysDiff <= 30) {
    return "day";
  }
  return "week";
}

/**
 * Group events by time buckets (hour/day/week)
 * @param events Array of device events
 * @param bucketSize Time bucket size or 'auto' for automatic selection
 * @returns Array of time series data points
 */
export function groupEventsByTimeBucket(
  events: DeviceEvent[],
  bucketSize: "hour" | "day" | "week" | "auto" = "auto",
): TimeSeriesData[] {
  const actualBucketSize = determineBucketSize(events, bucketSize);

  // Group events by bucket
  const buckets = new Map<string, { promoted: number; recovered: number }>();

  events.forEach((event) => {
    if (!event.createdAt) {
      return;
    }

    const eventDate = dayjs(event.createdAt);
    let bucketKey: string;

    switch (actualBucketSize) {
      case "hour":
        bucketKey = eventDate.startOf("hour").toISOString();
        break;
      case "day":
        bucketKey = eventDate.startOf("day").toISOString();
        break;
      case "week":
        bucketKey = eventDate.startOf("week").toISOString();
        break;
    }

    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, { promoted: 0, recovered: 0 });
    }

    const bucket = buckets.get(bucketKey)!;
    if (event.eventType === "PROMOTED") {
      bucket.promoted += 1;
    } else if (event.eventType === "RECOVERED") {
      bucket.recovered += 1;
    }
  });

  // Convert to array and format labels
  const result: TimeSeriesData[] = Array.from(buckets.entries())
    .sort(([a], [b]) => dayjs(a).unix() - dayjs(b).unix())
    .map(([timestamp, counts]) => {
      const date = dayjs(timestamp);
      let label: string;

      switch (actualBucketSize) {
        case "hour":
          label = date.format("MMM D, h A");
          break;
        case "day":
          label = date.format("MMM D");
          break;
        case "week":
          label = date.format("MMM D, YYYY");
          break;
      }

      return {
        timestamp,
        label,
        promoted: counts.promoted,
        recovered: counts.recovered,
        total: counts.promoted + counts.recovered,
      };
    });

  return result;
}

/**
 * Aggregate events by app version
 * @param events Array of device events
 * @returns Array of app version data with success rates
 */
export function aggregateByAppVersion(events: DeviceEvent[]): AppVersionData[] {
  const versionMap = new Map<string, { promoted: number; recovered: number }>();

  events.forEach((event) => {
    const version = event.appVersion || "Unknown";

    if (!versionMap.has(version)) {
      versionMap.set(version, { promoted: 0, recovered: 0 });
    }

    const versionData = versionMap.get(version)!;
    if (event.eventType === "PROMOTED") {
      versionData.promoted += 1;
    } else if (event.eventType === "RECOVERED") {
      versionData.recovered += 1;
    }
  });

  // Convert to array and calculate success rates
  const result: AppVersionData[] = Array.from(versionMap.entries())
    .map(([appVersion, counts]) => {
      const total = counts.promoted + counts.recovered;
      const successRate = total > 0 ? (counts.promoted / total) * 100 : 0;

      return {
        appVersion,
        promoted: counts.promoted,
        recovered: counts.recovered,
        total,
        successRate,
      };
    })
    .sort((a, b) => b.total - a.total); // Sort by total events descending

  return result;
}
