export const tables = {
  state: "private_hot_updater_kysely_insights_state",
  events: "private_hot_updater_kysely_insights_events",
  live: "private_hot_updater_kysely_insights_live",
  liveVersions: "private_hot_updater_kysely_insights_live_versions",
  aliases: "private_hot_updater_kysely_insights_aliases",
  searchHeads: "private_hot_updater_kysely_insights_search_heads",
  searchJobs: "private_hot_updater_kysely_insights_search_jobs",
  searchRows: "private_hot_updater_kysely_insights_search_rows",
  reportHeads: "private_hot_updater_kysely_insights_report_heads",
  reportJobs: "private_hot_updater_kysely_insights_report_jobs",
  reportMembers: "private_hot_updater_kysely_insights_report_members",
  reportLatest: "private_hot_updater_kysely_insights_report_latest",
  reportCounts: "private_hot_updater_kysely_insights_report_counts",
  reportOrder: "private_hot_updater_kysely_insights_report_order",
  reportPageTotals: "private_hot_updater_kysely_insights_report_page_totals",
} as const;

export const KYSELY_INSIGHTS_LAYOUT_REVISION = 4;
export const KYSELY_INSIGHTS_ORDER_REVISION = 1;
/** 160 maximum 20 KiB rows leave room below the 4 MiB step ceiling. */
export const KYSELY_INSIGHTS_WORK_ROWS = 160;
export const KYSELY_INSIGHTS_ALIAS_WORK_ROWS = 128;
/** One active installation can carry an overall row plus 30 bucket rows. */
export const KYSELY_INSIGHTS_INSTALLATION_WORK_ROWS = 5;
