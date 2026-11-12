import type { Bundle, ChannelRow, ReleaseRow } from "@hot-updater/plugin-core";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleOff,
  Filter,
  Package,
  RefreshCw,
  RotateCcw,
  Tags,
  X,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { ChannelBadge } from "@/components/ChannelBadge";
import {
  DataCard,
  DataCardSkeletons,
  DataCardsEmpty,
  DataTable,
  DataTableBody,
  DataTableFrame,
  DataTableEmpty,
  DataTableFullRow,
  DataTablePagination,
  DataTableRow,
  openOutsideControls,
  DataTableSkeletonRows,
} from "@/components/DataTable";
import { EnabledStatusIcon } from "@/components/EnabledStatusIcon";
import { BundleChildrenPanel } from "@/components/features/bundles/BundleChildrenPanel";
import { ChannelManagementDialog } from "@/components/features/channels/ChannelManagementDialog";
import { useReleaseColumns } from "@/components/features/FeatureSlots";
import { CopyableText } from "@/components/features/native-builds/CopyableText";
import { ReleaseEditorSheet } from "@/components/features/releases/ReleaseEditorSheet";
import { ReleaseStateBadge } from "@/components/features/releases/ReleaseStateBadge";
import {
  DataCardFold,
  DataTableFold,
  foldKey,
  foldLabel,
  FoldStatus,
  foldedTotal,
  groupsOf,
  useOpenFolds,
} from "@/components/FoldedRows";
import { PlatformIcon, PlatformLabel } from "@/components/PlatformIcon";
import { RelativeTime } from "@/components/RelativeTime";
import { RolloutPercentageBadge } from "@/components/RolloutPercentageBadge";
import { RowReason } from "@/components/RowReason";
import { TargetDisplay } from "@/components/TargetDisplay";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  useBundleChildCountsQuery,
  useBundleChildrenQuery,
  useBundleQuery,
  useChannelsQuery,
  useReleaseFoldQuery,
  useReleasesQuery,
} from "@/lib/api";
import { ALL_CHANNELS, ALL_CHANNELS_LABEL } from "@/lib/constants";
import type { Fold } from "@/lib/server/foldedPage";
import type { ReleaseListRow } from "@/lib/server/releaseReachability";
import { cn } from "@/lib/utils";

import {
  hasReleaseFilters,
  releaseFilterOf,
  resolveReleaseSearch,
  type ReleaseSearch,
  showsDefaultReleases,
  updateReleaseFilters,
  validateReleaseSearch,
} from "./-releases-search";

/** The list while its channel is unknown: loading, whatever the cache holds. */
const PENDING_RELEASES = {
  data: undefined,
  error: null,
  isError: false,
  isPending: true,
  isPlaceholderData: false,
} as const;

/** A fold of unreachable bundles: "1 unreachable bundle", "2 …". */
const UNREACHABLE_BUNDLES = {
  one: "unreachable bundle",
  other: "unreachable bundles",
} as const;
const platformFilterItems = [
  { label: "iOS", value: "ios" },
  { label: "Android", value: "android" },
];
const statusFilterItems = [
  { label: "Any Status", value: "all" },
  { label: "Enabled", value: "enabled" },
  { label: "Disabled", value: "disabled" },
];
export const Route = createFileRoute("/")({
  component: BundlesPage,
  validateSearch: validateReleaseSearch,
});

