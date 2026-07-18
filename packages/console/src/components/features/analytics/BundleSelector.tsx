import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { Field, FieldLabel } from "@/components/ui/field";

type BundleOption = {
  readonly bundleId: string;
  readonly description: string;
};

export function BundleSelector({
  bundleId,
  bundles,
  onBundleChange,
}: {
  readonly bundleId: string;
  readonly bundles: readonly BundleOption[];
  readonly onBundleChange: (bundleId: string) => void;
}) {
  const selectedBundle =
    bundles.find((bundle) => bundle.bundleId === bundleId) ?? null;

  return (
    <Field
      className="w-full min-w-0 sm:max-w-md"
      data-disabled={!bundles.length}
    >
      <FieldLabel htmlFor="analytics-bundle-selector">
        Bundle to inspect
      </FieldLabel>
      <Combobox
        autoHighlight
        disabled={!bundles.length}
        filter={(bundle, query) => {
          const normalizedQuery = query.trim().toLowerCase();
          return (
            bundle.bundleId.toLowerCase().includes(normalizedQuery) ||
            bundle.description.toLowerCase().includes(normalizedQuery)
          );
        }}
        isItemEqualToValue={(bundle, value) =>
          bundle.bundleId === value.bundleId
        }
        items={bundles}
        itemToStringLabel={(bundle) => bundle.bundleId}
        onValueChange={(bundle) => {
          if (bundle) onBundleChange(bundle.bundleId);
        }}
        value={selectedBundle}
      >
        <ComboboxTrigger
          aria-label="Bundle to inspect"
          id="analytics-bundle-selector"
          render={
            <Button
              className="w-full min-w-0 justify-between"
              size="lg"
              variant="outline"
            />
          }
        >
          {selectedBundle ? (
            <span className="flex min-w-0 flex-1 flex-col items-start">
              <code className="max-w-full truncate text-xs/3">
                {selectedBundle.bundleId}
              </code>
              <span className="max-w-full truncate text-xs/3 text-muted-foreground">
                {selectedBundle.description}
              </span>
            </span>
          ) : (
            <span className="truncate text-muted-foreground">
              No bundles available
            </span>
          )}
        </ComboboxTrigger>
        <ComboboxContent>
          <ComboboxInput
            aria-label="Search bundles"
            placeholder="Search by bundle ID or description"
            showClear
            showTrigger={false}
          />
          <ComboboxEmpty>No bundles found.</ComboboxEmpty>
          <ComboboxList>
            {(bundle) => (
              <ComboboxItem key={bundle.bundleId} value={bundle}>
                <span className="flex min-w-0 flex-col gap-0.5 pr-5">
                  <code className="max-w-72 truncate text-xs">
                    {bundle.bundleId}
                  </code>
                  <span className="truncate text-xs text-muted-foreground">
                    {bundle.description}
                  </span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </Field>
  );
}
