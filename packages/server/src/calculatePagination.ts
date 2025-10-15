import type { PaginationInfo, PaginationOptions } from "./types";

/**
 * Calculate pagination information based on total count, limit, and offset
 */
export function calculatePagination(
  total: number,
  options: PaginationOptions,
): PaginationInfo {
  const { limit, offset } = options;

  if (total === 0) {
    return {
      total: 0,
      hasNextPage: false,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 0,
    };
  }

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  const hasNextPage = offset + limit < total;
  const hasPreviousPage = offset > 0;

  return {
    total,
    hasNextPage,
    hasPreviousPage,
    currentPage,
    totalPages,
  };
}