function BundleFilterToolbar({
  channels,
  clearable,
  onChange,
  onClear,
  onManageChannels,
  pending,
  search,
}: {
  channels: readonly ChannelRow[];
  /** Whether the list shows other than what it opens on. */
  clearable: boolean;
  onChange: (filters: Partial<ReleaseSearch>) => void;
  onClear: () => void;
  onManageChannels: () => void;
  /** Whether the channel the list opens on is still unknown. */
  pending: boolean;
  search: ReleaseSearch;
}) {
  // Releases list by channel and platform together: the index serves that pair.
  const channelSelected = search.channelId !== undefined;
  const channelFilterItems = [
    { label: ALL_CHANNELS_LABEL, value: "all" },
    ...channels.map((channel) => ({
      label: channel.name,
      value: channel.id,
    })),
  ];

  return (
    <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-3 sm:h-12 sm:flex-nowrap sm:bg-card/70 sm:px-4 sm:py-0 sm:backdrop-blur-sm">
      <SidebarTrigger className="-ml-1 size-11 lg:size-7" />
      <h1 className="sr-only">Bundles</h1>
      <div className="ml-1 flex items-center gap-1.5 text-muted-foreground sm:ml-2">
        <Filter className="size-3.5" />
        <span className="text-xs font-medium">Filters</span>
      </div>
      <Select
        disabled={pending}
        items={channelFilterItems}
        onValueChange={(value) =>
          onChange(
            value === null || value === "all"
              ? { channelId: undefined, channels: ALL_CHANNELS }
              : { channelId: value },
          )
        }
        value={pending ? null : (search.channelId ?? "all")}
      >
        <SelectTrigger
          aria-label="Channel"
          className="w-[calc(50%-0.25rem)] min-w-[132px] text-xs data-[size=default]:h-11 sm:w-[140px] sm:data-[size=default]:h-8"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">{ALL_CHANNELS_LABEL}</SelectItem>
            {channels.map((channel) => (
              <SelectItem key={channel.id} value={channel.id}>
                {channel.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select
        disabled={!channelSelected}
        items={platformFilterItems}
        onValueChange={(value) =>
          onChange({ platform: value === "android" ? "android" : "ios" })
        }
        value={search.platform ?? "ios"}
      >
        <SelectTrigger
          aria-label="Platform"
          className="w-[calc(50%-0.25rem)] min-w-[132px] text-xs data-[size=default]:h-11 max-sm:order-2 sm:w-[140px] sm:data-[size=default]:h-8"
          title={channelSelected ? undefined : "Choose a channel first"}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="ios">iOS</SelectItem>
            <SelectItem value="android">Android</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select
        disabled={!channelSelected && search.scopeKey === undefined}
        items={statusFilterItems}
        onValueChange={(value) =>
          onChange({
            enabled:
              value === "enabled"
                ? true
                : value === "disabled"
                  ? false
                  : undefined,
          })
        }
        value={
          search.enabled === undefined
            ? "all"
            : search.enabled
              ? "enabled"
              : "disabled"
        }
      >
        <SelectTrigger
          aria-label="Status"
          className="w-[calc(50%-0.25rem)] min-w-[132px] text-xs data-[size=default]:h-11 max-sm:order-2 sm:w-[140px] sm:data-[size=default]:h-8"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">Any Status</SelectItem>
            <SelectItem value="enabled">Enabled</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <Button
        aria-label="Manage channels"
        className="size-11 max-sm:order-1 sm:size-7"
        onClick={onManageChannels}
        size="icon-sm"
        title="Manage channels"
        variant="outline"
      >
        <Tags />
      </Button>
      {search.bundleId ? (
        <Badge className="max-w-48 gap-1 max-sm:order-3" variant="secondary">
          Artifact filter
          <button
            aria-label="Clear artifact filter"
            className="relative rounded-sm after:absolute after:-inset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:after:hidden"
            onClick={() => onChange({ bundleId: undefined })}
            type="button"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ) : null}
      {search.scopeKey ? (
        <Badge className="max-w-48 gap-1 max-sm:order-3" variant="secondary">
          Target filter
          <button
            aria-label="Clear target filter"
            className="relative rounded-sm after:absolute after:-inset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:after:hidden"
            onClick={() => onChange({ scopeKey: undefined })}
            type="button"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ) : null}
      {clearable ? (
        <Button
          className="h-11 px-2 text-xs text-muted-foreground hover:text-foreground max-sm:order-3 sm:ml-auto sm:h-8"
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
          className="size-11 shrink-0 touch-manipulation sm:size-8"
          onClick={onToggleExpand}
          size="icon"
          type="button"
          variant="ghost"
        >
          {expanded ? <ChevronDown /> : <ChevronRight />}
        </Button>
      ) : (
        <span aria-hidden="true" className="size-11 shrink-0 sm:size-8" />
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
            <RotateCcw className="size-3.5" /> Built-in bundle
          </span>
        ) : null}
      </button>
      {operationLabel ? (
        <Badge className="shrink-0 font-normal" variant="secondary">
          {operationLabel}
        </Badge>
      ) : null}
      {release.currentlyUnreachable ? (
        <RowReason
          icon={CircleOff}
          label="Unreachable: no device gets this bundle with the current delivery settings."
          reason="No device gets this bundle with the current delivery settings."
        >
          Unreachable
        </RowReason>
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

/** What a group of release rows renders with: its own patch counts and feature slots. */
interface RowContext {
  readonly patchCounts: Readonly<Record<string, number | undefined>>;
  readonly slotReleases: readonly {
    readonly releaseId: string;
    readonly platform: "ios" | "android";
    readonly channel: string;
    readonly builtIn: boolean;
  }[];
}

/**
 * The patch counts and feature slots of a group of releases: the page's
 * reachable ones, or one fold's, so opening a fold reads its own rows'
 * and changes no other query.
 */
function useRowContext(
  releases: readonly ReleaseListRow[],
  channels: readonly ChannelRow[],
): RowContext {
  const bundleIds = Array.from(
    new Set(
      releases.flatMap((release) =>
        release.bundle_id ? [release.bundle_id] : [],
      ),
    ),
  );
  const patchCountsQuery = useBundleChildCountsQuery(bundleIds);
  return {
    patchCounts: patchCountsQuery.data ?? {},
    slotReleases: releases.flatMap((release) => {
      const channel = channels.find(
        (item) => item.id === release.channel_id,
      )?.name;
      return channel
        ? [
            {
              releaseId: release.id,
              platform: release.platform,
              channel,
              builtIn: !release.bundle_id,
            },
          ]
        : [];
    }),
  };
}

/** Whether a fold of the page holds `releaseId`: IDs order the list. */
const foldHolds = (fold: Fold, releaseId: string) =>
  releaseId >= fold.to && (fold.from === undefined || releaseId < fold.from);

/**
 * A fold of unreachable bundles, where they sit in the list: closed, the
 * number it holds; open, those bundles in order, subdued, read a chunk at a
 * time once it opens.
 */
function UnreachableBundlesFold({
  fold,
  filter,
  channels,
  columns,
  isMobile,
  open,
  onOpenChange,
  render,
}: {
  readonly fold: Fold;
  readonly filter: ReturnType<typeof releaseFilterOf>;
  readonly channels: readonly ChannelRow[];
  readonly columns: number;
  readonly isMobile: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly render: (release: ReleaseListRow, ctx: RowContext) => ReactNode;
}) {
  const query = useReleaseFoldQuery(
    filter,
    { ...(fold.from === undefined ? {} : { from: fold.from }), to: fold.to },
    open,
  );
  const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
  const ctx = useRowContext(rows, channels);
  const statusColumns = isMobile ? undefined : columns;
  const status = query.isError ? (
    <FoldStatus
      columns={statusColumns}
      label="Unreachable bundles"
      onRetry={() => void query.refetch()}
      state="error"
    />
  ) : query.isPending || query.isFetchingNextPage ? (
    <FoldStatus
      columns={statusColumns}
      label="Loading unreachable bundles"
      state="loading"
    />
  ) : query.hasNextPage ? (
    <FoldStatus
      columns={statusColumns}
      label="Unreachable bundles"
      onMore={() => void query.fetchNextPage()}
      state="more"
    />
  ) : null;
  const props = {
    label: foldLabel(fold, UNREACHABLE_BUNDLES),
    open,
    onOpenChange,
    panelId: `bundle-fold-${fold.to}`,
  };
  return isMobile ? (
    <DataCardFold {...props}>
      {rows.map((release) => render(release, ctx))}
      {status}
    </DataCardFold>
  ) : (
    <DataTableFold {...props} columns={columns}>
      {rows.map((release) => render(release, ctx))}
      {status}
    </DataTableFold>
  );
}

function BundlesPage() {
  const urlSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const isMobile = useIsMobile();
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [expandedReleaseId, setExpandedReleaseId] = useState<string>();
  const folds = useOpenFolds();
  const channelsQuery = useChannelsQuery();
  const channels = channelsQuery.data ?? [];
  // The list the page shows: a URL without a channel opens on the default
  // one, known once the channel list arrives. A loaded list outlives a failed
  // refresh; without one, the default list waits, and nothing reads every
  // channel in its place.
  const channelRows = channelsQuery.data;
  const resolved = resolveReleaseSearch(urlSearch, channelRows);
  const channelsFailed = resolved === undefined && channelsQuery.isError;
  const search = resolved ?? urlSearch;
  const filter = releaseFilterOf(search);
  const releasesQuery = useReleasesQuery(
    {
      afterReleaseId: search.afterReleaseId,
      beforeReleaseId: search.beforeReleaseId,
      filter,
      // The selected release never folds, so a link to it shows its row.
      releaseId: search.releaseId,
    },
    // Nothing reads every channel's list on the way to the default one.
    { enabled: resolved !== undefined },
  );
  const clearable = !showsDefaultReleases(urlSearch, channelRows);
  // Until the channel is known, the list shows nothing the cache holds: a
  // cached page of every channel, or a fold that would read more of it.
  const list = resolved === undefined ? PENDING_RELEASES : releasesQuery;
  const entries = list.data?.entries ?? [];
  // The page's reachable releases (and the selected one), outside its folds.
  const releases = entries.flatMap((entry) =>
    entry.kind === "row" ? [entry.row] : [],
  );
  const pageContext = useRowContext(releases, channels);
  const nextCursor = list.data?.next;
  const previousCursor = list.data?.previous;
  // Features add columns, such as release activity where the console reads it.
  const featureColumns = useReleaseColumns();
  const columnCount = 10 + featureColumns.length;
  const channelNames = new Map(
    channels.map((channel) => [channel.id, channel.name]),
  );

  // A lineage panel shows only with its row: whatever hides the row, a fold
  // closing, a filter, a refetch or Back, closes the panel, and opening the
  // row again opens none.
  const visible = (releaseId: string) =>
    releases.some((release) => release.id === releaseId) ||
    entries.some(
      (entry) =>
        entry.kind === "fold" &&
        folds.isOpen(foldKey(entry)) &&
        foldHolds(entry, releaseId),
    );
  const lineageVisible =
    expandedReleaseId !== undefined && visible(expandedReleaseId);
  useEffect(() => {
    if (expandedReleaseId !== undefined && !lineageVisible) {
      setExpandedReleaseId(undefined);
    }
  }, [expandedReleaseId, lineageVisible]);

  const go = (nextSearch: ReleaseSearch, resetScroll = true) =>
    void navigate({ resetScroll, search: nextSearch, to: "/" });
  const changeFilters = (filters: Partial<ReleaseSearch>) =>
    go(updateReleaseFilters(search, filters));
  // Selecting a bundle in an open fold splits the fold around it: the part
  // under it opens too, so no row moves out of sight.
  const select = (release: ReleaseListRow) => {
    if (!releases.some(({ id }) => id === release.id)) {
      folds.set(release.id, true);
    }
    go({ ...search, releaseId: release.id }, false);
  };
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
  // Pages go by key: newer or older than an edge release, never by number.
  const onLaterPage =
    search.afterReleaseId !== undefined || search.beforeReleaseId !== undefined;
  const previousSearch: ReleaseSearch | null = previousCursor
    ? {
        ...search,
        afterReleaseId:
          "after" in previousCursor ? previousCursor.after : undefined,
        beforeReleaseId:
          "before" in previousCursor ? previousCursor.before : undefined,
        releaseId: undefined,
      }
    : null;
  const nextSearch: ReleaseSearch | null = nextCursor
    ? {
        ...search,
        afterReleaseId: undefined,
        beforeReleaseId: nextCursor,
        releaseId: undefined,
      }
    : null;
  const newestSearch: ReleaseSearch = {
    ...search,
    afterReleaseId: undefined,
    beforeReleaseId: undefined,
    releaseId: undefined,
  };

  const renderCard = (release: ReleaseListRow, ctx: RowContext) => {
    const channelName =
      channelNames.get(release.channel_id) ?? release.channel_id;
    const patchCount = release.bundle_id
      ? ctx.patchCounts[release.bundle_id]
      : 0;
    const isExpanded = lineageVisible && expandedReleaseId === release.id;
    const panelId = `bundle-lineage-panel-${release.id}`;

    return (
      <Fragment key={release.id}>
        {/* The ID button opens it for keyboards and screen
            readers; a tap anywhere else on the card does too. */}
        <DataCard
          aria-label={`Bundle ${release.id}`}
          className={cn(
            "gap-3",
            release.currentlyUnreachable &&
              "bg-muted/60 saturate-50 hover:bg-muted/60 hover:saturate-100 focus-within:saturate-100",
            isExpanded && "border-b-0 bg-primary/5",
          )}
          data-state={search.releaseId === release.id ? "selected" : undefined}
          onClick={openOutsideControls(() => select(release))}
        >
          <div className="flex items-start justify-between gap-3">
            <BundleEntry
              expanded={isExpanded}
              onOpen={() => select(release)}
              onToggleExpand={() =>
                setExpandedReleaseId(isExpanded ? undefined : release.id)
              }
              release={release}
            />
            <ChannelBadge channel={channelName} className="shrink-0" />
          </div>
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5 text-foreground">
              <PlatformIcon className="size-4" platform={release.platform} />
              {release.platform === "ios" ? "iOS" : "Android"}
            </span>
            {patchCount === undefined || patchCount > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {patchCount === undefined
                    ? "Checking patches"
                    : `${patchCount} ${patchCount === 1 ? "patch" : "patches"}`}
                </span>
              </>
            ) : null}
            <span aria-hidden="true">·</span>
            <RelativeTime ms={release.created_at_ms} />
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
            <RolloutPercentageBadge
              percentage={release.rollout_cohort_count / 10}
            />
            <ReleaseStateBadge release={release} />
            {release.should_force_update ? (
              <Badge variant="secondary">Force update</Badge>
            ) : null}
            <span className="flex items-center">
              <span className="sr-only">Target </span>
              <TargetDisplay
                appVersion={release.target_app_version}
                fingerprintHash={release.fingerprint_hash}
              />
            </span>
          </div>
          {featureColumns.map(({ Cell, feature, label }) => (
            <div className="mt-3 text-xs" key={feature}>
              <span className="sr-only">{label}</span>
              <Cell releaseId={release.id} releases={ctx.slotReleases} />
            </div>
          ))}
          {release.message ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {release.message}
            </p>
          ) : null}
        </DataCard>
        {isExpanded && release.bundle_id ? (
          <ReleaseBundleChildrenPanel
            onDetailClick={openChildBundle}
            panelId={panelId}
            release={release}
          />
        ) : null}
      </Fragment>
    );
  };

  const renderRow = (release: ReleaseListRow, ctx: RowContext) => {
    const isExpanded = lineageVisible && expandedReleaseId === release.id;
    const panelId = `bundle-lineage-panel-${release.id}`;

    return (
      <Fragment key={release.id}>
        <DataTableRow
          aria-label={`Open bundle ${release.id}`}
          className={cn(
            release.currentlyUnreachable &&
              "bg-muted/60 saturate-50 hover:bg-muted/60 hover:saturate-100 focus-within:saturate-100",
            isExpanded && "bg-primary/5",
          )}
          data-state={search.releaseId === release.id ? "selected" : undefined}
          onOpen={() => select(release)}
        >
          <TableCell>
            <BundleEntry
              expanded={isExpanded}
              onOpen={() => select(release)}
              onToggleExpand={() =>
                setExpandedReleaseId(isExpanded ? undefined : release.id)
              }
              release={release}
            />
          </TableCell>
          <TableCell>
            <ChannelBadge
              channel={
                channelNames.get(release.channel_id) ?? release.channel_id
              }
            />
          </TableCell>
          <TableCell className="whitespace-nowrap">
            <PlatformLabel platform={release.platform} />
          </TableCell>
          <TableCell>
            {release.bundle_id &&
            ctx.patchCounts[release.bundle_id] === undefined ? (
              <span className="text-sm text-muted-foreground">Checking</span>
            ) : release.bundle_id && ctx.patchCounts[release.bundle_id]! > 0 ? (
              <Badge variant="secondary">
                {ctx.patchCounts[release.bundle_id]}{" "}
                {ctx.patchCounts[release.bundle_id] === 1 ? "patch" : "patches"}
              </Badge>
            ) : (
              <span className="text-muted-foreground">-</span>
            )}
          </TableCell>
          <TableCell>
            <TargetDisplay
              appVersion={release.target_app_version}
              fingerprintHash={release.fingerprint_hash}
            />
          </TableCell>
          <TableCell>
            <span className="flex items-center">
              <EnabledStatusIcon enabled={release.enabled} />
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
                {release.should_force_update ? "Required" : "Optional"}
              </span>
            </span>
          </TableCell>
          <TableCell>
            <RolloutPercentageBadge
              percentage={release.rollout_cohort_count / 10}
            />
          </TableCell>
          {featureColumns.map(({ Cell, feature }) => (
            <TableCell key={feature}>
              <Cell releaseId={release.id} releases={ctx.slotReleases} />
            </TableCell>
          ))}
          <TableCell
            className="text-sm text-muted-foreground"
            title={release.message ?? undefined}
          >
            {release.message || "-"}
          </TableCell>
          <TableCell className="text-xs text-muted-foreground">
            <RelativeTime ms={release.created_at_ms} />
          </TableCell>
        </DataTableRow>
        {isExpanded && release.bundle_id ? (
          <TableRow className="hover:bg-transparent">
            <TableCell className="border-t-0 p-0" colSpan={columnCount}>
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
  };

  const fold = (
    entry: Fold,
    render: (release: ReleaseListRow, ctx: RowContext) => ReactNode,
  ) => (
    <UnreachableBundlesFold
      channels={channels}
      columns={columnCount}
      filter={filter}
      fold={entry}
      isMobile={isMobile}
      key={`fold-${entry.to}`}
      onOpenChange={(open) => folds.set(foldKey(entry), open)}
      open={folds.isOpen(foldKey(entry))}
      render={render}
    />
  );
  // The list it opens on, when that channel has no bundle for the platform.
  const openingTitle = (
    <>
      No {search.platform === "android" ? "Android" : "iOS"} bundles in{" "}
      <span translate="no">
        {channelNames.get(search.channelId ?? "") ?? search.channelId}
      </span>
    </>
  );
  // A page of unreachable bundles alone: one fold under the empty state.
  const foldedOnly = releases.length === 0 && entries.length > 0;
  const empty = (
    <DataTableEmpty
      icon={Package}
      title={
        foldedOnly
          ? "No device gets the bundles here"
          : onLaterPage
            ? "No more bundles"
            : !hasReleaseFilters(search)
              ? "No bundles yet"
              : clearable
                ? "No bundles match these filters"
                : openingTitle
      }
    >
      {onLaterPage ? (
        <Link
          className={buttonVariants({
            className: "mt-1 min-h-11 sm:min-h-8",
            variant: "outline",
          })}
          search={newestSearch}
          to="/"
        >
          Show the newest bundles
        </Link>
      ) : clearable ? (
        <Button
          className="mt-1 min-h-11 sm:min-h-8"
          onClick={() => go({})}
          variant="outline"
        >
          Clear filters
        </Button>
      ) : hasReleaseFilters(search) ? (
        <Button
          className="mt-1 min-h-11 sm:min-h-8"
          onClick={() =>
            changeFilters({ channelId: undefined, channels: ALL_CHANNELS })
          }
          variant="outline"
        >
          Show all channels
        </Button>
      ) : (
        <>
          <p>Deploy one from your app's project:</p>
          <div className="w-full text-left">
            <CopyableText
              label="the deploy command"
              value="npx hot-updater deploy"
              wrap
            />
          </div>
        </>
      )}
    </DataTableEmpty>
  );

  return (
    <div className="flex h-svh min-h-0 min-w-0 flex-col">
      <BundleFilterToolbar
        channels={channels}
        clearable={clearable}
        onChange={changeFilters}
        onClear={() => go({})}
        onManageChannels={() => setChannelsOpen(true)}
        pending={resolved === undefined}
        search={search}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 bg-muted/5 p-3 sm:p-6">
        {channelsFailed ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Channels couldn't be loaded</AlertTitle>
            <AlertDescription>
              Bundles show once the channels load.
            </AlertDescription>
            <AlertAction>
              <Button
                className="min-h-11 sm:min-h-7"
                onClick={() => void channelsQuery.refetch()}
                size="xs"
                variant="outline"
              >
                <RefreshCw data-icon="inline-start" />
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : list.isError ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Bundles could not be loaded</AlertTitle>
            <AlertDescription>{list.error?.message}</AlertDescription>
          </Alert>
        ) : (
          <DataTableFrame>
            {isMobile ? (
              <div className="h-full overflow-y-auto">
                {list.isPending ? (
                  <DataCardSkeletons />
                ) : (
                  <>
                    {releases.length === 0 ? (
                      <DataCardsEmpty>{empty}</DataCardsEmpty>
                    ) : null}
                    {entries.map((entry) =>
                      entry.kind === "row"
                        ? renderCard(entry.row, pageContext)
                        : fold(entry, renderCard),
                    )}
                  </>
                )}
              </div>
            ) : (
              <DataTable
                rowGroups
                header={
                  <>
                    <TableHead>ID</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Platform</TableHead>
                    <TableHead>Patches</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Enabled</TableHead>
                    <TableHead>Force update</TableHead>
                    <TableHead>Rollout</TableHead>
                    {featureColumns.map(({ feature, label }) => (
                      <TableHead key={feature}>{label}</TableHead>
                    ))}
                    <TableHead>Message</TableHead>
                    <TableHead>Created</TableHead>
                  </>
                }
              >
                {list.isPending ? (
                  <DataTableBody>
                    <DataTableSkeletonRows columns={columnCount} />
                  </DataTableBody>
                ) : (
                  <>
                    {releases.length === 0 ? (
                      <DataTableBody>
                        <DataTableFullRow columns={columnCount}>
                          {empty}
                        </DataTableFullRow>
                      </DataTableBody>
                    ) : null}
                    {groupsOf(entries).map((group) =>
                      group.kind === "fold" ? (
                        fold(group.fold, renderRow)
                      ) : (
                        <DataTableBody key={`rows-${group.rows[0]!.id}`}>
                          {group.rows.map((release) =>
                            renderRow(release, pageContext),
                          )}
                        </DataTableBody>
                      ),
                    )}
                  </>
                )}
              </DataTable>
            )}
          </DataTableFrame>
        )}

        {!channelsFailed && !list.isError && !list.isPending ? (
          <DataTablePagination
            count={releases.length}
            folded={{ ...foldedTotal(entries), label: "unreachable" }}
            label="Bundle pagination"
            noun={["bundle", "bundles"]}
            pending={list.isPlaceholderData}
            newest={onLaterPage ? { search: newestSearch, to: "/" } : undefined}
            next={nextSearch ? { search: nextSearch, to: "/" } : undefined}
            previous={
              previousSearch ? { search: previousSearch, to: "/" } : undefined
            }
          />
        ) : null}
      </div>

      <ReleaseEditorSheet
        channels={channels}
        onOpenChange={(open) =>
          !open && go({ ...search, releaseId: undefined }, false)
        }
        onShowScope={(scopeKey) => changeFilters({ scopeKey })}
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
