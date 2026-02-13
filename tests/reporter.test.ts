import { describe, it, expect } from "vitest";
import { buildReviewPayload } from "../src/reporter.js";
import type { ReviewOutput, PrMetadata } from "../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────────

const mockMeta: PrMetadata = {
  title: "Test PR",
  body: "Test body",
  baseRefName: "main",
  headRefName: "feature",
  headRefOid: "abc123",
  files: [
    { path: "src/foo.ts", additions: 5, deletions: 2 },
    { path: "src/bar.ts", additions: 10, deletions: 0 },
  ],
};

const mockDiff = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,5 @@",
  " line1",
  "+added1",
  "+added2",
  " line2",
  " line3",
  "diff --git a/src/bar.ts b/src/bar.ts",
  "--- a/src/bar.ts",
  "+++ b/src/bar.ts",
  "@@ -10,2 +10,4 @@",
  " context",
  "+new1",
  "+new2",
  " context",
].join("\n");

// ── Tests ─────────────────────────────────────────────────────────────

describe("buildReviewPayload", () => {
  it("builds a payload with valid inline comments", () => {
    const review: ReviewOutput = {
      summary: "Looks good overall",
      findings: [
        {
          file: "src/foo.ts",
          line: 2,
          severity: "warning",
          title: "Possible issue",
          body: "Check this line",
          suggestion: "fix code",
        },
      ],
      verdict: "comment",
    };

    const payload = buildReviewPayload(review, mockMeta, mockDiff, null, null);

    expect(payload.event).toBe("COMMENT");
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].path).toBe("src/foo.ts");
    expect(payload.comments[0].line).toBe(2);
    expect(payload.comments[0].body).toContain("Possible issue");
    expect(payload.comments[0].body).toContain("```suggestion");
  });

  it("filters out findings with lines outside diff hunks", () => {
    const review: ReviewOutput = {
      summary: "Issues found",
      findings: [
        {
          file: "src/foo.ts",
          line: 2,        // valid — within @@ -1,3 +1,5 @@ hunk
          severity: "warning",
          title: "Valid finding",
          body: "In diff",
          suggestion: "",
        },
        {
          file: "src/foo.ts",
          line: 100,      // invalid — not in any hunk
          severity: "critical",
          title: "Invalid finding",
          body: "Not in diff",
          suggestion: "",
        },
      ],
      verdict: "request_changes",
    };

    const payload = buildReviewPayload(review, mockMeta, mockDiff, null, null);

    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].line).toBe(2);
  });

  it("filters out findings for files not in the diff", () => {
    const review: ReviewOutput = {
      summary: "Issues",
      findings: [
        {
          file: "src/unknown.ts",
          line: 5,
          severity: "warning",
          title: "Unknown file",
          body: "Not in PR",
          suggestion: "",
        },
      ],
      verdict: "comment",
    };

    const payload = buildReviewPayload(review, mockMeta, mockDiff, null, null);

    expect(payload.comments).toHaveLength(0);
  });

  it("maps verdicts to GitHub review events correctly", () => {
    const makeReview = (verdict: ReviewOutput["verdict"]): ReviewOutput => ({
      summary: "Test",
      findings: [],
      verdict,
    });

    expect(
      buildReviewPayload(makeReview("approve"), mockMeta, mockDiff, null, null)
        .event,
    ).toBe("APPROVE");

    expect(
      buildReviewPayload(
        makeReview("request_changes"),
        mockMeta,
        mockDiff,
        null,
        null,
      ).event,
    ).toBe("REQUEST_CHANGES");

    expect(
      buildReviewPayload(makeReview("comment"), mockMeta, mockDiff, null, null)
        .event,
    ).toBe("COMMENT");
  });

  it("includes test and lint results in the summary body", () => {
    const review: ReviewOutput = {
      summary: "All good",
      findings: [],
      verdict: "approve",
    };

    const testResult = {
      step: "test" as const,
      success: true,
      output: "All tests passed",
      duration: 1500,
    };

    const lintResult = {
      step: "lint" as const,
      success: false,
      output: "src/foo.ts:10 unused variable",
      duration: 800,
    };

    const payload = buildReviewPayload(
      review,
      mockMeta,
      mockDiff,
      testResult,
      lintResult,
    );

    expect(payload.body).toContain("Tests");
    expect(payload.body).toContain("Linting");
    expect(payload.body).toContain("unused variable");
  });

  it("handles reviews with no findings gracefully", () => {
    const review: ReviewOutput = {
      summary: "LGTM",
      findings: [],
      verdict: "approve",
    };

    const payload = buildReviewPayload(review, mockMeta, mockDiff, null, null);

    expect(payload.event).toBe("APPROVE");
    expect(payload.comments).toHaveLength(0);
    expect(payload.body).toContain("LGTM");
    expect(payload.body).toContain("No specific code findings.");
  });

  it("renders suggestion blocks in comment bodies", () => {
    const review: ReviewOutput = {
      summary: "Fix needed",
      findings: [
        {
          file: "src/bar.ts",
          line: 11,     // within the bar.ts hunk
          severity: "suggestion",
          title: "Use const",
          body: "Prefer const here",
          suggestion: "const x = 1;",
        },
      ],
      verdict: "comment",
    };

    const payload = buildReviewPayload(review, mockMeta, mockDiff, null, null);

    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].body).toContain("```suggestion");
    expect(payload.comments[0].body).toContain("const x = 1;");
  });

  it("does not render suggestion block when suggestion is empty", () => {
    const review: ReviewOutput = {
      summary: "Note",
      findings: [
        {
          file: "src/foo.ts",
          line: 1,
          severity: "nitpick",
          title: "Minor note",
          body: "Just a note",
          suggestion: "",
        },
      ],
      verdict: "comment",
    };

    const payload = buildReviewPayload(review, mockMeta, mockDiff, null, null);

    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].body).not.toContain("```suggestion");
  });
});
