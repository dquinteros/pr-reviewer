import { describe, it, expect } from "vitest";
import { truncate, parseDiffValidLines } from "../src/utils.js";

// ── truncate ──────────────────────────────────────────────────────────

describe("truncate", () => {
  it("returns short text unchanged", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });

  it("returns text at exact limit unchanged", () => {
    const text = "a".repeat(100);
    expect(truncate(text, 100)).toBe(text);
  });

  it("truncates long text with a marker", () => {
    const text = "a".repeat(200);
    const result = truncate(text, 100);
    expect(result.length).toBeLessThan(200);
    expect(result).toContain("[truncated");
  });

  it("preserves start and end of truncated text", () => {
    const text = "START" + "x".repeat(200) + "END";
    const result = truncate(text, 50);
    expect(result).toMatch(/^START/);
    expect(result).toMatch(/END$/);
  });
});

// ── parseDiffValidLines ───────────────────────────────────────────────

describe("parseDiffValidLines", () => {
  it("parses a simple diff with added lines", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index abc1234..def5678 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -10,4 +10,6 @@ function existing() {",
      " context line",
      "+added line 1",
      "+added line 2",
      " context line",
      " context line",
      " context line",
    ].join("\n");

    const result = parseDiffValidLines(diff);
    const lines = result.get("src/foo.ts")!;

    expect(lines).toBeDefined();
    // Context at 10, added at 11 & 12, context at 13, 14, 15
    expect(lines.has(10)).toBe(true);
    expect(lines.has(11)).toBe(true);
    expect(lines.has(12)).toBe(true);
    expect(lines.has(13)).toBe(true);
    expect(lines.has(14)).toBe(true);
    expect(lines.has(15)).toBe(true);
    // Lines outside the hunk should not be valid
    expect(lines.has(9)).toBe(false);
    expect(lines.has(16)).toBe(false);
  });

  it("handles deleted lines correctly (don't advance counter)", () => {
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -5,5 +5,4 @@",
      " context",
      "-deleted line",
      " context",
      " context",
      " context",
    ].join("\n");

    const result = parseDiffValidLines(diff);
    const lines = result.get("file.ts")!;

    // context at 5, deleted doesn't count, context at 6, 7, 8
    expect(lines.has(5)).toBe(true);
    expect(lines.has(6)).toBe(true);
    expect(lines.has(7)).toBe(true);
    expect(lines.has(8)).toBe(true);
    expect(lines.size).toBe(4);
  });

  it("handles multiple files in one diff", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,4 @@",
      " line1",
      "+new line",
      " line2",
      " line3",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -10,2 +10,3 @@",
      " context",
      "+added",
      " context",
    ].join("\n");

    const result = parseDiffValidLines(diff);

    expect(result.has("a.ts")).toBe(true);
    expect(result.has("b.ts")).toBe(true);
    expect(result.get("a.ts")!.has(2)).toBe(true);  // new line
    expect(result.get("b.ts")!.has(11)).toBe(true); // added
  });

  it("handles multiple hunks in one file", () => {
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,4 @@",
      " line1",
      "+added",
      " line2",
      " line3",
      "@@ -20,2 +21,3 @@",
      " context",
      "+added2",
      " context",
    ].join("\n");

    const result = parseDiffValidLines(diff);
    const lines = result.get("file.ts")!;

    // First hunk: 1, 2, 3, 4
    expect(lines.has(1)).toBe(true);
    expect(lines.has(2)).toBe(true);
    expect(lines.has(3)).toBe(true);
    expect(lines.has(4)).toBe(true);
    // Second hunk: 21, 22, 23
    expect(lines.has(21)).toBe(true);
    expect(lines.has(22)).toBe(true);
    expect(lines.has(23)).toBe(true);
    // Between hunks — not valid
    expect(lines.has(10)).toBe(false);
  });

  it("returns empty map for empty diff", () => {
    expect(parseDiffValidLines("").size).toBe(0);
  });

  it("handles 'No newline at end of file' marker", () => {
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,2 +1,3 @@",
      " line1",
      "+added",
      " line2",
      "\\ No newline at end of file",
    ].join("\n");

    const result = parseDiffValidLines(diff);
    const lines = result.get("file.ts")!;

    expect(lines.has(1)).toBe(true);
    expect(lines.has(2)).toBe(true);
    expect(lines.has(3)).toBe(true);
    expect(lines.size).toBe(3);
  });
});
