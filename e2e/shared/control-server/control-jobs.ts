import { randomUUID } from "node:crypto";

import type { ControlJobState, JsonObject } from "../control-protocol.ts";

export type JobExecutionContext = {
  readonly signal: AbortSignal;
  readonly markQuiescenceUncertain: () => void;
};

/** A cancellation request is not terminal until the entire task has settled. */
export function createControlJobs(
  options: {
    readonly onError?: (
      jobId: string,
      error: unknown,
      cancelled: boolean,
    ) => void;
  } = {},
) {
  const states = new Map<string, ControlJobState>();
  const controllers = new Map<string, AbortController>();

  return {
    start(task: (context: JobExecutionContext) => Promise<JsonObject>): string {
      const jobId = randomUUID();
      const controller = new AbortController();
      let quiescent = true;
      controllers.set(jobId, controller);
      states.set(jobId, { status: "running" });
      void Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return task({
            signal: controller.signal,
            markQuiescenceUncertain: () => {
              quiescent = false;
            },
          });
        })
        .then(
          (result) => {
            states.set(
              jobId,
              controller.signal.aborted
                ? { status: "cancelled", quiescent }
                : { status: "succeeded", result, quiescent },
            );
          },
          (error: unknown) => {
            const cancelled = controller.signal.aborted;
            // A rejected remote request may have been accepted before its
            // response was lost. Only an acknowledged local abort is safe.
            const acknowledgedAbort =
              cancelled &&
              (error === controller.signal.reason ||
                (error instanceof Error &&
                  error.name === "AbortError" &&
                  error.cause === controller.signal.reason));
            if (!acknowledgedAbort) quiescent = false;
            options.onError?.(jobId, error, cancelled);
            states.set(jobId, {
              error: error instanceof Error ? error.message : String(error),
              status: cancelled ? "cancelled" : "failed",
              quiescent,
            });
          },
        )
        .finally(() => {
          controllers.delete(jobId);
        });
      return jobId;
    },
    get(jobId: string): ControlJobState | null {
      return states.get(jobId) ?? null;
    },
    cancel(jobId: string): ControlJobState | null {
      controllers.get(jobId)?.abort(new Error("cancelled by control client"));
      return states.get(jobId) ?? null;
    },
  };
}
