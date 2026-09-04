import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, MAX_TTL_MS, MIN_POLL_INTERVAL_MS, parseConfig, tokenTtlMs } from "../src/config";

describe("parseConfig", () => {
  test("empty or missing input yields defaults", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
    expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig(null)).toEqual(DEFAULT_CONFIG);
  });

  test("defaults are 5 minute polls, 30s throttle, 3x TTL", () => {
    expect(DEFAULT_CONFIG.pollIntervalMs).toBe(300_000);
    expect(DEFAULT_CONFIG.throttleMs).toBe(30_000);
    expect(DEFAULT_CONFIG.ttlMultiplier).toBe(3);
    expect(tokenTtlMs(DEFAULT_CONFIG)).toBe(900_000);
  });

  test("applies valid overrides", () => {
    const cfg = parseConfig({
      poll_interval_seconds: 120,
      throttle_seconds: 10,
      ttl_multiplier: 2.5,
      host: "gitlab.example.com",
      glab_path: "/usr/local/bin/glab",
      count_unresolved: false,
      debug: true,
    });
    expect(cfg).toEqual({
      pollIntervalMs: 120_000,
      throttleMs: 10_000,
      ttlMultiplier: 2.5,
      host: "gitlab.example.com",
      glabPath: "/usr/local/bin/glab",
      countUnresolved: false,
      debug: true,
    });
    expect(tokenTtlMs(cfg)).toBe(300_000);
  });

  test("rejects malformed values with a warning and keeps defaults", () => {
    const warnings: string[] = [];
    const cfg = parseConfig(
      {
        poll_interval_seconds: "soon",
        throttle_seconds: -5,
        ttl_multiplier: 0.5,
        host: "",
        glab_path: 42,
        count_unresolved: "yes",
        debug: 1,
      },
      (m) => warnings.push(m),
    );
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(7);
  });

  test("clamps too-small poll intervals", () => {
    const warnings: string[] = [];
    const cfg = parseConfig({ poll_interval_seconds: 1 }, (m) => warnings.push(m));
    expect(cfg.pollIntervalMs).toBe(MIN_POLL_INTERVAL_MS);
    expect(warnings).toHaveLength(1);
  });

  test("zero throttle is allowed (disables throttling)", () => {
    expect(parseConfig({ throttle_seconds: 0 }).throttleMs).toBe(0);
  });

  test("non-table documents fall back to defaults", () => {
    const warnings: string[] = [];
    expect(parseConfig([1, 2], (m) => warnings.push(m))).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
  });
});

describe("tokenTtlMs", () => {
  test("stays inside herdr's accepted range", () => {
    expect(tokenTtlMs({ pollIntervalMs: 86_400_000, ttlMultiplier: 3 })).toBe(MAX_TTL_MS);
    expect(tokenTtlMs({ pollIntervalMs: 0, ttlMultiplier: 3 })).toBe(1);
  });
});

describe("loadConfig", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test("missing file → defaults", () => {
    dir = mkdtempSync(join(tmpdir(), "glab-status-cfg-"));
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
  });

  test("reads TOML", () => {
    dir = mkdtempSync(join(tmpdir(), "glab-status-cfg-"));
    writeFileSync(join(dir, "config.toml"), 'poll_interval_seconds = 60\nhost = "gitlab.example.com"\n');
    const cfg = loadConfig(dir);
    expect(cfg.pollIntervalMs).toBe(60_000);
    expect(cfg.host).toBe("gitlab.example.com");
    expect(cfg.throttleMs).toBe(DEFAULT_CONFIG.throttleMs);
  });

  test("invalid TOML → defaults with a warning", () => {
    dir = mkdtempSync(join(tmpdir(), "glab-status-cfg-"));
    writeFileSync(join(dir, "config.toml"), "this is = = not toml\n");
    const warnings: string[] = [];
    expect(loadConfig(dir, (m) => warnings.push(m))).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
  });
});
