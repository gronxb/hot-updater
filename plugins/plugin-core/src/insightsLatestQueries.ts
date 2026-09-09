import type {
  InsightsCountLatestEventsInput,
  InsightsFindLatestEventsInput,
} from "./types";
import type { DatabaseWhere } from "./types/internal";

/** Internal query translation for the bundled CRUD adapters. */
export const latestInsightsWhere = (
  input:
    | InsightsFindLatestEventsInput
    | (Omit<InsightsCountLatestEventsInput, "bundle"> & {
        bundle?: NonNullable<InsightsCountLatestEventsInput["bundle"]>[number];
      }),
): readonly DatabaseWhere<"bundle_events">[] => {
  if ("installId" in input)
    return [{ field: "install_id", value: input.installId }];
  if ("userId" in input)
    return [
      { field: "user_id", value: input.userId },
      ...(input.afterInstallId === undefined
        ? []
        : [
            {
              field: "install_id" as const,
              operator: "gt" as const,
              value: input.afterInstallId,
            },
          ]),
    ];
  return [
    { field: "platform", value: input.platform },
    { field: "channel", value: input.channel },
    { field: "received_at_ms", operator: "gte", value: input.sinceMs },
    ...(input.bundle === undefined
      ? []
      : [
          input.bundle.field === "from_bundle_id"
            ? { field: "from_bundle_id" as const, value: input.bundle.value }
            : { field: "to_bundle_id" as const, value: input.bundle.value },
          {
            field: "type" as const,
            operator: "in" as const,
            value: input.bundle.types,
          },
        ]),
  ];
};

/** OR groups for one latest-event count; an installation is counted once. */
export const latestInsightsCountGroups = (
  input: InsightsCountLatestEventsInput,
): readonly (readonly DatabaseWhere<"bundle_events">[])[] =>
  input.bundle === undefined
    ? [latestInsightsWhere({ ...input, bundle: undefined })]
    : input.bundle.map((bundle) => latestInsightsWhere({ ...input, bundle }));
