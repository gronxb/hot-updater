import type { InsightsEventPageInput } from "@hot-updater/server/plugins/insights";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteInsightsDataRpc,
  type InsightsDeletionResult,
  type InsightsDeletionTarget,
} from "./insights-deletion-rpc";
import {
  DEFAULT_INSIGHTS_RETENTION,
  type InsightsRetentionDays,
} from "./insights-retention";
import {
  findInsightsInstallationsRpc,
  getInsightsInstallationRpc,
  getInsightsRetentionRpc,
  getReportingInstallationsRpc,
  listInsightsEventsRpc,
  listInsightsInstallationEventsRpc,
  type InsightsWindow,
  type InsightsOverviewInput,
  type ReportingInstallations,
} from "./insights-rpc";

export type { InsightsWindow, InsightsOverviewInput, ReportingInstallations };

const STALE_TIME_MS = 30_000;

const queryKeys = {
  reportingInstallations: (input: InsightsOverviewInput) =>
    ["insights", "reporting-installations", input] as const,
  events: (input: InsightsEventPageInput) =>
    ["insights", "events", input] as const,
  installations: (input: {
    readonly cursor?: string;
    readonly identity: string;
    readonly limit: number;
  }) => ["insights", "installations", input] as const,
  installation: (installId: string) =>
    ["insights", "installation", installId] as const,
  installationEvents: (input: {
    readonly beforeReceivedAtMs: number;
    readonly cursor?: string;
    readonly installId: string;
    readonly limit: number;
  }) => ["insights", "installation-events", input] as const,
};

export const useReportingInstallationsQuery = (input: InsightsOverviewInput) =>
  useQuery({
    queryKey: queryKeys.reportingInstallations(input),
    queryFn: () => getReportingInstallationsRpc({ data: input }),
    refetchOnWindowFocus: true,
    staleTime: STALE_TIME_MS,
  });

export const useInsightsEventsQuery = (
  input: InsightsEventPageInput,
  enabled: boolean,
) =>
  useQuery({
    queryKey: queryKeys.events(input),
    queryFn: () => listInsightsEventsRpc({ data: input }),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: STALE_TIME_MS,
  });

export const useInsightsInstallationsQuery = (
  input: {
    readonly cursor?: string;
    readonly identity: string;
    readonly limit: number;
  },
  enabled: boolean,
) =>
  useQuery({
    queryKey: queryKeys.installations(input),
    queryFn: () => findInsightsInstallationsRpc({ data: input }),
    enabled: enabled && input.identity.length > 0,
    staleTime: STALE_TIME_MS,
  });

export const useInsightsInstallationQuery = (
  installId: string,
  enabled: boolean,
) =>
  useQuery({
    queryKey: queryKeys.installation(installId),
    queryFn: () => getInsightsInstallationRpc({ data: { installId } }),
    enabled: enabled && installId.length > 0,
    staleTime: STALE_TIME_MS,
  });

export const useInsightsInstallationEventsQuery = (
  input: {
    readonly beforeReceivedAtMs: number;
    readonly cursor?: string;
    readonly installId: string;
    readonly limit: number;
  },
  enabled: boolean,
) =>
  useQuery({
    queryKey: queryKeys.installationEvents(input),
    queryFn: () => listInsightsInstallationEventsRpc({ data: input }),
    enabled: enabled && input.installId.length > 0,
    refetchOnWindowFocus: true,
    staleTime: STALE_TIME_MS,
  });

/**
 * How long the server keeps Insights rows; the defaults until it answers, or
 * when it does not report them.
 */
export const useInsightsRetention = (): InsightsRetentionDays =>
  useQuery({
    queryKey: ["insights", "retention"],
    queryFn: () => getInsightsRetentionRpc(),
    // A server's periods change only when it restarts.
    staleTime: Infinity,
  }).data ?? DEFAULT_INSIGHTS_RETENTION;

/** Deletion calls one confirmation makes before it stops and asks for another. */
const MAX_DELETION_CALLS = 100;

/**
 * Deletes a target's Insights data: repeats the server's bounded deletion
 * until nothing remains, then refreshes every Insights read.
 */
export const useDeleteInsightsDataMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      target: InsightsDeletionTarget,
    ): Promise<InsightsDeletionResult["deleted"]> => {
      const total = { installations: 0, events: 0 };
      for (let calls = 0; calls < MAX_DELETION_CALLS; calls += 1) {
        const { deleted, complete } = await deleteInsightsDataRpc({
          data: target,
        });
        total.installations += deleted.installations;
        total.events += deleted.events;
        if (complete) return total;
      }
      throw new Error(
        `Deleted ${total.events.toLocaleString()} events so far; some data remains. Delete again to finish.`,
      );
    },
    // Even a failed deletion may have removed rows.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["insights"] }),
  });
};
