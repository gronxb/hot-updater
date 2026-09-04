import type { Bundle, ChannelRow, ReleaseRow } from "@hot-updater/plugin-core";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleOff,
  Fingerprint,
  Filter,
  Package,
  RotateCcw,
  Tags,
  X,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { ChannelBadge } from "@/components/ChannelBadge";
import { EnabledStatusIcon } from "@/components/EnabledStatusIcon";
import { BundleChildrenPanel } from "@/components/features/bundles/BundleChildrenPanel";
import { ChannelManagementDialog } from "@/components/features/channels/ChannelManagementDialog";
import { ReleaseEditorSheet } from "@/components/features/releases/ReleaseEditorSheet";
import { ReleaseStateBadge } from "@/components/features/releases/ReleaseStateBadge";
import { HashValueDisplay } from "@/components/HashValueDisplay";
import { PlatformIcon } from "@/components/PlatformIcon";
import { RolloutPercentageBadge } from "@/components/RolloutPercentageBadge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  useBundleChildCountsQuery,
  useBundleChildrenQuery,
  useBundleQuery,
  useChannelsQuery,
  useReleasesQuery,
} from "@/lib/api";
import type { ReleaseListRow } from "@/lib/server/releaseReachability";
import { cn } from "@/lib/utils";

import {
  type ReleaseSearch,
  updateReleaseFilters,
  validateReleaseSearch,
} from "./-releases-search";

const PAGE_SIZE = 20;
const platformFilterItems = [
  { label: "All Platforms", value: "all" },
  { label: "iOS", value: "ios" },
  { label: "Android", value: "android" },
];
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const tableDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

export const Route = createFileRoute("/")({
  component: BundlesPage,
  validateSearch: validateReleaseSearch,
});

