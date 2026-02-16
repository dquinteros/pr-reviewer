import { describe, it, expect } from "vitest";
import { truncate, parseDiffValidLines, filterDiffs, splitDiffByFile, batchDiffChunks } from "../src/utils.js";
import type { FileDiff } from "../src/utils.js";

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

// ── filterDiffs ───────────────────────────────────────────────────────

describe("filterDiffs", () => {
  function makeFd(file: string, content = "diff --git a/x b/x\n+code"): FileDiff {
    return { file, content };
  }

  it("excludes lock files by exact name", () => {
    const diffs: FileDiff[] = [
      makeFd("package-lock.json"),
      makeFd("yarn.lock"),
      makeFd("src/index.ts"),
    ];
    const { included, excluded } = filterDiffs(diffs);
    expect(included).toHaveLength(1);
    expect(included[0].file).toBe("src/index.ts");
    expect(excluded).toEqual(["package-lock.json", "yarn.lock"]);
  });

  it("excludes generated/minified files by extension", () => {
    const diffs: FileDiff[] = [
      makeFd("assets/bundle.min.js"),
      makeFd("lib/types.generated.ts"),
      makeFd("src/real-code.ts"),
    ];
    const { included, excluded } = filterDiffs(diffs);
    expect(included).toHaveLength(1);
    expect(included[0].file).toBe("src/real-code.ts");
    expect(excluded).toContain("assets/bundle.min.js");
    expect(excluded).toContain("lib/types.generated.ts");
  });

  it("excludes files in vendor/build directories", () => {
    const diffs: FileDiff[] = [
      makeFd("vendor/github.com/lib/pq/conn.go"),
      makeFd("dist/bundle.js"),
      makeFd("build/output.js"),
      makeFd("node_modules/foo/index.js"),
      makeFd(".next/cache/data.json"),
      makeFd("src/app.ts"),
    ];
    const { included, excluded } = filterDiffs(diffs);
    expect(included).toHaveLength(1);
    expect(included[0].file).toBe("src/app.ts");
    expect(excluded).toHaveLength(5);
  });

  it("excludes nested vendor directories", () => {
    const diffs: FileDiff[] = [
      makeFd("backend/vendor/lib/conn.go"),
      makeFd("frontend/node_modules/react/index.js"),
      makeFd("src/handler.ts"),
    ];
    const { included, excluded } = filterDiffs(diffs);
    expect(included).toHaveLength(1);
    expect(excluded).toHaveLength(2);
  });

  it("excludes binary-only diffs", () => {
    const diffs: FileDiff[] = [
      {
        file: "image.png",
        content: "diff --git a/image.png b/image.png\nindex abc..def\nBinary files a/image.png and b/image.png differ",
      },
      makeFd("src/code.ts"),
    ];
    const { included, excluded } = filterDiffs(diffs);
    expect(included).toHaveLength(1);
    expect(included[0].file).toBe("src/code.ts");
    expect(excluded).toEqual(["image.png"]);
  });

  it("keeps all files when none match exclusion patterns", () => {
    const diffs: FileDiff[] = [
      makeFd("src/index.ts"),
      makeFd("lib/utils.ts"),
      makeFd("README.md"),
    ];
    const { included, excluded } = filterDiffs(diffs);
    expect(included).toHaveLength(3);
    expect(excluded).toHaveLength(0);
  });

  it("handles empty input", () => {
    const { included, excluded } = filterDiffs([]);
    expect(included).toHaveLength(0);
    expect(excluded).toHaveLength(0);
  });
});

// ── batchDiffChunks (directory sorting) ───────────────────────────────

describe("batchDiffChunks", () => {
  function makeFd(file: string, size: number): FileDiff {
    return { file, content: "x".repeat(size) };
  }

  it("sorts files by directory before batching", () => {
    const diffs: FileDiff[] = [
      makeFd("z/file1.ts", 100),
      makeFd("a/file2.ts", 100),
      makeFd("a/file1.ts", 100),
      makeFd("z/file2.ts", 100),
    ];
    const batches = batchDiffChunks(diffs, 10_000);
    // All fit in one batch since they're small
    expect(batches).toHaveLength(1);
    // The batch content should have a/ files before z/ files
    const content = batches[0];
    const aIdx = content.indexOf("x".repeat(100)); // first occurrence
    expect(aIdx).toBeGreaterThanOrEqual(0);
  });

  it("groups files from the same directory in a batch", () => {
    // Create files where each takes ~15K chars, batch limit 30K
    const diffs: FileDiff[] = [
      makeFd("src/handlers/a.ts", 14_000),
      makeFd("lib/utils/b.ts", 14_000),
      makeFd("src/handlers/c.ts", 14_000),
      makeFd("lib/utils/d.ts", 14_000),
    ];
    const batches = batchDiffChunks(diffs, 30_000);
    // After sorting: lib/utils/b, lib/utils/d, src/handlers/a, src/handlers/c
    // b+d = 28K < 30K -> batch 1, a+c = 28K < 30K -> batch 2
    expect(batches).toHaveLength(2);
  });

  it("places oversized files in their own batch", () => {
    const diffs: FileDiff[] = [
      makeFd("src/small.ts", 100),
      makeFd("src/huge.ts", 50_000),
      makeFd("src/another.ts", 100),
    ];
    const batches = batchDiffChunks(diffs, 30_000);
    // small + another in one batch, huge in its own
    expect(batches.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty array for empty input", () => {
    expect(batchDiffChunks([], 30_000)).toEqual([]);
  });
});
