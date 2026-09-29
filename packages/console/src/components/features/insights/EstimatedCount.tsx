/**
 * A unique count the server estimates from a HyperLogLog sketch, typically
 * within about 3% of the true count. It shows as approximate, as analytics
 * consoles mark estimates, and says so to screen readers. Zero is exact: no
 * report reached the sketch.
 */
export function EstimatedCount({ value }: { readonly value: number }) {
  if (value === 0) return "0";
  return (
    <span title="Estimated">
      <span aria-hidden="true" className="mr-1 text-muted-foreground">
        ≈
      </span>
      <span className="sr-only">Estimated </span>
      {value.toLocaleString()}
    </span>
  );
}
