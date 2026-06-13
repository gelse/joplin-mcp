import type { PaginatedResponse, Pagination } from "./api-types.js";

const MAX_LIMIT = 100;

export function clampLimit(limit?: number): number {
  if (limit === undefined || limit <= 0) return MAX_LIMIT;
  if (limit > MAX_LIMIT) return MAX_LIMIT;
  return Math.floor(limit);
}

export function buildPageParam(page?: number): string {
  return page !== undefined && page > 1 ? `&page=${page}` : "";
}

export async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<PaginatedResponse<T>>
): Promise<T[]> {
  const allItems: T[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await fetchPage(page);
    allItems.push(...response.items);
    hasMore = response.has_more;
    page++;
  }

  return allItems;
}
