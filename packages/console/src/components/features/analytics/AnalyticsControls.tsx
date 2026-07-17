import type { ActiveInstallationWindow } from "@hot-updater/plugin-core";
import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  onUserIdChange,
  onWindowChange,
  userId,
  window,
}: {
  readonly onUserIdChange: (userId: string | undefined) => void;
  readonly onWindowChange: (window: ActiveInstallationWindow) => void;
  readonly userId: string | undefined;
  readonly window: ActiveInstallationWindow;
}) {
  const [draft, setDraft] = useState(userId ?? "");

  useEffect(() => setDraft(userId ?? ""), [userId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Report scope</h2>
        </CardTitle>
        <CardDescription>
          Rolling server-receipt window with an optional exact, case-sensitive
          User ID alias.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          aria-label="Filter analytics"
          className="grid min-w-0 gap-3 md:grid-cols-2 md:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            onUserIdChange(draft.trim() || undefined);
          }}
          role="search"
        >
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs font-medium">Activity window</span>
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
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label className="text-xs font-medium" htmlFor="active-user-id">
              Exact User ID alias
            </label>
            <InputGroup className="h-8">
              <InputGroupAddon>
                <Search aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="User ID alias"
                id="active-user-id"
                maxLength={1024}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Alias/B"
                value={draft}
              />
              <InputGroupAddon align="inline-end">
                {(draft || userId) && (
                  <InputGroupButton
                    aria-label="Clear User ID"
                    onClick={() => {
                      setDraft("");
                      onUserIdChange(undefined);
                    }}
                    size="icon-xs"
                  >
                    <X aria-hidden="true" />
                  </InputGroupButton>
                )}
                <InputGroupButton type="submit" variant="default">
                  Apply
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
