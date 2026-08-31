import type { ActiveInstallationWindow } from "@hot-updater/server";
import { Link } from "@tanstack/react-router";
import { History, Search, X } from "lucide-react";
import { useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
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

export function InsightsControls({
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
      aria-label="Insights controls"
      className="rounded-xl border bg-background px-4 py-3"
    >
      <form
        aria-label="Filter insights"
        className="min-w-0"
        onSubmit={(event) => {
          event.preventDefault();
          const query = draft.trim();
          if (query) onInstallationSearch(query);
        }}
        role="search"
      >
        <FieldGroup className="gap-3 lg:grid lg:grid-cols-[auto_minmax(18rem,1fr)] lg:items-end">
          <Field className="min-w-0">
            <FieldLabel>Reporting period</FieldLabel>
            <ToggleGroup
              aria-label="Reporting period"
              className="w-full lg:w-fit"
              onValueChange={(value) => {
                if (value[0]) {
                  onWindowChange(value[0] as ActiveInstallationWindow);
                }
              }}
              spacing={0}
              size="lg"
              value={[window]}
              variant="outline"
            >
              {windows.map((item) => (
                <ToggleGroupItem
                  aria-label={item.label}
                  className="flex-1 lg:flex-none"
                  key={item.value}
                  value={item.value}
                >
                  {item.shortLabel}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          <Field className="min-w-0">
            <FieldLabel htmlFor="installation-history-search">
              Installation history
            </FieldLabel>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
              <InputGroup className="h-8 flex-1">
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
                {draft && (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      aria-label="Clear installation search"
                      onClick={() => setDraft("")}
                      size="icon-xs"
                    >
                      <X aria-hidden="true" />
                    </InputGroupButton>
                  </InputGroupAddon>
                )}
              </InputGroup>
              <Button className="w-full sm:w-auto" size="lg" type="submit">
                <Search aria-hidden="true" data-icon="inline-start" />
                Search
              </Button>
              <Link
                className={buttonVariants({
                  className: "w-full sm:w-auto",
                  size: "lg",
                  variant: "outline",
                })}
                to="/installations"
                search={{
                  query: undefined,
                  installId: undefined,
                  searchOffset: 0,
                  historyOffset: 0,
                }}
              >
                <History aria-hidden="true" data-icon="inline-start" />
                View all events
              </Link>
            </div>
          </Field>
        </FieldGroup>
      </form>
    </section>
  );
}
