const isRetryableConflict = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  if (
    "code" in error &&
    [
      "ER_DUP_ENTRY",
      "ER_LOCK_DEADLOCK",
      "ER_LOCK_WAIT_TIMEOUT",
      "40001",
      "40P01",
    ].includes(String(error.code))
  )
    return true;
  return (
    "cause" in error &&
    error.cause !== error &&
    isRetryableConflict(error.cause)
  );
};

export const runInsightsTransaction = async (
  operation: () => Promise<void>,
): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      if (attempt >= 2 || !isRetryableConflict(error)) throw error;
    }
  }
};