function BundleFilterToolbar({
  channels,
  onChange,
  onClear,
  onManageChannels,
  search,
}: {
  channels: readonly ChannelRow[];
  onChange: (filters: Partial<ReleaseSearch>) => void;
  onClear: () => void;
  onManageChannels: () => void;
  search: ReleaseSearch;
}) {
  const [targetAppVersion, setTargetAppVersion] = useState(
    search.targetAppVersion ?? "",
  );
  const hasFilters = Boolean(
    search.bundleId ||
    search.channelId ||
    search.enabled !== undefined ||
    search.platform ||
    search.targetAppVersion,
  );
  const channelFilterItems = [
    { label: "All Channels", value: "all" },
    ...channels.map((channel) => ({
      label: channel.name,
      value: channel.id,
    })),
  ];
  const applyTargetAppVersion = () => {
    const value = targetAppVersion.trim();
    onChange({ targetAppVersion: value || undefined });
  };

  useEffect(() => {
    setTargetAppVersion(search.targetAppVersion ?? "");
  }, [search.targetAppVersion]);

  return (
    <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-3 sm:h-12 sm:flex-nowrap sm:bg-card/70 sm:px-4 sm:py-0 sm:backdrop-blur-sm">
      <SidebarTrigger className="-ml-1" />
      <h1 className="sr-only">Bundles</h1>
      <div className="ml-1 flex items-center gap-1.5 text-muted-foreground sm:ml-2">
        <Filter className="size-3.5" />
        <span className="text-xs font-medium">Filters</span>
      </div>
      <Select
        items={platformFilterItems}
        onValueChange={(value) =>
          onChange({
            platform:
              value === "all" ? undefined : (value as "ios" | "android"),
          })
        }
        value={search.platform ?? "all"}
      >
        <SelectTrigger
          aria-label="Platform"
          className="h-8 w-[calc(50%-0.25rem)] min-w-[132px] text-xs sm:w-[140px]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">All Platforms</SelectItem>
            <SelectItem value="ios">iOS</SelectItem>
            <SelectItem value="android">Android</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <Input
        aria-label="Target app version"
        className="h-8 w-full min-w-[132px] text-xs sm:w-[160px]"
        onBlur={applyTargetAppVersion}
        onChange={(event) => setTargetAppVersion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            applyTargetAppVersion();
          }
        }}
        placeholder="Target version"
        value={targetAppVersion}
      />
      <Select
        items={channelFilterItems}
        onValueChange={(value) =>
          onChange({
            channelId: value === null || value === "all" ? undefined : value,
          })
        }
        value={search.channelId ?? "all"}
      >
        <SelectTrigger
          aria-label="Channel"
          className="h-8 w-[calc(50%-0.25rem)] min-w-[132px] text-xs sm:w-[140px]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">All Channels</SelectItem>
            {channels.map((channel) => (
              <SelectItem key={channel.id} value={channel.id}>
                {channel.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Button
        aria-label="Manage channels"
        onClick={onManageChannels}
        size="icon-sm"
        title="Manage channels"
        variant="outline"
      >
        <Tags />
      </Button>
      {search.bundleId ? (
        <Badge className="max-w-48 gap-1" variant="secondary">
          Artifact filter
          <button
            aria-label="Clear artifact filter"
            className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onChange({ bundleId: undefined })}
            type="button"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ) : null}
      {hasFilters ? (
        <Button
          className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground sm:ml-auto"
          onClick={onClear}
          size="sm"
          variant="ghost"
        >
          <X data-icon="inline-start" />
          Clear
        </Button>
      ) : null}
    </header>
  );
}

function BundleEntry({
  expanded,
  onOpen,
  onToggleExpand,
  release,
}: {
  expanded: boolean;
  onOpen: () => void;
  onToggleExpand: () => void;
  release: ReleaseListRow;
}) {
  const operationLabel =
    release.operation === "PROMOTE"
      ? "Promoted"
      : release.operation === "ROLLBACK"
        ? "Rollback"
        : null;

  return (
    <div className="flex min-w-[240px] items-center gap-3">
      {release.bundle_id ? (
        <Button
          aria-controls={`bundle-lineage-panel-${release.id}`}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? "Hide advanced artifact diagnostics"
              : "Show advanced artifact diagnostics"
          }
          title="Advanced artifact diagnostics"
          className="size-8 shrink-0 touch-manipulation"
          onClick={onToggleExpand}
          size="icon"
          type="button"
          variant="ghost"
        >
          {expanded ? <ChevronDown /> : <ChevronRight />}
        </Button>
      ) : (
        <span aria-hidden="true" className="size-8 shrink-0" />
      )}
      <button
        aria-label={`Open details for ID ${release.id}`}
        className="min-w-0 rounded-sm text-left text-foreground transition-colors underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
        title={release.id}
        type="button"
      >
        <BundleIdDisplay bundleId={release.id} fullOnMobile />
        {!release.bundle_id ? (
          <span className="inline-flex items-center gap-1.5 text-sm">
            <RotateCcw className="size-3.5" /> Built-in app
          </span>
        ) : null}
      </button>
      {operationLabel ? (
        <Badge className="shrink-0 font-normal" variant="secondary">
          {operationLabel}
        </Badge>
      ) : null}
      {release.currentlyUnreachable ? (
        <span
          aria-label="Currently unreachable. No catalog segment or cohort selects this bundle first."
          className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
          title="No catalog segment or cohort selects this bundle first with the current delivery settings."
        >
          <CircleOff className="size-3.5" />
          Unreachable
        </span>
      ) : null}
    </div>
  );
}

