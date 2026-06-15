import { describe, it, expect } from 'vitest';
import { clampLimit, buildPageParam, fetchAllPages } from '../src/pagination.js';

describe('clampLimit', () => {
  it('returns default when undefined', () => {
    expect(clampLimit()).toBe(100);
  });

  it('returns default when 0 or negative', () => {
    expect(clampLimit(0)).toBe(100);
    expect(clampLimit(-5)).toBe(100);
  });

  it('clamps values exceeding max', () => {
    expect(clampLimit(200)).toBe(100);
  });

  it('returns valid limit unchanged', () => {
    expect(clampLimit(50)).toBe(50);
    expect(clampLimit(1)).toBe(1);
    expect(clampLimit(100)).toBe(100);
  });
});

describe('buildPageParam', () => {
  it('returns empty string for page 1 or undefined', () => {
    expect(buildPageParam(1)).toBe('');
    expect(buildPageParam(undefined)).toBe('');
  });

  it('returns page param for page > 1', () => {
    expect(buildPageParam(2)).toBe('&page=2');
    expect(buildPageParam(10)).toBe('&page=10');
  });
});

describe('fetchAllPages', () => {
  it('collects items from multiple pages', async () => {
    let callCount = 0;
    const result = await fetchAllPages(async (page) => {
      callCount++;
      if (page === 1) return { items: ['a', 'b'], has_more: true };
      if (page === 2) return { items: ['c'], has_more: false };
      return { items: [], has_more: false };
    });

    expect(result).toEqual(['a', 'b', 'c']);
    expect(callCount).toBe(2);
  });

  it('returns empty array for empty first page', async () => {
    const result = await fetchAllPages(async () => ({
      items: [],
      has_more: false,
    }));

    expect(result).toEqual([]);
  });

  it('stops immediately when has_more is false on the first page (single page)', async () => {
    let callCount = 0;
    const result = await fetchAllPages(async () => {
      callCount++;
      return { items: ['x', 'y', 'z'], has_more: false };
    });

    expect(result).toEqual(['x', 'y', 'z']);
    expect(callCount).toBe(1);
  });

  it('collects items from three pages with sequential data', async () => {
    let callCount = 0;
    const result = await fetchAllPages(async (page) => {
      callCount++;
      if (page === 1) return { items: ['a', 'b'], has_more: true };
      if (page === 2) return { items: ['c', 'd'], has_more: true };
      return { items: ['e'], has_more: false };
    });

    expect(result).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(callCount).toBe(3);
  });

  it('passes incrementing page numbers to the fetcher', async () => {
    const receivedPages: number[] = [];
    await fetchAllPages(async (page) => {
      receivedPages.push(page);
      return { items: [page], has_more: page < 3 };
    });

    expect(receivedPages).toEqual([1, 2, 3]);
  });
});
