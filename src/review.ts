import { readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type {
  PrInfo,
  PrMetadata,
  StepResult,
  ReviewOutput,
  ReviewFinding,
} from "./types.js";
import {
  exec,
  logStep,
  logSuccess,
  logError,
  logWarn,
  logInfo,
  truncate,
  splitDiffByFile,
  batchDiffChunks,
} from "./utils.js";

// Path to the schema file (relative to package root, resolved at runtime)
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, "..", "schemas", "review-output.json");

// ── Verdict severity for merging ─────────────────────────────────────

const VERDICT_SEVERITY: Record<ReviewOutput["verdict"], number> = {
  approve: 0,
  comment: 1,
  request_changes: 2,
};

// ── Prompt builder ───────────────────────────────────────────────────

/**
 * Build the review prompt incorporating PR context and step results.
 *
 * Uses `meta.bodySummary` (AI summary) when available, falling back to
 * truncated raw body.  Uses `stepResult.summarizedOutput` for test/lint
 * when available.  Receives the diff chunk directly (no internal truncation).
 */
function buildPrompt(
  pr: PrInfo,
  meta: PrMetadata,
  diffChunk: string,
  testResult: StepResult | null,
  lintResult: StepResult | null,
  batchInfo?: { current: number; total: number },
): string {
  const parts: string[] = [];

  parts.push(
    `You are reviewing Pull Request #${pr.number} in ${pr.owner}/${pr.repo}.`,
  );

  if (batchInfo && batchInfo.total > 1) {
    parts.push(
      `(Reviewing diff batch ${batchInfo.current} of ${batchInfo.total} — ` +
      `focus only on the files in THIS batch.)`,
    );
  }

  parts.push(`Title: ${meta.title}`);

  // Prefer AI-summarised description, fall back to truncated raw body
  const description = meta.bodySummary ?? (meta.body ? truncate(meta.body, 2000) : "");
  if (description) {
    parts.push(`Description: ${description}`);
  }

  parts.push(
    `Base branch: ${meta.baseRefName}, Head branch: ${meta.headRefName}`,
  );
  parts.push("");

  // Include files changed
  if (meta.files.length > 0) {
    parts.push("Files changed:");
    for (const f of meta.files) {
      parts.push(`  ${f.path} (+${f.additions} -${f.deletions})`);
    }
    parts.push("");
  }

  // Include the diff chunk (no truncation — batching already handles size)
  parts.push("PR Diff:");
  parts.push("```diff");
  parts.push(diffChunk);
  parts.push("```");
  parts.push("");

  // Include test results if available (prefer summary)
  if (testResult && testResult.output !== "No test command detected; skipped.") {
    const testText = testResult.summarizedOutput ?? truncate(testResult.output, 3000);
    parts.push(`Test results (${testResult.success ? "PASSED" : "FAILED"}):`);
    parts.push("```");
    parts.push(testText);
    parts.push("```");
    parts.push("");
  }

  // Include lint results if available (prefer summary)
  if (lintResult && lintResult.output !== "No lint command detected; skipped.") {
    const lintText = lintResult.summarizedOutput ?? truncate(lintResult.output, 3000);
    parts.push(`Lint results (${lintResult.success ? "PASSED" : "FAILED"}):`);
    parts.push("```");
    parts.push(lintText);
    parts.push("```");
    parts.push("");
  }

  parts.push(
    "Review the PR diff thoroughly. Focus on:",
  );
  parts.push("1. Bugs and logic errors");
  parts.push("2. Security vulnerabilities");
  parts.push("3. Performance issues");
  parts.push("4. Code style and readability");
  parts.push("5. Missing error handling");
  parts.push("6. Potential improvements");
  parts.push("");
  parts.push(
    "For each finding, provide the exact file path, line number in the new code, " +
    "severity (critical/warning/suggestion/nitpick), a short title, a detailed body, " +
    "and if possible a concrete code suggestion to fix it.",
  );
  parts.push("");
  parts.push(
    "Set verdict to 'request_changes' if there are critical or warning-level issues, " +
    "'approve' if everything looks good, or 'comment' if there are only minor suggestions.",
  );

  return parts.join("\n");
}

// ── Single-batch review execution ────────────────────────────────────

/**
 * Execute a single Codex review call for one diff batch.
 */
