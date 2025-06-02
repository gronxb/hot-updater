import type { Bundle, PaginationInfo } from "./types";

export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

export interface PaginatedResult {
  data: Bundle[];
  pagination: PaginationInfo;
}

/**
 * Calculate pagination information based on total count, limit, and offset
 */
export function calculatePagination(
  total: number,
  options?: PaginationOptions,
): PaginationInfo {
  const { limit, offset = 0 } = options ?? {};

  if (total === 0) {
    return {
      total: 0,
      hasNextPage: false,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 0,
    };
  }

  const currentPage = Math.floor(offset / (limit || 1)) + 1;
  const totalPages = limit ? Math.ceil(total / limit) : 1;
  const hasNextPage = offset + (limit || 0) < total;
  const hasPreviousPage = offset > 0;

  return {
    total,
    hasNextPage,
    hasPreviousPage,
    currentPage,
    totalPages,
  };
}
