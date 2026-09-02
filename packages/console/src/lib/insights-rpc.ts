import type {
  InsightsInstallationPageInput,
  InsightsPageEventsInput,
  InsightsReportInput,
  InsightsReportPageInput,
} from "@hot-updater/plugin-core";
import {
  readInsightsInstallationPageInput,
  readInsightsPageEventsInput,
  readInsightsReportPageInput,
  readInsightsReportQuery,
} from "@hot-updater/plugin-core/internal";
import { createServerFn } from "@tanstack/react-start";

const readReportInput = (input: InsightsReportInput): InsightsReportInput => {
  const { minAsOfMs, query } = readInsightsReportQuery(input);
  return {
    query,
    ...(minAsOfMs === undefined ? {} : { minAsOfMs }),
  };
};

export const pageInsightsEventsRpc = createServerFn({ method: "GET" })
  .validator((input: InsightsPageEventsInput) =>
    readInsightsPageEventsInput(input),
  )
  .handler(async ({ data }) => {
    const { hotUpdater } = await import("./server/config.server").then(
      ({ prepareConfig }) => prepareConfig(),
    );
    return hotUpdater.pageEvents(data);
  });

export const pageInsightsInstallationsRpc = createServerFn({ method: "GET" })
  .validator((input: InsightsInstallationPageInput) =>
    readInsightsInstallationPageInput(input),
  )
  .handler(async ({ data }) => {
    const { hotUpdater } = await import("./server/config.server").then(
      ({ prepareConfig }) => prepareConfig(),
    );
    return hotUpdater.pageInstallations(data);
  });

export const getInsightsReportRpc = createServerFn({ method: "GET" })
  .validator(readReportInput)
  .handler(async ({ data }) => {
    const { hotUpdater } = await import("./server/config.server").then(
      ({ prepareConfig }) => prepareConfig(),
    );
    return hotUpdater.getReport(data);
  });

export const pageInsightsReportRpc = createServerFn({ method: "GET" })
  .validator((input: InsightsReportPageInput) =>
    readInsightsReportPageInput(input),
  )
  .handler(async ({ data }) => {
    const { hotUpdater } = await import("./server/config.server").then(
      ({ prepareConfig }) => prepareConfig(),
    );
    return hotUpdater.pageReport(data);
  });
