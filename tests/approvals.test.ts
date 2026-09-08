import { describe, expect, test } from "bun:test";
import { parseApprovals } from "../src/approvals";

describe("parseApprovals", () => {
  test("extracts given/required from the approvals payload", () => {
    const json = JSON.stringify({
      approvals_required: 3,
      approved_by: [{ user: { username: "a" } }, { user: { username: "b" } }],
    });
    expect(parseApprovals(json)).toEqual({ given: 2, required: 3 });
  });

  test("zero approvals given is still a valid result, not null", () => {
    expect(parseApprovals(JSON.stringify({ approvals_required: 1, approved_by: [] }))).toEqual({ given: 0, required: 1 });
  });

  test("rejects bad JSON, non-objects, and missing fields", () => {
    expect(parseApprovals("not json")).toBeNull();
    expect(parseApprovals("[]")).toBeNull();
    expect(parseApprovals(JSON.stringify({ message: "404 Not found" }))).toBeNull();
    expect(parseApprovals(JSON.stringify({ approvals_required: 1 }))).toBeNull();
    expect(parseApprovals(JSON.stringify({ approved_by: [] }))).toBeNull();
  });
});
