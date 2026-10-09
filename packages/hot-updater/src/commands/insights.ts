import { p } from "@hot-updater/cli-tools";
import type { HotUpdaterCoreApi } from "@hot-updater/plugin-core";
import {
  type ActiveInstallationWindow,
  createInsightsAdminReads,
  type EventHistoryRow,
  type InsightsApi,
  type InsightsBundleSelection,
  createInsightsReads,
  type InsightsReads,
  type InstallationRow,
} from "@hot-updater/server/plugins/insights";

import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";
import { requirePlugin, withPluginServer } from "./utils/open-server";

/** The console's words for an outcome, and the read's. */
export const INSIGHTS_OUTCOMES = {
  downloaded: "downloaded",
  launched: "applied",
  crashed: "recovered",
  failed: "failed",
} as const satisfies Record<string, InsightsBundleSelection["outcome"]>;

export type InsightsOutcome = keyof typeof INSIGHTS_OUTCOMES;

export const INSIGHTS_WINDOWS = ["24h", "7d", "30d"] as const;

export interface InsightsCommandOptions {
  /** The server definition the command line names, such as `src/hotUpdater.ts`. */
  readonly serverPath?: string;
  readonly json?: boolean;
}

/** Where to read: a bundle's platform and channel, or a channel's. */
export interface InsightsScopeOptions extends InsightsCommandOptions {
  /** The ID shown in the console or by hotUpdater.getBundleId(). */
  readonly bundle?: string;
  readonly platform?: "ios" | "android";
  readonly channel?: string;
  readonly window?: ActiveInstallationWindow;
}