async function reviewBatch(
  repoDir: string,
  prompt: string,
  pr: PrInfo,
  model?: string,
): Promise<ReviewOutput | null> {
  const outputPath = join(tmpdir(), `pr-review-${pr.number}-${Date.now()}.json`);

  const args: string[] = [
    "exec",
    "--yolo",
    "--cd",
    repoDir,
    "--output-schema",
    SCHEMA_PATH,
    "-o",
    outputPath,
  ];

  if (model) {
    args.push("--model", model);
  }

  args.push(prompt);

  const result = await exec("codex", args, {
    timeout: 5 * 60 * 1000,
  });

  const allOutput = result.stdout + "\n" + result.stderr;

  if (
    allOutput.includes("refresh_token_reused") ||
    allOutput.includes("Failed to refresh token") ||
    allOutput.includes("401 Unauthorized")
  ) {
    logError("Codex authentication expired. Run `codex logout && codex login` to re-authenticate.");
    return null;
  }

  if (allOutput.includes("invalid_json_schema") || allOutput.includes("Invalid schema")) {
    logError("Codex rejected the output schema. Check schemas/review-output.json");
    logError(result.stderr);
    return null;
  }

  if (!result.success) {
    logError(`Codex review failed: ${result.stderr}`);
    return null;
  }

  try {
    const raw = await readFile(outputPath, "utf-8");
    const parsed = JSON.parse(raw) as ReviewOutput;

    if (!parsed.summary || !Array.isArray(parsed.findings) || !parsed.verdict) {
      logWarn("Codex output missing expected fields, using raw text");
      return {
        summary: truncate(result.stdout, 4000) || "Review produced no structured output.",
        findings: [],
        verdict: "comment",
      };
    }

    return parsed;
  } catch {
    logWarn("Failed to parse Codex structured output, using raw text");
    return {
      summary: truncate(result.stdout, 4000) || "Review produced no structured output.",
      findings: [],
      verdict: "comment",
    };
  } finally {
    await unlink(outputPath).catch(() => {});
  }
}

// ── Merge batch results ──────────────────────────────────────────────

/**
 * Merge multiple per-batch ReviewOutputs into a single result.
 * Concatenates findings, joins summaries, and picks the most severe verdict.
 */
function mergeReviews(results: ReviewOutput[]): ReviewOutput {
  const allFindings: ReviewFinding[] = [];
  const summaries: string[] = [];
  let worstVerdict: ReviewOutput["verdict"] = "approve";

  for (const r of results) {
    allFindings.push(...r.findings);
    if (r.summary) summaries.push(r.summary);
    if (VERDICT_SEVERITY[r.verdict] > VERDICT_SEVERITY[worstVerdict]) {
      worstVerdict = r.verdict;
    }
  }

  return {
    summary: summaries.join("\n\n"),
    findings: allFindings,
    verdict: worstVerdict,
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Run Codex AI review on the PR.
 *
 * If the diff is small enough it runs a single review call.  For large
 * diffs it splits the diff into per-file batches and reviews each batch
 * separately, then merges the results.
 */
export async function runCodexReview(
  repoDir: string,
  pr: PrInfo,
  meta: PrMetadata,
  diff: string,
  testResult: StepResult | null,
  lintResult: StepResult | null,
  model?: string,
): Promise<ReviewOutput> {
  logStep("Running AI code review with Codex...");

  // Split diff into per-file chunks, then batch to stay within budget
  const fileDiffs = splitDiffByFile(diff);
  const batches = batchDiffChunks(fileDiffs);

  if (batches.length <= 1) {
    // Single batch — fast path
    const prompt = buildPrompt(pr, meta, diff, testResult, lintResult);
    const result = await reviewBatch(repoDir, prompt, pr, model);
    if (result) {
      logSuccess(
        `AI review complete: ${result.findings.length} findings, verdict: ${result.verdict}`,
      );
      return result;
    }
    return buildFallbackReview(testResult, lintResult);
  }

  // Multiple batches
  logInfo(`Diff is large (${fileDiffs.length} files) — splitting into ${batches.length} batches`);

  const batchResults: ReviewOutput[] = [];

  for (let i = 0; i < batches.length; i++) {
    logStep(`Reviewing batch ${i + 1}/${batches.length}...`);
    const prompt = buildPrompt(
      pr, meta, batches[i], testResult, lintResult,
      { current: i + 1, total: batches.length },
    );
    const result = await reviewBatch(repoDir, prompt, pr, model);
    if (result) {
      batchResults.push(result);
    }
  }

  if (batchResults.length === 0) {
    logWarn("All review batches failed — using fallback");
    return buildFallbackReview(testResult, lintResult);
  }

  const merged = mergeReviews(batchResults);
  logSuccess(
    `AI review complete (${batches.length} batches): ` +
    `${merged.findings.length} findings, verdict: ${merged.verdict}`,
  );
  return merged;
}

// ── Fallback builders ────────────────────────────────────────────────

/**
 * Build a fallback review when Codex fails entirely.
 */
function buildFallbackReview(
  testResult: StepResult | null,
  lintResult: StepResult | null,
): ReviewOutput {
  const parts: string[] = ["AI review could not be completed."];

  if (testResult && !testResult.success) {
    const text = testResult.summarizedOutput ?? truncate(testResult.output, 2000);
    parts.push(`\n**Tests failed:**\n\`\`\`\n${text}\n\`\`\``);
  }
  if (lintResult && !lintResult.success) {
    const text = lintResult.summarizedOutput ?? truncate(lintResult.output, 2000);
    parts.push(`\n**Lint issues:**\n\`\`\`\n${text}\n\`\`\``);
  }

  return {
    summary: parts.join("\n"),
    findings: [],
    verdict: "comment",
  };
}
