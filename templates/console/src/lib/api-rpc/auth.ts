export const withConsoleAuth = async <Result>(
  operation: () => Promise<Result>,
) => {
  const { requireConsoleSession } = await import(
    "../server/auth-guard.server.ts"
  );
  await requireConsoleSession();

  return operation();
};
