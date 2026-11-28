import type { ReportingOverview } from "./domain";

/**
 * The HTTP API calls a release ID `bundleId`, the word users have for it, in
 * its query parameters and its overview's JSON. The code calls it
 * `releaseId`; only this module maps between the two names.
 */
export const RELEASE_ID_PARAM = "bundleId";

type OverviewBundle = NonNullable<ReportingOverview["bundle"]>;

/** A reporting overview as the HTTP API sends it. */
export type WireReportingOverview = Omit<ReportingOverview, "bundle"> & {
  readonly bundle?: Omit<OverviewBundle, "releaseId"> & {
    readonly bundleId: string;
  };
};

/** An overview as the HTTP API and the CLI's `--json` send it. */
export const toWireOverview = ({
  bundle,
  ...overview
}: ReportingOverview): WireReportingOverview => {
  if (bundle === undefined) return overview;
  const { releaseId, ...counts } = bundle;
  // oxlint-disable-next-line hot-updater/id-naming -- wire name: the HTTP API calls a release ID bundleId
  return { ...overview, bundle: { ...counts, bundleId: releaseId } };
};

export const fromWireOverview = ({
  bundle,
  ...overview
}: WireReportingOverview): ReportingOverview => {
  if (bundle === undefined) return overview;
  // oxlint-disable-next-line hot-updater/id-naming -- wire name: the HTTP API calls a release ID bundleId
  const { bundleId: releaseId, ...counts } = bundle;
  return { ...overview, bundle: { ...counts, releaseId } };
};
