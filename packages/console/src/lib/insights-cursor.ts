export const pushInsightsCursor = (
  stack: readonly string[] | undefined,
  cursor: string | undefined,
): string[] => [...(stack ?? []), cursor ?? ""];

export const popInsightsCursor = (
  stack: readonly string[] | undefined,
): { readonly cursor: string | undefined; readonly stack: string[] } => {
  const previous = stack?.at(-1);
  return {
    cursor: previous ? previous : undefined,
    stack: stack?.slice(0, -1) ?? [],
  };
};
