import {
  patchE2eScreenState,
  readE2eScreenState,
  type E2eScreenState,
} from "../e2eRuntimeConfig";

const logScreenStateError = (label: string, error: unknown): void => {
  const message =
    error instanceof Error ? error.message : "Unknown E2E screen state error";
  console.warn(`${label}: ${message}`);
};

export const readPersistedScreenState =
  async (): Promise<E2eScreenState | null> => {
    try {
      return await readE2eScreenState();
    } catch (error) {
      logScreenStateError("Failed to read E2E screen state", error);
      return null;
    }
  };

export const persistScreenState = async (
  patch: Partial<E2eScreenState>,
): Promise<void> => {
  try {
    await patchE2eScreenState(patch);
  } catch (error) {
    logScreenStateError("Failed to patch E2E screen state", error);
  }
};
