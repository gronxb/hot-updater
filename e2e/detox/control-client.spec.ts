import { describe, expect, it } from "vitest";

import {
  ControlEndpointError,
  ControlJobError,
  ControlProtocolError,
  createControlClient,
} from "./control-client.ts";
import type {
  ControlFetch,
  ResponseLike,
  StageTiming,
} from "./control-client.ts";

function jsonResponse(status: number, body: unknown): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe("Detox control client", () => {
  it("fails a non-2xx endpoint response once with stage diagnostics", async () => {
    // Given: the control server rejects a malformed deploy request.
    const calls: string[] = [];
    const timings: StageTiming[] = [];
    const fetch: ControlFetch = (url) => {
      calls.push(url);
      return Promise.resolve(
        jsonResponse(400, { error: "channel is required" }),
      );
    };
    const client = createControlClient({
      baseUrl: "http://127.0.0.1:3010",
      fetch,
      nowMs: () => 10,
      onStageTiming: (timing) => timings.push(timing),
    });

    // When: a stage posts the invalid request.
    let caught: unknown;
    try {
      await client.postJson("bundle deploy", "/e2e/jobs/deploy-bundle", {});
    } catch (error) {
      caught = error;
    }

    // Then: the scenario fails immediately without retrying the endpoint.
    expect(calls).toEqual(["http://127.0.0.1:3010/e2e/jobs/deploy-bundle"]);
    expect(caught).toBeInstanceOf(ControlEndpointError);
    if (caught instanceof ControlEndpointError) {
      expect(caught.status).toBe(400);
      expect(caught.stage).toBe("bundle deploy");
      expect(caught.message).toContain("channel is required");
    }
    expect(timings).toEqual([
      {
        diagnostic:
          'bundle deploy failed with HTTP 400: {"error":"channel is required"}',
        durationMs: 0,
        endedAtMs: 10,
        outcome: "failed",
        stage: "bundle deploy",
        startedAtMs: 10,
      },
    ]);
  });

  it("starts and waits for a control job without transport retry wrappers", async () => {
    // Given: the control server starts and completes a deploy job.
    const calls: string[] = [];
    let now = 100;
    const fetch: ControlFetch = (url) => {
      calls.push(url);
      now += 25;
      if (url.endsWith("/e2e/jobs/deploy-bundle")) {
        return Promise.resolve(jsonResponse(200, { jobId: "job-1" }));
      }
      return Promise.resolve(
        jsonResponse(200, {
          result: { bundleId: "bundle-1" },
          status: "succeeded",
        }),
      );
    };
    const timings: StageTiming[] = [];
    const client = createControlClient({
      baseUrl: "http://127.0.0.1:3010/",
      fetch,
      nowMs: () => now,
      onStageTiming: (timing) => timings.push(timing),
      pollDelayMs: () => Promise.resolve(),
    });

    // When: the job stage runs.
    const result = await client.runJob(
      "bundle deploy",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "e2e",
        marker: "marker",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0",
      },
    );

    // Then: exactly one start request and one job-state request are made.
    expect(result).toEqual({ bundleId: "bundle-1" });
    expect(calls).toEqual([
      "http://127.0.0.1:3010/e2e/jobs/deploy-bundle",
      "http://127.0.0.1:3010/e2e/jobs/job-1",
    ]);
    expect(timings).toEqual([
      {
        durationMs: 50,
        endedAtMs: 150,
        outcome: "succeeded",
        stage: "bundle deploy",
        startedAtMs: 100,
      },
    ]);
  });

  it("closes control HTTP connections so job polling does not fail on stale sockets", async () => {
    // Given: the control server starts and completes a long-running bootstrap job.
    const calls: {
      readonly connection: string | null;
      readonly url: string;
    }[] = [];
    const fetch: ControlFetch = (url, init) => {
      calls.push({
        connection: new Headers(init.headers).get("connection"),
        url,
      });
      if (url.endsWith("/e2e/jobs/bootstrap")) {
        return Promise.resolve(jsonResponse(200, { jobId: "bootstrap-job" }));
      }
      return Promise.resolve(jsonResponse(200, { status: "succeeded" }));
    };
    const client = createControlClient({
      baseUrl: "http://127.0.0.1:3010",
      fetch,
      pollDelayMs: () => Promise.resolve(),
    });

    // When: a job stage polls for completion.
    await client.runJob("bootstrap", "/e2e/jobs/bootstrap", {});

    // Then: both the start request and status poll opt out of socket reuse.
    expect(calls).toEqual([
      {
        connection: "close",
        url: "http://127.0.0.1:3010/e2e/jobs/bootstrap",
      },
      {
        connection: "close",
        url: "http://127.0.0.1:3010/e2e/jobs/bootstrap-job",
      },
    ]);
  });

  it("waits for screen state fields without rerunning the action", async () => {
    // Given: Android action taps continue asynchronously after Detox returns from tap().
    const calls: string[] = [];
    let now = 0;
    const fetch: ControlFetch = (url) => {
      calls.push(url);
      const updateActionResult =
        calls.length < 3
          ? calls.length === 1
            ? "idle"
            : "current-channel -> checking"
          : "current-channel -> installed bundle-1";
      return Promise.resolve(
        jsonResponse(200, {
          screenState: { updateActionResult },
        }),
      );
    };
    const client = createControlClient({
      baseUrl: "http://127.0.0.1:3010",
      fetch,
      nowMs: () => now,
      pollDelayMs: (durationMs) => {
        now += durationMs;
        return Promise.resolve();
      },
    });

    // When: the driver waits for the result field to leave transient values.
    const result = await client.waitForScreenStateField(
      "wait install result",
      "updateActionResult",
      {
        rejectSubstrings: [" -> checking"],
        rejectValues: ["idle"],
      },
    );

    // Then: it polls existing runtime state and does not restart the action.
    expect(result).toEqual({
      updateActionResult: "current-channel -> installed bundle-1",
    });
    expect(calls).toEqual([
      "http://127.0.0.1:3010/e2e/runtime-config",
      "http://127.0.0.1:3010/e2e/runtime-config",
      "http://127.0.0.1:3010/e2e/runtime-config",
    ]);
  });

  it("waits for an exact screen state field instead of accepting any terminal result", async () => {
    // Given: the app first publishes a terminal value for an older update.
    const values = [
      "idle",
      "current-channel -> checking",
      "current-channel -> installed bundle-old",
      "current-channel -> installed bundle-new",
    ];
    const calls: string[] = [];
    let now = 0;
    const fetch: ControlFetch = (url) => {
      calls.push(url);
      return Promise.resolve(
        jsonResponse(200, {
          screenState: {
            updateActionResult: values.at(calls.length - 1),
          },
        }),
      );
    };
    const client = createControlClient({
      baseUrl: "http://127.0.0.1:3010",
      fetch,
      nowMs: () => now,
      pollDelayMs: (durationMs) => {
        now += durationMs;
        return Promise.resolve();
      },
    });

    // When: the scenario waits for the exact expected action result.
    const result = await client.waitForScreenStateField(
      "assert install result",
      "updateActionResult",
      {
        expectedValue: "current-channel -> installed bundle-new",
        rejectSubstrings: [" -> checking"],
        rejectValues: ["idle"],
      },
    );

    // Then: the stale terminal value is ignored rather than treated as success.
    expect(result).toEqual({
      updateActionResult: "current-channel -> installed bundle-new",
    });
    expect(calls).toEqual([
      "http://127.0.0.1:3010/e2e/runtime-config",
      "http://127.0.0.1:3010/e2e/runtime-config",
      "http://127.0.0.1:3010/e2e/runtime-config",
      "http://127.0.0.1:3010/e2e/runtime-config",
    ]);
  });

  it("times out when screen state never reaches a stable action result", async () => {
    // Given: the app never publishes a non-transient action result.
    let now = 0;
    const fetch: ControlFetch = () =>
      Promise.resolve(
        jsonResponse(200, {
          screenState: { updateActionResult: "current-channel -> checking" },
        }),
      );
    const client = createControlClient({
      baseUrl: "http://127.0.0.1:3010",
      fetch,
      nowMs: () => now,
      pollDelayMs: (durationMs) => {
        now += durationMs;
        return Promise.resolve();
      },
      screenStateTimeoutMs: 2000,
    });

    // When: the stable result never appears.
    let caught: unknown;
    try {
      await client.waitForScreenStateField(
        "wait install result",
        "updateActionResult",
        {
          rejectSubstrings: [" -> checking"],
        },
      );
    } catch (error) {
      caught = error;
    }

    // Then: the failure is bounded below the scenario timeout.
    expect(caught).toBeInstanceOf(ControlProtocolError);
    if (caught instanceof ControlProtocolError) {
      expect(caught.message).toContain(
        "wait install result timed out waiting for updateActionResult",
      );
    }
    expect(now).toBe(2000);
  });

  it("fails a failed control job once with the server error", async () => {
    // Given: the control server reports a failed metadata job.
    const calls: string[] = [];
    const fetch: ControlFetch = (url) => {
      calls.push(url);
      if (url.endsWith("/e2e/jobs/wait-for-metadata")) {
        return Promise.resolve(jsonResponse(200, { jobId: "job-2" }));
      }
      return Promise.resolve(
        jsonResponse(200, {
          error: "metadata mismatch",
          status: "failed",
        }),
      );
    };
    const client = createControlClient({
      baseUrl: "http://127.0.0.1:3010",
      fetch,
      nowMs: () => 20,
      pollDelayMs: () => Promise.resolve(),
    });

    // When: the job stage runs.
    let caught: unknown;
    try {
      await client.runJob("metadata wait", "/e2e/jobs/wait-for-metadata", {
        bundleId: "bundle-1",
        verificationPending: false,
      });
    } catch (error) {
      caught = error;
    }

    // Then: the server failure is surfaced without restarting the job.
    expect(calls).toEqual([
      "http://127.0.0.1:3010/e2e/jobs/wait-for-metadata",
      "http://127.0.0.1:3010/e2e/jobs/job-2",
    ]);
    expect(caught).toBeInstanceOf(ControlJobError);
    if (caught instanceof ControlJobError) {
      expect(caught.jobId).toBe("job-2");
      expect(caught.message).toContain("metadata mismatch");
    }
  });

  it("cancels a running control job before the Jest scenario timeout", async () => {
    // Given: the control server accepts a job but never marks it terminal.
    const calls: { readonly method: string; readonly url: string }[] = [];
    let now = 0;
    const fetch: ControlFetch = (url, init) => {
      calls.push({ method: init.method ?? "GET", url });
      if (url.endsWith("/e2e/jobs/deploy-bundle")) {
        return Promise.resolve(jsonResponse(200, { jobId: "job-hung" }));
      }
      if (init.method === "DELETE") {
        return Promise.resolve(
          jsonResponse(200, {
            error: "cancelled by control client timeout",
            status: "cancelled",
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, { status: "running" }));
    };
    const timings: StageTiming[] = [];
    const client = createControlClient({
      baseUrl: "http://127.0.0.1:3010",
      fetch,
      nowMs: () => now,
      onStageTiming: (timing) => timings.push(timing),
      pollDelayMs: (durationMs) => {
        now += durationMs;
        return Promise.resolve();
      },
    });

    // When: the stage waits for the hung job with default settings.
    let caught: unknown;
    try {
      await client.runJob("bundle deploy", "/e2e/jobs/deploy-bundle", {});
    } catch (error) {
      caught = error;
    }

    // Then: the client reports the job id and cancels the server job before Jest's 12 minute ceiling.
    expect(caught).toBeInstanceOf(ControlJobError);
    if (caught instanceof ControlJobError) {
      expect(caught.jobId).toBe("job-hung");
      expect(caught.stage).toBe("bundle deploy");
      expect(caught.message).toContain("timed out after 600000ms");
    }
    expect(now).toBeLessThan(720000);
    expect(calls).toContainEqual({
      method: "GET",
      url: "http://127.0.0.1:3010/e2e/jobs/job-hung",
    });
    expect(calls.at(-1)).toEqual({
      method: "DELETE",
      url: "http://127.0.0.1:3010/e2e/jobs/job-hung",
    });
    expect(timings).toEqual([
      {
        diagnostic:
          "bundle deploy job job-hung failed: timed out after 600000ms",
        durationMs: 600000,
        endedAtMs: 600000,
        outcome: "failed",
        stage: "bundle deploy",
        startedAtMs: 0,
      },
    ]);
  });
});
