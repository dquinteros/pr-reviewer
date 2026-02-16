import type {
  PrInfo,
  PrMetadata,
  StepResult,
  ReviewOutput,
  ReviewFinding,
  ArchReviewOutput,
  ArchViolation,
  GitHubReviewPayload,
  GitHubReviewComment,
} from "./types.js";
import { truncate, parseDiffValidLines } from "./utils.js";

// ── Severity icons ───────────────────────────────────────────────────

const SEVERITY_ICON: Record<ReviewFinding["severity"], string> = {
  critical: "🔴",
  warning: "🟡",
  suggestion: "🔵",
  nitpick: "⚪",
};

const ARCH_SEVERITY_ICON: Record<ArchViolation["severity"], string> = {
  critical: "🔴",
  warning: "🟡",
  suggestion: "🔵",
};

const ARCH_CATEGORY_LABEL: Record<ArchViolation["category"], string> = {
  layer_violation: "Layer Violation",
  naming_convention: "Naming Convention",
  design_pattern: "Design Pattern",
  circular_dependency: "Circular Dependency",
};

// ── Build inline comment body ────────────────────────────────────────

function buildCommentBody(finding: ReviewFinding): string {
  const parts: string[] = [];

  parts.push(`**${SEVERITY_ICON[finding.severity]} ${finding.severity.toUpperCase()}: ${finding.title}**`);
  parts.push("");
  parts.push(finding.body);

  if (finding.suggestion) {
    parts.push("");
    parts.push("```suggestion");
    parts.push(finding.suggestion);
    parts.push("```");
  }

  return parts.join("\n");
}

// ── Build architecture violation inline comment body ─────────────────

function buildArchViolationCommentBody(violation: ArchViolation): string {
  const parts: string[] = [];

  const icon = ARCH_SEVERITY_ICON[violation.severity];
  const category = ARCH_CATEGORY_LABEL[violation.category];

  parts.push(`**${icon} ARCH ${violation.severity.toUpperCase()}: ${category}**`);
  parts.push("");
  parts.push(`**Rule:** ${violation.rule}`);
  parts.push("");
  parts.push(violation.description);

  if (violation.suggestion) {
    parts.push("");
    parts.push("```suggestion");
    parts.push(violation.suggestion);
    parts.push("```");
  }

  return parts.join("\n");
}

// ── Build summary body ───────────────────────────────────────────────

