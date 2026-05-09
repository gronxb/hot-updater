export type Task<TValue> = {
  run: (signal?: AbortSignal) => Promise<TValue>;
  pipe: (
    ...operators: ReadonlyArray<(task: Task<TValue>) => Task<TValue>>
  ) => Task<TValue>;
};

export const task = <TValue>(run: Task<TValue>["run"]): Task<TValue> => ({
  run,
  pipe: (...operators) =>
    operators.reduce((current, operator) => operator(current), task(run)),
});

export const withTimeout =
  <TValue>(requestTimeout: number) =>
  (effect: Task<TValue>): Task<TValue> =>
    task(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, requestTimeout);

      try {
        return await effect.run(controller.signal);
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Request timed out");
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    });

export const withRetry =
  <TValue>(retryCount: number, shouldRetry: (value: TValue) => boolean) =>
  (effect: Task<TValue>): Task<TValue> =>
    task(async (signal) => {
      let result = await effect.run(signal);

      for (let attempt = 0; attempt < retryCount; attempt++) {
        if (!shouldRetry(result)) {
          return result;
        }
        result = await effect.run(signal);
      }

      return result;
    });
