import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSourceVersion, isRecordStale, type PollerRecord } from "../src/poller-control";

// ---------- computeSourceVersion ----------

let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), "glab-status-source-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "bin"));
  return root;
}

describe("computeSourceVersion", () => {
  test("null when the source directories don't exist", () => {
    const missing = join(tmpdir(), "glab-status-does-not-exist");
    expect(computeSourceVersion(missing)).toBeNull();
  });

  test("null when src/bin exist but hold no .ts files", () => {
    const r = makeRoot();
    writeFileSync(join(r, "src", "notes.md"), "hi");
    expect(computeSourceVersion(r)).toBeNull();
  });

  test("is the newest mtime across src/*.ts and bin/*.ts", () => {
    const r = makeRoot();
    writeFileSync(join(r, "src", "a.ts"), "a");
    writeFileSync(join(r, "bin", "b.ts"), "b");
    utimesSync(join(r, "src", "a.ts"), new Date(1_000), new Date(1_000));
    utimesSync(join(r, "bin", "b.ts"), new Date(2_000), new Date(2_000));
    expect(computeSourceVersion(r)).toBe(2_000);
  });

  test("changes when any tracked file is touched", () => {
    const r = makeRoot();
    writeFileSync(join(r, "src", "a.ts"), "a");
    utimesSync(join(r, "src", "a.ts"), new Date(1_000), new Date(1_000));
    const before = computeSourceVersion(r);

    utimesSync(join(r, "src", "a.ts"), new Date(5_000), new Date(5_000));
    const after = computeSourceVersion(r);

    expect(after).not.toBe(before);
    expect(after).toBe(5_000);
  });

  test("ignores non-.ts files, so touching them doesn't move the version", () => {
    const r = makeRoot();
    writeFileSync(join(r, "src", "a.ts"), "a");
    utimesSync(join(r, "src", "a.ts"), new Date(1_000), new Date(1_000));
    const before = computeSourceVersion(r);

    writeFileSync(join(r, "src", "README.md"), "hi");
    utimesSync(join(r, "src", "README.md"), new Date(9_000), new Date(9_000));

    expect(computeSourceVersion(r)).toBe(before);
  });
});

// ---------- isRecordStale ----------

function record(sourceVersion: number | null): PollerRecord {
  return { pid: 1, socketPath: null, startedUnixMs: 0, intervalMs: null, sourceVersion };
}

describe("isRecordStale", () => {
  test("false when the record matches the current source version", () => {
    expect(isRecordStale(record(123), 123)).toBe(false);
  });

  test("true when the record's version differs from the current one", () => {
    expect(isRecordStale(record(123), 456)).toBe(true);
  });

  test("true for a legacy record with no sourceVersion at all", () => {
    expect(isRecordStale(record(null), 456)).toBe(true);
  });

  test("false when the current version could not be computed, even against a legacy record", () => {
    expect(isRecordStale(record(null), null)).toBe(false);
    expect(isRecordStale(record(123), null)).toBe(false);
  });
});
