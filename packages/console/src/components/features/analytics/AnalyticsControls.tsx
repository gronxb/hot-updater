import type { ActiveInstallationWindow } from "@hot-updater/plugin-core";
import { Search, X } from "lucide-react";
import { useState } from "react";

import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const windows = [
  { value: "24h", label: "24 hours", shortLabel: "24h" },
  { value: "7d", label: "7 days", shortLabel: "7d" },
  { value: "30d", label: "30 days", shortLabel: "30d" },
] as const;

export function AnalyticsControls({
  bundleId,
  bundles,
  onBundleChange,
  onInstallationSearch,
  onWindowChange,
  window,
}: {
  readonly bundleId: string;
  readonly bundles: readonly {
    readonly bundleId: string;
    readonly description: string;
  }[];
  readonly onBundleChange: (bundleId: string) => void;
  readonly onInstallationSearch: (query: string) => void;
  readonly onWindowChange: (window: ActiveInstallationWindow) => void;
  readonly window: ActiveInstallationWindow;
}) {
  const [draft, setDraft] = useState("");

  return (
    <section
      aria-label="Analytics controls"
      className="rounded-xl border bg-background px-4 py-3"
    >
      <form
        aria-label="Filter analytics"
        className="min-w-0"
        onSubmit={(event) => {
          event.preventDefault();
          const query = draft.trim();
          if (query) onInstallationSearch(query);
        }}
        role="search"
      >
        <FieldGroup className="gap-3 md:grid md:grid-cols-2 md:items-end lg:grid-cols-[auto_minmax(14rem,1fr)_minmax(18rem,1.2fr)]">
          <Field className="min-w-0">
            <FieldLabel>Reporting period</FieldLabel>
            <ToggleGroup
              aria-label="Reporting period"
              className="w-full lg:w-fit"
              onValueChange={(value) => {
                if (value) onWindowChange(value as ActiveInstallationWindow);
              }}
              spacing={0}
              type="single"
              value={window}
              variant="outline"
            >
              {windows.map((item) => (
                <ToggleGroupItem
                  aria-label={item.label}
                  className="flex-1 md:flex-none"
                  key={item.value}
                  value={item.value}
                >
                  {item.shortLabel}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          <Field className="min-w-0">
            <FieldLabel htmlFor="analytics-bundle-selector">
              Bundle to inspect
            </FieldLabel>
            <Select
              disabled={bundles.length === 0}
              onValueChange={(value) => value && onBundleChange(value)}
              value={bundleId}
            >
              <SelectTrigger
                aria-label="Bundle to inspect"
                className="h-8 min-w-0 font-mono text-xs"
                id="analytics-bundle-selector"
              >
                <SelectValue placeholder="No bundles available" />
              </SelectTrigger>
              <SelectContent>
                {bundles.map((bundle) => (
                  <SelectItem key={bundle.bundleId} value={bundle.bundleId}>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <code className="max-w-72 truncate text-xs">
                        {bundle.bundleId}
                      </code>
                      <span className="text-xs text-muted-foreground">
                        {bundle.description}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field className="min-w-0 md:col-span-2 lg:col-span-1">
            <FieldLabel htmlFor="installation-history-search">
              Installation history
            </FieldLabel>
            <InputGroup className="h-8">
              <InputGroupAddon>
                <Search aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="User or install ID"
                id="installation-history-search"
                maxLength={1024}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="User ID or install ID"
                type="search"
                value={draft}
              />
              <InputGroupAddon align="inline-end">
                {draft && (
                  <InputGroupButton
                    aria-label="Clear installation search"
                    onClick={() => setDraft("")}
                    size="icon-xs"
                  >
                    <X aria-hidden="true" />
                  </InputGroupButton>
                )}
                <InputGroupButton type="submit" variant="default">
                  Search
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </Field>
        </FieldGroup>
      </form>
    </section>
  );
}