export interface InsightsEventsOptions extends InsightsCommandOptions {
  readonly bundle?: string;
  readonly outcome?: InsightsOutcome;
  readonly install?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface InsightsInstallationsOptions extends InsightsCommandOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

const INSIGHTS = {
  id: "insights",
  call: "insights()",
  importLine: 'import { insights } from "hot-updater/plugins"',
  serverImportLine:
    'import { insights } from "@hot-updater/server/plugins/insights"',
} as const;

/**
 * Runs `run` over Insights: the API of the insights() the server runs, or
 * over standaloneRepository, the server's admin routes.
 */
const withInsights = (
  options: InsightsCommandOptions,
  run: (reads: InsightsReads, core: HotUpdaterCoreApi) => Promise<void>,
): Promise<void> => {
  if (!options.json) printBanner();
  return withPluginServer(options.serverPath, async (server) => {
    requirePlugin(server, INSIGHTS);
    await run(
      server.fetchAdmin === undefined
        ? createInsightsReads(server.api?.[INSIGHTS.id] as InsightsApi)
        : createInsightsAdminReads(server.fetchAdmin, {
            unavailable: () =>
              new Error(
                "The server runs without insights(): its admin API serves no Insights routes. Add insights() to the plugins of createHotUpdater on the server, and deploy it.",
              ),
          }),
      server.core,
    );
  });
};

const printJson = (value: unknown) => {
  console.log(JSON.stringify(value, null, 2));
};

const count = (value: number): string => value.toLocaleString("en");

const dateText = (ms: number): string => new Date(ms).toISOString();

const platformName = (platform: "ios" | "android") =>
  platform === "ios" ? "iOS" : "Android";

interface ResolvedScope {
  readonly platform: "ios" | "android";
  readonly channel: string;
  /** The bundle's release, which update failures key on. */
  readonly releaseId?: string;
  /** The bundle ID devices report, which the other reads key on. */
  readonly bundleId?: string;
}

/** A bundle's platform, channel, and IDs; or the channel `-p` and `-c` name. */
const resolveScope = async (
  core: HotUpdaterCoreApi,
  options: InsightsScopeOptions,
): Promise<ResolvedScope> => {
  if (options.bundle !== undefined) {
    if (options.platform !== undefined || options.channel !== undefined) {
      throw new Error(
        "Pass --bundle, or --platform and --channel, not both: a bundle has its own platform and channel.",
      );
    }
    const release = await core.getRelease(options.bundle);
    if (release === null) {
      throw new Error(`Bundle "${options.bundle}" was not found.`);
    }
    const channel =
      (await core.listChannels()).find(({ id }) => id === release.channel_id)
        ?.name ?? release.channel_id;
    return {
      platform: release.platform,
      channel,
      releaseId: release.id,
      ...(release.bundle_id === null ? {} : { bundleId: release.bundle_id }),
    };
  }
  if (options.platform === undefined || !options.channel?.trim()) {
    throw new Error(
      "Pass --platform and --channel, or --bundle with a bundle's ID.",
    );
  }
  return { platform: options.platform, channel: options.channel.trim() };
};

const requireBundleId = (scope: ResolvedScope, id: string): string => {
  if (scope.bundleId === undefined) {
    throw new Error(
      `Bundle "${id}" rolls back to the built-in bundle, which devices never download, so it has no reports of its own.`,
    );
  }
  return scope.bundleId;
};

const scopeHeading = (
  title: string,
  scope: ResolvedScope,
  window: ActiveInstallationWindow,
) =>
  `${title} · ${platformName(scope.platform)} · ${scope.channel} · last ${window}`;

export const handleInsightsOverview = (
  options: InsightsScopeOptions = {},
): Promise<void> =>
  withInsights(options, async (reads, core) => {
    const scope = await resolveScope(core, options);
    const window = options.window ?? "24h";
    const overview = await reads.getReportingOverview({
      platform: scope.platform,
      channel: scope.channel,
      window,
      ...(options.bundle === undefined
        ? {}
        : { bundleId: requireBundleId(scope, options.bundle) }),
    });
    if (options.json) return printJson(overview);
    const bundle = overview.bundle;
    p.log.message(
      [
        ui.title(scopeHeading("Insights", scope, window)),
        bundle === undefined
          ? ui.table(
              [{ key: "reporting", label: "Reporting installations" }],
              [{ reporting: count(overview.reportingInstallations.count) }],
            )
          : ui.table(
              [
                { key: "reporting", label: "Reporting installations" },
                { key: "onBundle", label: "On the bundle" },
                { key: "downloaded", label: "Downloaded" },
                { key: "launched", label: "Launched" },
                { key: "crashed", label: "Crashed" },
                { key: "failed", label: "Failed" },
              ],
              [
                {
                  reporting: count(overview.reportingInstallations.count),
                  onBundle: count(bundle.reportingInstallations.count),
                  downloaded: count(bundle.downloadedReports.count),
                  launched: count(bundle.appliedReports.count),
                  crashed: count(bundle.recoveredReports.count),
                  failed: count(bundle.failedReports.count),
                },
              ],
            ),
        ui.muted(
          `Since ${dateText(overview.sinceMs)}, until ${dateText(overview.beforeReceivedAtMs)}.`,
        ),
      ].join("\n"),
    );
  });

const HOUR_MS = 3_600_000;
const WINDOW_MS: Readonly<Record<ActiveInstallationWindow, number>> = {
  "24h": 24 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
  "30d": 30 * 24 * HOUR_MS,
};

const rateText = (part: number, whole: number): string =>
  whole === 0 ? "—" : `${((part / whole) * 100).toFixed(2)}%`;

export const handleInsightsFailures = (
  options: InsightsScopeOptions = {},
): Promise<void> =>
  withInsights(options, async (reads, core) => {
    const scope = await resolveScope(core, options);
    const window = options.window ?? "24h";
    // As the console's: a period that ends with the current UTC hour, as
    // the counters keep whole hours.
    const end = Math.ceil(Date.now() / HOUR_MS) * HOUR_MS;
    const timeRange = { start: Math.max(0, end - WINDOW_MS[window]), end };
    const failures = await reads.getUpdateFailures({
      platform: scope.platform,
      channel: scope.channel,
      ...(scope.releaseId === undefined ? {} : { releaseId: scope.releaseId }),
      timeRange,
    });
    if (options.json) {
      return printJson({
        ...failures,
        platform: scope.platform,
        channel: scope.channel,
        ...(scope.releaseId === undefined
          ? {}
          : { releaseId: scope.releaseId }),
        startMs: timeRange.start,
        endMs: timeRange.end,
      });
    }
    const attempts = failures.failedUpdates + failures.downloads;
    const breakdown = failures.breakdown ?? [];
    const coverage = failures.coverage;
    p.log.message(
      [
        ui.title(
          scopeHeading(
            options.bundle === undefined
              ? "Update failures"
              : `Update failures of ${options.bundle}`,
            scope,
            window,
          ),
        ),
        ui.table(
          [
            { key: "rate", label: "Failure rate" },
            { key: "failed", label: "Failed updates" },
            { key: "devices", label: "Affected installations" },
            { key: "downloads", label: "Downloads" },
            { key: "patches", label: "By patch" },
            { key: "fallbacks", label: "Patch fallbacks" },
          ],
          [
            {
              rate: rateText(failures.failedUpdates, attempts),
              failed: `${count(failures.failedUpdates)} of ${count(attempts)}`,
              devices: count(failures.failedInstallations),
              downloads: count(failures.downloads),
              patches: count(failures.patchDownloads),
              fallbacks: count(failures.patchFallbacks),
            },
          ],
        ),
        ...(failures.checks === undefined
          ? []
          : [
              `Update checks: ${rateText(failures.checks.failedInstallations, failures.checks.activeInstallations)} of ${count(failures.checks.activeInstallations)} active installations had a failed check.`,
            ]),
        ...(coverage.kind === "partial"
          ? [
              ui.warning(
                coverage.sinceMs === null
                  ? "Partial: part of the period is past retention."
                  : `Partial: covers only since ${dateText(coverage.sinceMs)}, as older reports are past retention.`,
              ),
            ]
          : []),
        ...(breakdown.length === 0
          ? []
          : [
              ui.table(
                [
                  { key: "stage", label: "Stage" },
                  { key: "reason", label: "Reason" },
                  { key: "events", label: "Failures" },
                ],
                breakdown.map(({ stage, reason, events }) => ({
                  stage,
                  reason,
                  events: count(events),
                })),
              ),
            ]),
      ].join("\n"),
    );
  });

const EVENT_LABELS: Readonly<Record<EventHistoryRow["type"], string>> = {
  UPDATE_DOWNLOADED: "Downloaded",
  UPDATE_APPLIED: "Launched",
  RECOVERED: "Crashed",
  UPDATE_FAILED: "Update failed",
  UNCHANGED: "Launch",
};

const eventDetail = (event: EventHistoryRow): string =>
  event.failure !== undefined
    ? `${event.failure.stage}: ${event.failure.reason}`
    : event.type === "UNCHANGED"
      ? (event.change?.kinds.join(", ") ?? "")
      : "";

const formatEvents = (events: readonly EventHistoryRow[]): string =>
  events.length === 0
    ? ui.muted("(no events)")
    : ui.table(
        [
          { key: "received", label: "Received", format: ui.muted },
          { key: "type", label: "Event" },
          { key: "install", label: "Install", format: ui.id },
          { key: "bundle", label: "Bundle" },
          { key: "app", label: "App" },
          { key: "channel", label: "Channel", format: ui.channel },
          { key: "detail", label: "Detail", format: ui.muted },
        ],
        events.map((event) => ({
          received: dateText(event.receivedAtMs),
          type: EVENT_LABELS[event.type],
          install: event.installId,
          bundle:
            event.fromBundleId === null ||
            event.fromBundleId === event.toBundleId
              ? event.toBundleId
              : `${event.fromBundleId} → ${event.toBundleId}`,
          app: `${platformName(event.platform)} ${event.appVersion}`,
          channel: event.channel,
          detail: eventDetail(event),
        })),
      );

export const handleInsightsEvents = (
  options: InsightsEventsOptions = {},
): Promise<void> =>
  withInsights(options, async (reads, core) => {
    const page = {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    };
    let result;
    if (options.install !== undefined) {
      if (options.bundle !== undefined || options.outcome !== undefined) {
        throw new Error(
          "Pass --install, or --bundle with --outcome, not both.",
        );
      }
      result = await reads.listInstallationEvents({
        installId: options.install,
        ...page,
      });
    } else if (options.bundle !== undefined) {
      if (options.outcome === undefined) {
        throw new Error(
          `Pass --outcome with --bundle: ${Object.keys(INSIGHTS_OUTCOMES).join(", ")}.`,
        );
      }
      const scope = await resolveScope(core, { bundle: options.bundle });
      result = await reads.listEvents({
        bundle: {
          platform: scope.platform,
          channel: scope.channel,
          bundleId: requireBundleId(scope, options.bundle),
          outcome: INSIGHTS_OUTCOMES[options.outcome],
        },
        ...page,
      });
    } else if (options.outcome !== undefined) {
      throw new Error("Pass --bundle with --outcome.");
    } else {
      result = await reads.listEvents(page);
    }
    if (options.json) return printJson(result);
    p.log.message(formatEvents(result.data));
    if (result.nextCursor !== null) {
      p.log.message(
        ui.muted(
          `More events: the same command with --cursor ${result.nextCursor}`,
        ),
      );
    }
  });

const formatInstallations = (rows: readonly InstallationRow[]): string =>
  rows.length === 0
    ? ui.muted("(no installations)")
    : rows
        .map((row) =>
          ui.block(row.installId, [
            ui.kv("User", row.userId),
            ui.kv("App", `${platformName(row.platform)} ${row.appVersion}`),
            ui.kv("Channel", ui.channel(row.channel)),
            ui.kv("Cohort", row.cohort),
            ui.kv("Bundle", ui.id(row.lastKnownBundleId)),
            ui.kv("Pending", ui.id(row.pendingBundleId)),
            ui.kv("Latest", EVENT_LABELS[row.latestStatus]),
            ui.kv("Reported", dateText(row.receivedAtMs)),
          ]),
        )
        .join("\n\n");

export const handleInsightsInstallations = (
  identity: string,
  options: InsightsInstallationsOptions = {},
): Promise<void> =>
  withInsights(options, async (reads) => {
    const limit = options.limit ?? 20;
    // As the console's search: the installation with this ID, then those
    // whose current user it is.
    const install =
      options.cursor === undefined
        ? await reads.getInstallation({ installId: identity })
        : null;
    const matches = await reads.pageInstallationsByCurrentUserId({
      userId: identity,
      limit: Math.max(1, limit - (install === null ? 0 : 1)),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    });
    const result = {
      data:
        install === null
          ? matches.data
          : [
              install,
              ...matches.data.filter(
                ({ installId }) => installId !== install.installId,
              ),
            ],
      nextCursor: matches.nextCursor,
    };
    if (options.json) return printJson(result);
    p.log.message(formatInstallations(result.data));
    if (result.nextCursor !== null) {
      p.log.message(
        ui.muted(`More installations: --cursor ${result.nextCursor}`),
      );
    }
    if (result.data.length > 0) {
      p.log.message(
        ui.muted(
          "An installation's events: hot-updater insights events --install <install-id>",
        ),
      );
    }
  });
