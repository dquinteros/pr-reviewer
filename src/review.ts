import { readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type {
  PrInfo,
  PrMetadata,
  StepResult,
  ReviewOutput,
} from "./types.js";
import { exec, logStep, logSuccess, logError, logWarn, truncate } from "./utils.js";

// Path to the schema file (relative to package root, resolved at runtime)
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, "..", "schemas", "review-output.json");

/**
 * Build the review prompt incorporating PR context and step results.
 */
function buildPrompt(
  pr: PrInfo,
  meta: PrMetadata,
  diff: string,
  testResult: StepResult | null,
  lintResult: StepResult | null,
): string {
  const parts: string[] = [];

  parts.push(
    `You are reviewing Pull Request #${pr.number} in ${pr.owner}/${pr.repo}.`,
  );
  parts.push(`Title: ${meta.title}`);
  if (meta.body) {
    parts.push(`Description: ${truncate(meta.body, 2000)}`);
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

  // Include the diff
  parts.push("PR Diff:");
  parts.push("```diff");
  parts.push(truncate(diff, 30000));
  parts.push("```");
  parts.push("");

  // Include test results if available
  if (testResult && testResult.output !== "No test command detected; skipped.") {
    parts.push(`Test results (${testResult.success ? "PASSED" : "FAILED"}):`);
    parts.push("```");
    parts.push(truncate(testResult.output, 3000));
    parts.push("```");
    parts.push("");
  }

  // Include lint results if available
  if (lintResult && lintResult.output !== "No lint command detected; skipped.") {
    parts.push(`Lint results (${lintResult.success ? "PASSED" : "FAILED"}):`);
    parts.push("```");
    parts.push(truncate(lintResult.output, 3000));
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

/**
 * Run Codex AI review on the PR.
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

  const prompt = buildPrompt(pr, meta, diff, testResult, lintResult);

  // Write the result to a temp file
  const outputPath = join(tmpdir(), `pr-review-${pr.number}-${Date.now()}.json`);

  // Build codex exec arguments
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
    timeout: 5 * 60 * 1000, // 5 min timeout for review
  });

  // Combine stdout+stderr for error detection (codex logs to stderr)
  const allOutput = result.stdout + "\n" + result.stderr;

  // Check for auth errors specifically
  if (
    allOutput.includes("refresh_token_reused") ||
    allOutput.includes("Failed to refresh token") ||
    allOutput.includes("401 Unauthorized")
  ) {
    logError("Codex authentication expired. Run `codex logout && codex login` to re-authenticate.");
    return buildFallbackReview(testResult, lintResult);
  }

  // Check for schema errors
  if (allOutput.includes("invalid_json_schema") || allOutput.includes("Invalid schema")) {
    logError("Codex rejected the output schema. Check schemas/review-output.json");
    logError(result.stderr);
    return buildFallbackReview(testResult, lintResult);
  }

  if (!result.success) {
    logError(`Codex review failed: ${result.stderr}`);
    return buildFallbackReview(testResult, lintResult);
  }

  // Read the structured output
  try {
    const raw = await readFile(outputPath, "utf-8");
    const parsed = JSON.parse(raw) as ReviewOutput;

    // Validate basic structure
    if (!parsed.summary || !Array.isArray(parsed.findings) || !parsed.verdict) {
      logWarn("Codex output missing expected fields, using raw text");
      return buildFallbackFromText(result.stdout, testResult, lintResult);
    }

    logSuccess(
      `AI review complete: ${parsed.findings.length} findings, verdict: ${parsed.verdict}`,
    );
    return parsed;
  } catch {
    logWarn("Failed to parse Codex structured output, using raw text");
    return buildFallbackFromText(result.stdout, testResult, lintResult);
  } finally {
    // Clean up temp output file
    await unlink(outputPath).catch(() => {});
  }
}

/**
 * Build a fallback review when Codex fails entirely.
 */
function buildFallbackReview(
  testResult: StepResult | null,
  lintResult: StepResult | null,
): ReviewOutput {
  const parts: string[] = ["AI review could not be completed."];

  if (testResult && !testResult.success) {
    parts.push(`\n**Tests failed:**\n\`\`\`\n${truncate(testResult.output, 2000)}\n\`\`\``);
  }
  if (lintResult && !lintResult.success) {
    parts.push(`\n**Lint issues:**\n\`\`\`\n${truncate(lintResult.output, 2000)}\n\`\`\``);
  }

  return {
    summary: parts.join("\n"),
    findings: [],
    verdict: "comment",
  };
}

/**
 * Build a review from raw Codex text output when structured parsing fails.
 */
function buildFallbackFromText(
  text: string,
  testResult: StepResult | null,
  lintResult: StepResult | null,
): ReviewOutput {
  const parts: string[] = [truncate(text, 4000)];

  if (testResult && !testResult.success) {
    parts.push(`\n**Tests failed:**\n\`\`\`\n${truncate(testResult.output, 2000)}\n\`\`\``);
  }
  if (lintResult && !lintResult.success) {
    parts.push(`\n**Lint issues:**\n\`\`\`\n${truncate(lintResult.output, 2000)}\n\`\`\``);
  }

  return {
    summary: parts.join("\n"),
    findings: [],
    verdict: "comment",
  };
}
