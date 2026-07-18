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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const windows = [
  { value: "24h", label: "24 hours", shortLabel: "24h" },
  { value: "7d", label: "7 days", shortLabel: "7d" },
  { value: "30d", label: "30 days", shortLabel: "30d" },
] as const;

export function AnalyticsControls({
  onInstallationSearch,
  onWindowChange,
  window,
}: {
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
        className="flex min-w-0 flex-col gap-3 md:flex-row md:items-end md:justify-between"
        onSubmit={(event) => {
          event.preventDefault();
          const query = draft.trim();
          if (query) onInstallationSearch(query);
        }}
        role="search"
      >
        <FieldGroup className="gap-3 md:flex-row md:items-end md:justify-between">
          <Field className="min-w-0 md:w-auto">
            <FieldLabel>Activity window</FieldLabel>
            <ToggleGroup
              aria-label="Activity window"
              className="w-full md:w-fit"
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
          <Field className="min-w-0 flex-1 md:max-w-sm">
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
