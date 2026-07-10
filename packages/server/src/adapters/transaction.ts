import type { DatabasePluginDeclaration } from "@hot-updater/plugin-core";

const rollbackToken = Symbol("hot-updater-transaction-rollback");

export const createCallbackDatabaseTransaction = async <THandle>({
  createConnection,
  onSettled,
  run,
}: {
  readonly createConnection: (handle: THandle) => DatabasePluginDeclaration;
  readonly onSettled?: () => Promise<void>;
  readonly run: (
    operation: (handle: THandle) => Promise<void>,
  ) => Promise<unknown>;
}): Promise<{
  readonly connection: DatabasePluginDeclaration;
  readonly commit: () => Promise<void>;
  readonly rollback: () => Promise<void>;
}> => {
  let resolveConnection: (connection: DatabasePluginDeclaration) => void = () =>
    undefined;
  let rejectConnection: (error: unknown) => void = () => undefined;
  let resolveFinish: () => void = () => undefined;
  let rejectFinish: (error: unknown) => void = () => undefined;
  let finished = false;
  let cleanup: Promise<void> | undefined;

  const connectionReady = new Promise<DatabasePluginDeclaration>(
    (resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
    },
  );
  const finish = new Promise<void>((resolve, reject) => {
    resolveFinish = resolve;
    rejectFinish = reject;
  });
  const settle = () => {
    cleanup ??= Promise.resolve(onSettled?.());
    return cleanup;
  };
  const transaction = run(async (handle) => {
    resolveConnection(createConnection(handle));
    await finish;
  });
  void transaction.catch((error) => {
    rejectConnection(error);
  });

  let connection: DatabasePluginDeclaration;
  try {
    connection = await connectionReady;
  } catch (error) {
    await settle();
    throw error;
  }

  return {
    connection,
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
