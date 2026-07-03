import { describe, expect, it } from "vitest";

import {
  ANALYTICS_EVENTS_COLLECTION,
  INGEST_KEYS_COLLECTION,
  TELEMETRY_KEY_DOC_ID,
} from "./firebaseTelemetryTypes";

describe("Firebase telemetry collections", () => {
  it("uses canonical ingest key and analytics event collection names", () => {
    expect(INGEST_KEYS_COLLECTION).toBe("ingest_keys");
    expect(ANALYTICS_EVENTS_COLLECTION).toBe("analytics_events");
    expect(TELEMETRY_KEY_DOC_ID).toBe("default");
  });
});
