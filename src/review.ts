import { readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import pLimit from "p-limit";
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
  filterDiffs,
  describeFileGroup,
} from "./utils.js";

// Path to the schema file (relative to package root, resolved at runtime)
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, "..", "schemas", "review-output.json");
const CONSOLIDATION_SCHEMA = resolve(__dirname, "..", "schemas", "summary-consolidation.json");

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
  lang?: string,
): string {
  const parts: string[] = [];

  parts.push(
    `You are reviewing ${pr.label ?? `Pull Request #${pr.number} in ${pr.owner}/${pr.repo}`}.`,
  );

  // Extract filenames from the diff chunk for multi-part reviews
  const batchFiles = diffChunk
    .split("\n")
    .filter((l) => l.startsWith("diff --git"))
    .map((l) => {
      const m = l.match(/^diff --git a\/.+ b\/(.+)$/);
      return m ? m[1] : null;
    })
    .filter(Boolean) as string[];

  if (batchInfo && batchInfo.total > 1) {
    const fileGroupDesc = describeFileGroup(batchFiles);
    parts.push(
      `You are reviewing a subset of the PR changes. ` +
      `This review covers files in: ${fileGroupDesc}. ` +
      `Focus only on these files.`,
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

  // For multi-part reviews, scope the file list to only files in this review
  if (batchInfo && batchInfo.total > 1) {
    parts.push(
      `This PR changes ${meta.files.length} files total. ` +
      `Files included in this review:`,
    );
    for (const f of batchFiles) {
      parts.push(`  ${f}`);
    }
    parts.push("");
  } else if (meta.files.length > 0) {
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

  // Include full test/lint results only for the first review segment
  const isFirstBatch = !batchInfo || batchInfo.current === 1;

  if (testResult && testResult.output !== "No test command detected; skipped.") {
    if (isFirstBatch) {
      const testText = testResult.summarizedOutput ?? truncate(testResult.output, 3000);
      parts.push(`Test results (${testResult.success ? "PASSED" : "FAILED"}):`);
      parts.push("```");
      parts.push(testText);
      parts.push("```");
      parts.push("");
    } else {
      parts.push(`Tests: ${testResult.success ? "PASSED" : "FAILED"} (full output provided in a separate review segment)`);
      parts.push("");
    }
  }

  if (lintResult && lintResult.output !== "No lint command detected; skipped.") {
    if (isFirstBatch) {
      const lintText = lintResult.summarizedOutput ?? truncate(lintResult.output, 3000);
      parts.push(`Lint results (${lintResult.success ? "PASSED" : "FAILED"}):`);
      parts.push("```");
      parts.push(lintText);
      parts.push("```");
      parts.push("");
    } else {
      parts.push(`Linting: ${lintResult.success ? "PASSED" : "FAILED"} (full output provided in a separate review segment)`);
      parts.push("");
    }
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
  parts.push("");
  parts.push(
    "IMPORTANT: Write your summary and findings as if reviewing the entire PR. " +
    "Do NOT reference \"batches\", \"segments\", \"chunks\", or any internal processing details. " +
    "When referring to groups of changes, use specific file paths, folder names, " +
    "or the business/domain concepts they relate to (e.g., \"the authentication module\", " +
    "\"changes in src/api/\").",
  );

  if (lang) {
    parts.push("");
    parts.push(
      `IMPORTANT: Write ALL of your output (summary, finding titles, finding bodies, ` +
      `and suggestions) in ${lang}.`,
    );
  }

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
  const tag = pr.label ? "local" : String(pr.number);
  const outputPath = join(tmpdir(), `pr-review-${tag}-${Date.now()}.json`);

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

// ── Summary consolidation ────────────────────────────────────────

/**
 * Consolidate multiple per-segment summaries into a single cohesive
 * summary that references files, folders, and business concepts instead
 * of internal processing details.
 *
 * Falls back to the raw joined summaries if the consolidation call fails.
 */
async function consolidateSummaries(
  rawSummary: string,
  repoDir: string,
  pr: PrInfo,
  model?: string,
  lang?: string,
): Promise<string> {
  const langInstruction = lang
    ? `\nIMPORTANT: Write the consolidated summary in ${lang}.\n`
    : "";

  const prompt =
    "Consolidate the following per-section review summaries into a single " +
    "cohesive PR review summary. Reference specific files, folders, and " +
    "business/domain concepts the developer would recognize.\n" +
    "Do NOT mention \"batches\", \"segments\", \"chunks\", or any internal " +
    "processing details.\n" +
    "Return a concise summary (max 2000 characters).\n" +
    langInstruction +
    "\n---\n" +
    rawSummary +
    "\n---";

  const cTag = pr.label ? "local" : String(pr.number);
  const outputPath = join(tmpdir(), `pr-consolidate-${cTag}-${Date.now()}.json`);

  const args: string[] = [
    "exec",
    "--yolo",
    "--cd",
    repoDir,
    "--output-schema",
    CONSOLIDATION_SCHEMA,
    "-o",
    outputPath,
  ];

  if (model) {
    args.push("--model", model);
  }

  args.push(prompt);

  try {
    const result = await exec("codex", args, { timeout: 60 * 1000 });

    if (!result.success) {
      logWarn("Summary consolidation failed, using raw summaries");
      return rawSummary;
    }

    const raw = await readFile(outputPath, "utf-8");
    const parsed = JSON.parse(raw) as { summary: string };

    if (parsed.summary && parsed.summary.length > 0) {
      return parsed.summary;
    }

    return rawSummary;
  } catch {
    logWarn("Summary consolidation failed, using raw summaries");
    return rawSummary;
  } finally {
    await unlink(outputPath).catch(() => {});
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Run Codex AI review on the PR.
 *
 * If the diff is small enough it runs a single review call.  For large
 * diffs it splits the diff into per-file batches and reviews each batch
 * in parallel (up to `concurrency` at a time), then merges the results.
 *
 * Non-reviewable files (lock files, generated code, build output, vendor
 * dirs) are filtered out unless `includeAll` is set.
 */
export async function runCodexReview(
  repoDir: string,
  pr: PrInfo,
  meta: PrMetadata,
  diff: string,
  testResult: StepResult | null,
  lintResult: StepResult | null,
  model?: string,
  concurrency = 3,
  includeAll = false,
  lang?: string,
): Promise<{ review: ReviewOutput; excludedFiles: string[] }> {
  logStep("Running AI code review with Codex...");

  // Split diff into per-file chunks and optionally filter
  const allFileDiffs = splitDiffByFile(diff);

  let fileDiffs = allFileDiffs;
  let excludedFiles: string[] = [];

  if (!includeAll) {
    const filtered = filterDiffs(allFileDiffs);
    fileDiffs = filtered.included;
    excludedFiles = filtered.excluded;

    if (excludedFiles.length > 0) {
      logInfo(
        `Filtered ${excludedFiles.length} non-reviewable file(s): ` +
        `${excludedFiles.slice(0, 5).join(", ")}` +
        (excludedFiles.length > 5 ? ` and ${excludedFiles.length - 5} more` : ""),
      );
    }
  }

  const batches = batchDiffChunks(fileDiffs);

  if (batches.length <= 1) {
    // Single batch — fast path
    const diffText = fileDiffs.length > 0 ? batches[0] ?? "" : "";
    const prompt = buildPrompt(pr, meta, diffText, testResult, lintResult, undefined, lang);
    const result = await reviewBatch(repoDir, prompt, pr, model);
    if (result) {
      logSuccess(
        `AI review complete: ${result.findings.length} findings, verdict: ${result.verdict}`,
      );
      return { review: result, excludedFiles };
    }
    return { review: buildFallbackReview(testResult, lintResult), excludedFiles };
  }

  // Multiple batches — process in parallel
  logInfo(
    `Diff is large (${fileDiffs.length} files) — splitting into ${batches.length} batches ` +
    `(concurrency: ${concurrency})`,
  );

  const limit = pLimit(concurrency);

  const tasks = batches.map((batch, i) =>
    limit(async () => {
      logStep(`Reviewing batch ${i + 1}/${batches.length}...`);
      const prompt = buildPrompt(
        pr, meta, batch, testResult, lintResult,
        { current: i + 1, total: batches.length },
        lang,
      );
      return reviewBatch(repoDir, prompt, pr, model);
    }),
  );

  const settled = await Promise.allSettled(tasks);

  const batchResults: ReviewOutput[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value) {
      batchResults.push(result.value);
    }
  }

  if (batchResults.length === 0) {
    logWarn("All review batches failed — using fallback");
    return { review: buildFallbackReview(testResult, lintResult), excludedFiles };
  }

  const merged = mergeReviews(batchResults);

  // Consolidate per-segment summaries into a single developer-friendly summary
  if (batchResults.length > 1) {
    logStep("Consolidating review summaries...");
    merged.summary = await consolidateSummaries(merged.summary, repoDir, pr, model, lang);
  }

  logSuccess(
    `AI review complete (${batches.length} batches): ` +
    `${merged.findings.length} findings, verdict: ${merged.verdict}`,
  );
  return { review: merged, excludedFiles };
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
