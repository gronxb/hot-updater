import type {
  DatabasePluginCore,
  DatabaseTransaction,
} from "@hot-updater/plugin-core";

const rollbackToken = Symbol("hot-updater-transaction-rollback");

export const createCallbackDatabaseTransaction = async <THandle>({
  createCore,
  onSettled,
  run,
}: {
  readonly createCore: (handle: THandle) => DatabasePluginCore;
  readonly onSettled?: () => Promise<void>;
  readonly run: (
    operation: (handle: THandle) => Promise<void>,
  ) => Promise<unknown>;
}): Promise<DatabaseTransaction> => {
  let resolveCore: (core: DatabasePluginCore) => void = () => undefined;
  let rejectCore: (error: unknown) => void = () => undefined;
  let resolveFinish: () => void = () => undefined;
  let rejectFinish: (error: unknown) => void = () => undefined;
  let finished = false;
  let cleanup: Promise<void> | undefined;

  const coreReady = new Promise<DatabasePluginCore>((resolve, reject) => {
    resolveCore = resolve;
    rejectCore = reject;
  });
  const finish = new Promise<void>((resolve, reject) => {
    resolveFinish = resolve;
    rejectFinish = reject;
  });
  const settle = () => {
    cleanup ??= Promise.resolve(onSettled?.());
    return cleanup;
  };
  const transaction = run(async (handle) => {
    resolveCore(createCore(handle));
    await finish;
  });
  void transaction.catch((error) => {
    rejectCore(error);
  });

  let core: DatabasePluginCore;
  try {
    core = await coreReady;
  } catch (error) {
    await settle();
    throw error;
  }

  return {
    core,
    commit: async () => {
      if (!finished) {
        finished = true;
        resolveFinish();
      }
      try {
        await transaction;
      } finally {
        await settle();
      }
    },
    rollback: async () => {
      if (!finished) {
        finished = true;
        rejectFinish(rollbackToken);
      }
      try {
        await transaction;
      } catch (error) {
        if (error !== rollbackToken) {
          throw error;
        }
      } finally {
        await settle();
      }
    },
  };
};
