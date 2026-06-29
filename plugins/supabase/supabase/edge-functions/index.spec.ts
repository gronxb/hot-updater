import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const edgeFunctionPath = path.resolve(
  "plugins/supabase/supabase/edge-functions/index.ts",
);

describe("Supabase Edge Function telemetry route", () => {
  it("mounts notifyAppReady before the generic update handler", async () => {
    const source = await fs.readFile(edgeFunctionPath, "utf8");
    const routeIndex = source.indexOf('app.post("/api/notify-app-ready"');
    const mountIndex = source.indexOf("app.mount(hotUpdaterBasePath");

    expect(source).toContain("createSupabaseNotifyAppReadyResult");
    expect(source).toContain("createSupabaseTelemetryOperations");
    expect(routeIndex).toBeGreaterThan(-1);
    expect(mountIndex).toBeGreaterThan(routeIndex);
  });
});