function ReleaseBundleChildrenPanel({
  onDetailClick,
  panelId,
  release,
}: {
  onDetailClick: (bundle: Bundle) => void;
  panelId: string;
  release: ReleaseRow;
}) {
  const bundleId = release.bundle_id ?? "";
  const bundleQuery = useBundleQuery(bundleId);
  const childrenQuery = useBundleChildrenQuery(bundleId);

  if (bundleQuery.isError || childrenQuery.isError) {
    return (
      <div
        aria-live="polite"
        className="border-t bg-muted/10 p-4 text-sm text-muted-foreground"
        id={panelId}
      >
        Patch lineage could not be loaded.
      </div>
    );
  }

  if (bundleQuery.isPending) {
    return (
      <div
        aria-live="polite"
        className="flex flex-col gap-2 border-t bg-muted/10 p-4"
        id={panelId}
      >
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!bundleQuery.data) {
    return (
      <div
        aria-live="polite"
        className="border-t bg-muted/10 p-4 text-sm text-muted-foreground"
        id={panelId}
      >
        Bundle details are unavailable.
      </div>
    );
  }

  return (
    <BundleChildrenPanel
      bundle={bundleQuery.data}
      bundles={childrenQuery.data ?? []}
      loading={childrenQuery.isPending}
      onDetailClick={onDetailClick}
      panelId={panelId}
    />
  );
}

function BundlesPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const isMobile = useIsMobile();
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [expandedReleaseId, setExpandedReleaseId] = useState<string>();
  const releasesQuery = useReleasesQuery({
    afterReleaseId: search.afterReleaseId,
    beforeReleaseId: search.beforeReleaseId,
    bundleId: search.bundleId,
    channelId: search.channelId,
    enabled: search.enabled,
    limit: PAGE_SIZE,
    page: search.page,
    platform: search.platform,
    targetAppVersion: search.targetAppVersion,
  });
  const channelsQuery = useChannelsQuery();
  const channels = channelsQuery.data ?? [];
  const releases = releasesQuery.data?.data ?? [];
  const bundleIds = Array.from(
    new Set(
      releases.flatMap((release) =>
        release.bundle_id ? [release.bundle_id] : [],
      ),
    ),
  );
  const patchCountsQuery = useBundleChildCountsQuery(bundleIds);
  const patchCountsByBundleId = patchCountsQuery.data ?? {};
  const pagination = releasesQuery.data?.pagination;
  const channelNames = new Map(
    channels.map((channel) => [channel.id, channel.name]),
  );

  useEffect(() => {
    if (
      expandedReleaseId &&
      !releases.some((release) => release.id === expandedReleaseId)
    ) {
      setExpandedReleaseId(undefined);
    }
  }, [expandedReleaseId, releases]);

  const go = (nextSearch: ReleaseSearch, resetScroll = true) =>
    void navigate({ resetScroll, search: nextSearch, to: "/" });
  const changeFilters = (filters: Partial<ReleaseSearch>) =>
    go(updateReleaseFilters(search, filters));
  const openChildBundle = (bundle: Bundle) => {
    const childRelease = releases.find(
      (release) => release.bundle_id === bundle.id,
    );
    setExpandedReleaseId(undefined);
    if (childRelease) {
      go({ ...search, releaseId: childRelease.id }, false);
      return;
    }
    changeFilters({ bundleId: bundle.id });
  };
  const currentPage = pagination?.currentPage ?? 1;
  const startEntry =
    releases.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const endEntry = startEntry === 0 ? 0 : startEntry + releases.length - 1;
  const previousPage = currentPage - 1;
  const firstReleaseId = releases[0]?.id;
  const lastReleaseId = releases.at(-1)?.id;
  const previousSearch: ReleaseSearch | null =
    pagination?.hasPreviousPage && firstReleaseId
      ? {
          ...search,
          afterReleaseId: firstReleaseId,
          beforeReleaseId: undefined,
          page: previousPage > 1 ? previousPage : undefined,
          releaseId: undefined,
        }
      : null;
  const nextSearch: ReleaseSearch | null =
    pagination?.hasNextPage && lastReleaseId
      ? {
          ...search,
          afterReleaseId: undefined,
          beforeReleaseId: lastReleaseId,
          page: currentPage + 1,
          releaseId: undefined,
        }
      : null;

  return (
    <div className="flex h-svh min-h-0 min-w-0 flex-col">
      <BundleFilterToolbar
        channels={channels}
        onChange={changeFilters}
        onClear={() => go({})}
        onManageChannels={() => setChannelsOpen(true)}
        search={search}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 bg-muted/5 p-3 sm:p-6">
        {releasesQuery.isError ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Bundles could not be loaded</AlertTitle>
            <AlertDescription>{releasesQuery.error.message}</AlertDescription>
          </Alert>
        ) : (
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm [&_[data-slot=table-container]]:h-full [&_[data-slot=table-container]]:overflow-auto">
            {isMobile ? (
              <div className="h-full overflow-y-auto">
                {releasesQuery.isPending ? (
                  <div className="flex flex-col gap-3 p-4">
                    {Array.from({ length: 5 }, (_, index) => (
                      <Skeleton className="h-44 w-full" key={index} />
                    ))}
                  </div>
                ) : releases.length ? (
                  releases.map((release) => {
                    const channelName =
                      channelNames.get(release.channel_id) ??
                      release.channel_id;
                    const patchCount = release.bundle_id
                      ? patchCountsByBundleId[release.bundle_id]
                      : 0;
                    const isExpanded = expandedReleaseId === release.id;
                    const panelId = `bundle-lineage-panel-${release.id}`;

                    return (
                      <Fragment key={release.id}>
                        <article
                          className={cn(
                            "flex flex-col gap-4 border-b p-4 last:border-b-0",
                            release.currentlyUnreachable &&
                              "bg-muted/35 saturate-50 transition-[background-color,filter] focus-within:saturate-100 motion-reduce:transition-none",
                            isExpanded && "border-b-0 bg-primary/5",
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <BundleEntry
                              expanded={isExpanded}
                              onOpen={() =>
                                go({ ...search, releaseId: release.id }, false)
                              }
                              onToggleExpand={() =>
                                setExpandedReleaseId(
                                  isExpanded ? undefined : release.id,
                                )
                              }
                              release={release}
                            />
                            <ChannelBadge
                              channel={channelName}
                              className="shrink-0"
                            />
                          </div>
                          <dl className="grid grid-cols-2 gap-3 text-xs">
                            <div className="rounded-md bg-muted/40 p-3">
                              <dt className="text-muted-foreground">
                                Platform
                              </dt>
                              <dd className="mt-1 flex items-center gap-2 font-medium">
                                <PlatformIcon
                                  className="size-4"
                                  platform={release.platform}
                                />
                                {release.platform === "ios" ? "iOS" : "Android"}
                              </dd>
                            </div>
                            <div className="rounded-md bg-muted/40 p-3">
                              <dt className="text-muted-foreground">Created</dt>
                              <dd className="mt-1 tabular-nums">
                                {dateFormatter.format(release.created_at_ms)}
                              </dd>
                            </div>
                            <div className="rounded-md bg-muted/40 p-3">
                              <dt className="text-muted-foreground">Rollout</dt>
                              <dd className="mt-1">
                                <RolloutPercentageBadge
                                  percentage={release.rollout_cohort_count / 10}
                                />
                              </dd>
                            </div>
                            <div className="rounded-md bg-muted/40 p-3">
                              <dt className="text-muted-foreground">Patches</dt>
                              <dd className="mt-1">
                                {patchCount === undefined
                                  ? "Checking"
                                  : patchCount > 0
                                    ? `${patchCount} ${
                                        patchCount === 1 ? "patch" : "patches"
                                      }`
                                    : "—"}
                              </dd>
                            </div>
                            <div className="col-span-2 flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3">
                              <ReleaseStateBadge release={release} />
                              {release.should_force_update ? (
                                <Badge variant="secondary">Force update</Badge>
                              ) : null}
                            </div>
                            <div className="col-span-2 grid gap-2 rounded-md border bg-background/80 p-3">
                              <div className="flex items-start justify-between gap-3">
                                <dt className="text-muted-foreground">
                                  Target
                                </dt>
                                <dd className="min-w-0 truncate text-right font-mono">
                                  {release.target_app_version ??
                                    release.fingerprint_hash ??
                                    "—"}
                                </dd>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <dt className="text-muted-foreground">
                                  Message
                                </dt>
                                <dd className="min-w-0 text-right text-foreground">
                                  {release.message || "—"}
                                </dd>
                              </div>
                            </div>
                          </dl>
                        </article>
                        {isExpanded && release.bundle_id ? (
                          <ReleaseBundleChildrenPanel
                            onDetailClick={openChildBundle}
                            panelId={panelId}
                            release={release}
                          />
                        ) : null}
                      </Fragment>
                    );
                  })
                ) : (
                  <p className="p-8 text-center text-sm text-muted-foreground">
                    {search.bundleId ||
                    search.channelId ||
                    search.enabled !== undefined ||
                    search.platform ||
                    search.targetAppVersion
                      ? "No bundles match these filters."
                      : "No bundles yet. Deploy an update to see it here."}
                  </p>
                )}
              </div>
            ) : (
              <Table className="min-w-max">
                <TableHeader className="bg-muted/40">
                  <TableRow className="border-b border-border/60 hover:bg-transparent [&>th]:h-10 [&>th]:text-xs [&>th]:font-semibold [&>th]:uppercase [&>th]:text-muted-foreground/70">
                    <TableHead>ID</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Platform</TableHead>
                    <TableHead>Patches</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Enabled</TableHead>
                    <TableHead>Force update</TableHead>
                    <TableHead>Rollout</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {releasesQuery.isPending
                    ? Array.from({ length: 7 }, (_, index) => (
                        <TableRow key={index}>
                          <TableCell colSpan={10}>
                            <Skeleton className="h-8 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    : releases.map((release) => {
                        const isExpanded = expandedReleaseId === release.id;
                        const panelId = `bundle-lineage-panel-${release.id}`;

                        return (
                          <Fragment key={release.id}>
                            <TableRow
                              aria-label={`Open bundle ${release.id}`}
                              className={cn(
                                "cursor-pointer transition-[background-color,filter] hover:bg-muted/10 focus-within:bg-muted/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none data-[state=selected]:bg-muted/15 [&>td]:py-3",
                                release.currentlyUnreachable &&
                                  "bg-muted/35 saturate-50 hover:bg-muted/50 hover:saturate-100 focus-within:saturate-100",
                                isExpanded && "bg-primary/5",
                              )}
                              data-state={
                                search.releaseId === release.id
                                  ? "selected"
                                  : undefined
                              }
                              onClick={(event) => {
                                if (
                                  event.target instanceof Element &&
                                  event.target.closest(
                                    "button, a, input, select, textarea",
                                  )
                                ) {
                                  return;
                                }
                                go({ ...search, releaseId: release.id }, false);
                              }}
                              onKeyDown={(event) => {
                                if (
                                  event.target !== event.currentTarget ||
                                  (event.key !== "Enter" && event.key !== " ")
                                ) {
                                  return;
                                }
                                event.preventDefault();
                                go({ ...search, releaseId: release.id }, false);
                              }}
                              tabIndex={0}
                            >
                              <TableCell>
                                <BundleEntry
                                  expanded={isExpanded}
                                  onOpen={() =>
                                    go(
                                      { ...search, releaseId: release.id },
                                      false,
                                    )
                                  }
                                  onToggleExpand={() =>
                                    setExpandedReleaseId(
                                      isExpanded ? undefined : release.id,
                                    )
                                  }
                                  release={release}
                                />
                              </TableCell>
                              <TableCell>
                                <ChannelBadge
                                  channel={
                                    channelNames.get(release.channel_id) ??
                                    release.channel_id
                                  }
                                />
                              </TableCell>
                              <TableCell className="whitespace-nowrap">
                                <span className="flex items-center gap-2">
                                  <PlatformIcon
                                    className="size-4"
                                    platform={release.platform}
                                  />
                                  {release.platform === "ios"
                                    ? "iOS"
                                    : "Android"}
                                </span>
                              </TableCell>
                              <TableCell>
                                {release.bundle_id &&
                                patchCountsByBundleId[release.bundle_id] ===
                                  undefined ? (
                                  <span className="text-sm text-muted-foreground">
                                    Checking
                                  </span>
                                ) : release.bundle_id &&
                                  patchCountsByBundleId[release.bundle_id]! >
                                    0 ? (
                                  <Badge variant="secondary">
                                    {patchCountsByBundleId[release.bundle_id]}{" "}
                                    {patchCountsByBundleId[
                                      release.bundle_id
                                    ] === 1
                                      ? "patch"
                                      : "patches"}
                                  </Badge>
                                ) : (
                                  <span className="text-muted-foreground">
                                    -
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                {release.target_app_version ? (
                                  <span className="flex items-center gap-2">
                                    <Package className="size-4 shrink-0 text-muted-foreground" />
                                    <span className="font-medium">
                                      {release.target_app_version}
                                    </span>
                                  </span>
                                ) : release.fingerprint_hash ? (
                                  <span className="flex min-w-[160px] items-center gap-2">
                                    <Fingerprint className="size-4 shrink-0 text-muted-foreground" />
                                    <HashValueDisplay
                                      maxLength={12}
                                      value={release.fingerprint_hash}
                                    />
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">
                                    -
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                <span className="flex items-center">
                                  <EnabledStatusIcon
                                    enabled={release.enabled}
                                  />
                                  <span className="sr-only">
                                    {release.enabled ? "Enabled" : "Disabled"}
                                  </span>
                                </span>
                              </TableCell>
                              <TableCell>
                                <span className="flex items-center">
                                  <EnabledStatusIcon
                                    enabled={release.should_force_update}
                                    falseIcon="minus"
                                  />
                                  <span className="sr-only">
                                    {release.should_force_update
                                      ? "Required"
                                      : "Optional"}
                                  </span>
                                </span>
                              </TableCell>
                              <TableCell>
                                <RolloutPercentageBadge
                                  percentage={release.rollout_cohort_count / 10}
                                />
                              </TableCell>
                              <TableCell
                                className="text-sm text-muted-foreground"
                                title={release.message ?? undefined}
                              >
                                {release.message || "-"}
                              </TableCell>
                              <TableCell
                                className="whitespace-nowrap text-xs text-muted-foreground"
                                title={dateFormatter.format(
                                  release.created_at_ms,
                                )}
                              >
                                {tableDateFormatter.format(
                                  release.created_at_ms,
                                )}
                              </TableCell>
                            </TableRow>
                            {isExpanded && release.bundle_id ? (
                              <TableRow className="hover:bg-transparent">
                                <TableCell
                                  className="border-t-0 p-0"
                                  colSpan={10}
                                >
                                  <ReleaseBundleChildrenPanel
                                    onDetailClick={openChildBundle}
                                    panelId={panelId}
                                    release={release}
                                  />
                                </TableCell>
                              </TableRow>
                            ) : null}
                          </Fragment>
                        );
                      })}
                  {!releasesQuery.isPending && releases.length === 0 ? (
                    <TableRow>
                      <TableCell
                        className="h-40 text-center text-muted-foreground"
                        colSpan={10}
                      >
                        {search.bundleId ||
                        search.channelId ||
                        search.enabled !== undefined ||
                        search.platform ||
                        search.targetAppVersion
                          ? "No bundles match these filters."
                          : "No bundles yet. Deploy an update to see it here."}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            )}
          </div>
        )}

        {!releasesQuery.isError && !releasesQuery.isPending ? (
          <nav
            aria-label="Bundle pagination"
            className="flex flex-col gap-3 px-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-xs font-medium text-muted-foreground">
              Showing <span className="text-foreground">{startEntry}</span> to{" "}
              <span className="text-foreground">{endEntry}</span> entries
            </p>
            <div className="flex flex-wrap items-center gap-3 sm:justify-end">
              <p className="text-xs font-medium text-muted-foreground">
                Page <span className="text-foreground">{currentPage}</span>
              </p>
              {previousSearch ? (
                <Link
                  className={buttonVariants({
                    className: "h-8 flex-1 px-3 text-xs sm:flex-none",
                    size: "sm",
                    variant: "outline",
                  })}
                  search={previousSearch}
                  to="/"
                >
                  <ChevronLeft data-icon="inline-start" />
                  Previous
                </Link>
              ) : (
                <Button
                  className="h-8 flex-1 px-3 text-xs sm:flex-none"
                  disabled
                  size="sm"
                  variant="outline"
                >
                  <ChevronLeft data-icon="inline-start" />
                  Previous
                </Button>
              )}
              {nextSearch ? (
                <Link
                  className={buttonVariants({
                    className: "h-8 flex-1 px-3 text-xs sm:flex-none",
                    size: "sm",
                    variant: "outline",
                  })}
                  search={nextSearch}
                  to="/"
                >
                  Next
                  <ChevronRight data-icon="inline-end" />
                </Link>
              ) : (
                <Button
                  className="h-8 flex-1 px-3 text-xs sm:flex-none"
                  disabled
                  size="sm"
                  variant="outline"
                >
                  Next
                  <ChevronRight data-icon="inline-end" />
                </Button>
              )}
            </div>
          </nav>
        ) : null}
      </div>

      <ReleaseEditorSheet
        channels={channels}
        onOpenChange={(open) =>
          !open && go({ ...search, releaseId: undefined }, false)
        }
        open={Boolean(search.releaseId)}
        releaseId={search.releaseId ?? ""}
      />
      <ChannelManagementDialog
        onOpenChange={setChannelsOpen}
        open={channelsOpen}
      />
    </div>
  );
}