function buildSummaryBody(
  review: ReviewOutput,
  testResult: StepResult | null,
  lintResult: StepResult | null,
  archReview: ArchReviewOutput | null,
  excludedFiles: string[] = [],
): string {
  const parts: string[] = [];

  parts.push("## PR Review Summary");
  parts.push("");
  parts.push(review.summary);
  parts.push("");

  // Findings overview
  if (review.findings.length > 0) {
    const counts = {
      critical: 0,
      warning: 0,
      suggestion: 0,
      nitpick: 0,
    };
    for (const f of review.findings) {
      counts[f.severity]++;
    }

    parts.push("### Findings");
    parts.push("");
    parts.push("| Severity | Count |");
    parts.push("|----------|-------|");
    if (counts.critical > 0)
      parts.push(`| ${SEVERITY_ICON.critical} Critical | ${counts.critical} |`);
    if (counts.warning > 0)
      parts.push(`| ${SEVERITY_ICON.warning} Warning | ${counts.warning} |`);
    if (counts.suggestion > 0)
      parts.push(`| ${SEVERITY_ICON.suggestion} Suggestion | ${counts.suggestion} |`);
    if (counts.nitpick > 0)
      parts.push(`| ${SEVERITY_ICON.nitpick} Nitpick | ${counts.nitpick} |`);
    parts.push("");
  } else {
    parts.push("No specific code findings.");
    parts.push("");
  }

  // Test results
  if (testResult) {
    const icon = testResult.success ? "✅" : "❌";
    parts.push(`### Tests ${icon}`);
    parts.push("");
    if (testResult.output === "No test command detected; skipped.") {
      parts.push("_No test command detected._");
    } else {
      parts.push(
        testResult.success
          ? `Tests passed in ${(testResult.duration / 1000).toFixed(1)}s.`
          : `Tests **failed** after ${(testResult.duration / 1000).toFixed(1)}s.`,
      );
      if (!testResult.success) {
        parts.push("");
        parts.push("<details><summary>Test output</summary>");
        parts.push("");
        parts.push("```");
        parts.push(truncate(testResult.output, 3000));
        parts.push("```");
        parts.push("");
        parts.push("</details>");
      }
    }
    parts.push("");
  }

  // Lint results
  if (lintResult) {
    const icon = lintResult.success ? "✅" : "⚠️";
    parts.push(`### Linting ${icon}`);
    parts.push("");
    if (lintResult.output === "No lint command detected; skipped.") {
      parts.push("_No lint command detected._");
    } else {
      parts.push(
        lintResult.success
          ? `Linting passed in ${(lintResult.duration / 1000).toFixed(1)}s.`
          : `Linter reported issues after ${(lintResult.duration / 1000).toFixed(1)}s.`,
      );
      if (!lintResult.success) {
        parts.push("");
        parts.push("<details><summary>Lint output</summary>");
        parts.push("");
        parts.push("```");
        parts.push(truncate(lintResult.output, 3000));
        parts.push("```");
        parts.push("");
        parts.push("</details>");
      }
    }
    parts.push("");
  }

  // Architecture conformance
  if (archReview) {
    const scoreDisplay = archReview.conformance_score >= 0
      ? `${archReview.conformance_score}/100`
      : "N/A";
    const scoreIcon = archReview.conformance_score >= 80
      ? "✅"
      : archReview.conformance_score >= 50
        ? "⚠️"
        : archReview.conformance_score >= 0
          ? "❌"
          : "❓";

    parts.push(`### Architecture Conformance ${scoreIcon}`);
    parts.push("");
    parts.push(`**Score:** ${scoreDisplay}`);
    parts.push("");
    parts.push(archReview.summary);
    parts.push("");

    if (archReview.violations.length > 0) {
      // Group violations by category
      const byCategory = new Map<string, ArchViolation[]>();
      for (const v of archReview.violations) {
        const label = ARCH_CATEGORY_LABEL[v.category];
        if (!byCategory.has(label)) {
          byCategory.set(label, []);
        }
        byCategory.get(label)!.push(v);
      }

      parts.push("| Category | Severity | File | Rule |");
      parts.push("|----------|----------|------|------|");
      for (const [category, violations] of byCategory) {
        for (const v of violations) {
          const icon = ARCH_SEVERITY_ICON[v.severity];
          parts.push(
            `| ${category} | ${icon} ${v.severity} | \`${v.file}:${v.line}\` | ${v.rule} |`,
          );
        }
      }
      parts.push("");
    } else {
      parts.push("No architecture violations found.");
      parts.push("");
    }
  }

  // Excluded files note
  if (excludedFiles.length > 0) {
    parts.push("### Excluded Files");
    parts.push("");
    parts.push(
      `${excludedFiles.length} file(s) were excluded from AI review (lock files, generated code, build output, vendor dirs):`,
    );
    parts.push("");
    parts.push("<details><summary>Excluded files</summary>");
    parts.push("");
    for (const f of excludedFiles) {
      parts.push(`- \`${f}\``);
    }
    parts.push("");
    parts.push("</details>");
    parts.push("");
    parts.push("_Use `--include-all` to review these files._");
    parts.push("");
  }

  parts.push("---");
  parts.push("_Review generated by [ai-pr-reviewer](https://www.npmjs.com/package/ai-pr-reviewer) using OpenAI Codex CLI._");

  return parts.join("\n");
}

// ── Map verdict ──────────────────────────────────────────────────────

function mapVerdict(
  verdict: ReviewOutput["verdict"],
): GitHubReviewPayload["event"] {
  switch (verdict) {
    case "approve":
      return "APPROVE";
    case "request_changes":
      return "REQUEST_CHANGES";
    case "comment":
    default:
      return "COMMENT";
  }
}

// ── Build review payload ─────────────────────────────────────────────

/**
 * Build the full GitHub review payload from Codex review output
 * and test/lint results.
 */
export function buildReviewPayload(
  review: ReviewOutput,
  meta: PrMetadata,
  diff: string,
  testResult: StepResult | null,
  lintResult: StepResult | null,
  archReview: ArchReviewOutput | null = null,
  excludedFiles: string[] = [],
): GitHubReviewPayload {
  // Build the summary body
  const body = buildSummaryBody(review, testResult, lintResult, archReview, excludedFiles);

  // Parse diff to determine which lines are within diff hunks
  // (GitHub API rejects review comments on lines outside hunks)
  const validLines = parseDiffValidLines(diff);
  const comments: GitHubReviewComment[] = [];

  // Code review inline comments
  for (const finding of review.findings) {
    // Only add inline comments for files present in the diff
    const fileValidLines = validLines.get(finding.file);
    if (!fileValidLines) {
      continue;
    }

    // Only add comments on lines within a diff hunk
    if (!fileValidLines.has(finding.line)) {
      continue;
    }

    comments.push({
      path: finding.file,
      line: finding.line,
      body: buildCommentBody(finding),
    });
  }

  // Architecture violation inline comments
  if (archReview) {
    for (const violation of archReview.violations) {
      const fileValidLines = validLines.get(violation.file);
      if (!fileValidLines) {
        continue;
      }

      if (!fileValidLines.has(violation.line)) {
        continue;
      }

      comments.push({
        path: violation.file,
        line: violation.line,
        body: buildArchViolationCommentBody(violation),
      });
    }
  }

  return {
    event: mapVerdict(review.verdict),
    body,
    comments,
  };
}
