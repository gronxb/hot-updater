import { isUUIDv7 } from "@hot-updater/protocol";
import { useQuery } from "@tanstack/react-query";
import { CircleOff } from "lucide-react";
import { type ReactNode, useState } from "react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Badge } from "@/components/ui/badge";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@/components/ui/combobox";
import type {
  AdoptionRelease,
  AdoptionReleasesInput,
} from "@/lib/release-adoption";
import { getAdoptionReleaseRpc } from "@/lib/release-adoption-rpc";

import { formatDeployedAt } from "./ComparedBundlesChart";
import { platformLabel } from "./InsightsScope";

type ReleaseGroup = {
  readonly value: string;
  readonly items: readonly AdoptionRelease[];
};

/** Whether a bundle deployment matches what was typed: its IDs or target app version. */
const matches = (release: AdoptionRelease, typed: string) =>
  typed === "" ||
  release.releaseId.includes(typed) ||
  release.bundleId.toLowerCase().includes(typed) ||
  (release.targetAppVersion ?? "").toLowerCase().includes(typed);

/** A bundle deployment as a picker names it: ID, platform, deployment, target, and state. */
export function ReleaseOption({
  release,
}: {
  readonly release: AdoptionRelease;
}) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <PlatformIcon platform={release.platform} className="size-3 shrink-0" />
        <span className="sr-only">{platformLabel(release.platform)}</span>
        <BundleIdDisplay bundleId={release.releaseId} className="min-w-0" />
      </span>
      <span className="text-xs text-muted-foreground">
        Deployed {formatDeployedAt(release.deployedAtMs)}
        {release.targetAppVersion ? ` · ${release.targetAppVersion}` : ""}
        {release.enabled ? null : (
          <>
            {" · "}
            <Badge variant="outline">Disabled</Badge>
          </>
        )}
        {release.enabled && !release.live ? (
          <>
            {" · "}
            <span className="inline-flex items-center gap-1 align-middle">
              <CircleOff aria-hidden="true" className="size-3" />
              Unreachable
            </span>
          </>
        ) : null}
      </span>
    </span>
  );
}

/**
 * Picks one of a channel's bundle deployments: live ones first, searchable
 * by ID or target app version. A full release ID the list leaves out is
 * looked up in the scope, with the read Release health uses for it.
 */
export function ReleaseCombobox({
  scope,
  candidates,
  excluded = [],
  onPick,
  disabled = false,
  label,
  placeholder,
  trigger,
}: {
  readonly scope: AdoptionReleasesInput;
  readonly candidates: readonly AdoptionRelease[];
  readonly excluded?: readonly string[];
  readonly onPick: (release: AdoptionRelease) => void;
  readonly disabled?: boolean;
  /** The input's accessible name. */
  readonly label: string;
  readonly placeholder: string;
  /** A button that opens the list; the search input then sits in the list. */
  readonly trigger?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const typed = query.trim().toLowerCase();
  const offered = candidates.filter(
    (release) =>
      !excluded.includes(release.releaseId) && matches(release, typed),
  );
  const lookupId =
    offered.length === 0 &&
    isUUIDv7(typed) &&
    !candidates.some((release) => release.releaseId === typed)
      ? typed
      : undefined;
  const lookup = useQuery({
    queryKey: ["insights", "adoption-release", scope, lookupId, false],
    queryFn: () =>
      getAdoptionReleaseRpc({ data: { ...scope, releaseId: lookupId! } }),
    enabled: lookupId !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const found =
    lookupId !== undefined &&
    lookup.data?.release &&
    !excluded.includes(lookup.data.release.releaseId)
      ? [lookup.data.release]
      : [];
  const groups: ReleaseGroup[] = [
    { value: "Live", items: offered.filter((release) => release.live) },
    { value: "Not live", items: offered.filter((release) => !release.live) },
    { value: "Found", items: found },
  ].filter((group) => group.items.length > 0);
  const input = (
    <ComboboxInput
      aria-label={label}
      className={
        trigger
          ? undefined
          : "h-11 w-full sm:h-9 sm:w-96 [&_input]:h-full [&_input]:text-base sm:[&_input]:text-xs"
      }
      disabled={disabled}
      placeholder={placeholder}
      showTrigger={!trigger}
      maxLength={1024}
    />
  );

  return (
    <Combobox
      items={groups}
      filter={null}
      value={null}
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={(release: AdoptionRelease) => release.releaseId}
      onValueChange={(release: AdoptionRelease | null) => {
        if (release === null) return;
        setQuery("");
        onPick(release);
      }}
      disabled={disabled}
    >
      {trigger ?? input}
      <ComboboxContent className={trigger ? "w-96" : undefined}>
        {trigger ? input : null}
        <ComboboxEmpty>
          {lookupId === undefined
            ? "No matching bundles."
            : lookup.isPending
              ? "Looking up the release…"
              : lookup.isError
                ? "Couldn't look up the release."
                : `No bundle with this ID in ${scope.channel} · ${platformLabel(scope.platform)}.`}
        </ComboboxEmpty>
        <ComboboxList>
          {(group: ReleaseGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(release: AdoptionRelease) => (
                  <ComboboxItem
                    className="min-h-11 pr-8 sm:min-h-8"
                    key={release.releaseId}
                    value={release}
                  >
                    <ReleaseOption release={release} />
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
