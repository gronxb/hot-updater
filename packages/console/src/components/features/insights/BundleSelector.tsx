import { shortenIdentifier } from "@/components/HashValueDisplay";
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
      <FieldLabel className="sr-only" htmlFor="insights-bundle-selector">
        Artifact to inspect
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
          aria-label="Artifact to inspect"
          id="insights-bundle-selector"
          render={
            <Button
              className="h-auto min-h-12 w-full min-w-0 justify-between px-3 py-2 text-left"
              size="lg"
              variant="outline"
            />
          }
        >
          {selectedBundle ? (
            <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
              <span className="max-w-full truncate text-xs/4">
                {selectedBundle.description}
              </span>
              <code
                className="max-w-full truncate text-xs/4 text-muted-foreground"
                title={selectedBundle.bundleId}
              >
                {shortenIdentifier(selectedBundle.bundleId)}
              </code>
            </span>
          ) : (
            <span className="truncate text-muted-foreground">
              No artifacts available
            </span>
          )}
        </ComboboxTrigger>
        <ComboboxContent className="min-w-(--anchor-width)">
          <ComboboxInput
            aria-label="Search artifacts"
            className="h-11 [&_input]:h-11 [&_input]:text-base [&_[data-slot=combobox-clear]]:size-11 md:[&_input]:text-base lg:h-8 lg:[&_input]:h-8 lg:[&_input]:text-xs lg:[&_[data-slot=combobox-clear]]:size-5"
            placeholder="Artifact ID or description"
            showClear
            showTrigger={false}
          />
          <ComboboxEmpty>No artifacts found</ComboboxEmpty>
          <ComboboxList>
            {(bundle) => (
              <ComboboxItem
                className="min-h-12 px-3 py-2"
                key={bundle.bundleId}
                value={bundle}
              >
                <span className="flex min-w-0 flex-col gap-1 pr-5">
                  <span className="truncate text-xs/4">
                    {bundle.description}
                  </span>
                  <code
                    className="max-w-72 truncate text-xs/4 text-muted-foreground"
                    title={bundle.bundleId}
                  >
                    {shortenIdentifier(bundle.bundleId)}
                  </code>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </Field>
  );
}
