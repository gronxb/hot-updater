import type { Bundle } from "@hot-updater/core";

export type { Bundle } from "@hot-updater/core";
export type { HotUpdaterAPI } from "../db";

export interface PaginationInfo {
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  currentPage: number;
  totalPages: number;
}

export interface PaginationOptions {
  limit: number;
  offset: number;
}

export interface PaginatedResult {
  data: Bundle[];
  pagination: PaginationInfo;
}
