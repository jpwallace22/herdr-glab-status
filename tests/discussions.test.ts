import { describe, expect, test } from "bun:test";
import {
  countUnresolved,
  countUnresolvedIn,
  isUnresolved,
  parseDiscussionsPage,
  type Discussion,
} from "../src/discussions";

const unresolvedThread: Discussion = {
  id: "a",
  notes: [
    { resolvable: true, resolved: false },
    { resolvable: true, resolved: false },
  ],
};
const resolvedThread: Discussion = { id: "b", notes: [{ resolvable: true, resolved: true }] };
const systemNote: Discussion = { id: "c", notes: [{ resolvable: false }] };
const emptyThread: Discussion = { id: "d", notes: [] };

describe("isUnresolved / countUnresolvedIn", () => {
  test("a thread counts once regardless of how many unresolved notes it has", () => {
    expect(isUnresolved(unresolvedThread)).toBe(true);
    expect(countUnresolvedIn([unresolvedThread])).toBe(1);
  });

  test("resolved, non-resolvable, and empty threads do not count", () => {
    expect(isUnresolved(resolvedThread)).toBe(false);
    expect(isUnresolved(systemNote)).toBe(false);
    expect(isUnresolved(emptyThread)).toBe(false);
    expect(isUnresolved({})).toBe(false);
    expect(countUnresolvedIn([resolvedThread, systemNote, emptyThread])).toBe(0);
  });

  test("malformed notes are ignored", () => {
    expect(isUnresolved({ notes: [null as unknown as { resolvable: boolean }, { resolvable: true, resolved: false }] })).toBe(true);
    expect(isUnresolved({ notes: "nope" as unknown as [] })).toBe(false);
  });
});

function pages(...sizes: number[]): { fetch: (page: number, perPage: number) => Promise<Discussion[]>; calls: number[] } {
  const calls: number[] = [];
  const fetch = async (page: number) => {
    calls.push(page);
    const size = sizes[page - 1] ?? 0;
    return Array.from({ length: size }, () => unresolvedThread);
  };
  return { fetch, calls };
}

describe("countUnresolved pagination", () => {
  test("single short page → one request", async () => {
    const { fetch, calls } = pages(13);
    expect(await countUnresolved(fetch, 100)).toBe(13);
    expect(calls).toEqual([1]);
  });

  test("exactly one full page → fetches the next (empty) page to confirm the end", async () => {
    const { fetch, calls } = pages(100, 0);
    expect(await countUnresolved(fetch, 100)).toBe(100);
    expect(calls).toEqual([1, 2]);
  });

  test("multiple pages are summed", async () => {
    const { fetch, calls } = pages(100, 100, 37);
    expect(await countUnresolved(fetch, 100)).toBe(237);
    expect(calls).toEqual([1, 2, 3]);
  });

  test("empty MR → zero", async () => {
    const { fetch, calls } = pages(0);
    expect(await countUnresolved(fetch, 100)).toBe(0);
    expect(calls).toEqual([1]);
  });

  test("respects the page cap", async () => {
    const { fetch, calls } = pages(2, 2, 2, 2, 2);
    expect(await countUnresolved(fetch, 2, 3)).toBe(6);
    expect(calls).toEqual([1, 2, 3]);
  });

  test("mixed page content counts only unresolved threads", async () => {
    const fetch = async () => [unresolvedThread, resolvedThread, systemNote, unresolvedThread];
    expect(await countUnresolved(fetch, 100)).toBe(2);
  });

  test("fetch errors propagate", async () => {
    const fetch = async () => {
      throw new Error("boom");
    };
    await expect(countUnresolved(fetch, 100)).rejects.toThrow("boom");
  });

  test("non-array pages are an error", async () => {
    const fetch = async () => ({ message: "404" }) as unknown as Discussion[];
    await expect(countUnresolved(fetch, 100)).rejects.toThrow(/not an array/);
  });
});

describe("parseDiscussionsPage", () => {
  test("parses an array", () => {
    expect(parseDiscussionsPage("[]")).toEqual([]);
    expect(parseDiscussionsPage(JSON.stringify([unresolvedThread]))).toHaveLength(1);
  });

  test("rejects non-arrays and bad JSON", () => {
    expect(() => parseDiscussionsPage('{"message":"401 Unauthorized"}')).toThrow(/not an array/);
    expect(() => parseDiscussionsPage("")).toThrow();
  });
});
