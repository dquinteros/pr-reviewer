import { exec, logStep, logSuccess, logWarn, truncate } from "./utils.js";

// ── Thresholds ───────────────────────────────────────────────────────
// If the input is shorter than these limits we skip summarisation and
// pass the raw text directly — the overhead of an extra AI call is not
// worth it for small inputs.

const DESC_SKIP_THRESHOLD = 500;     // chars
const RESULT_SKIP_THRESHOLD = 1_000; // chars

// Maximum input we send to the summariser (avoid blowing up the prompt).
const DESC_INPUT_CAP = 10_000;
const RESULT_INPUT_CAP = 20_000;

// Timeout for each summarisation call (these should be fast).
const SUMMARISE_TIMEOUT = 60_000; // 60 s

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Run a lightweight `codex exec` call that returns plain text (no schema).
 * Falls back to `null` on any failure so the caller can use the raw text.
 */
async function codexSummarise(
  prompt: string,
  repoDir: string,
  model?: string,
): Promise<string | null> {
  const args: string[] = [
    "exec",
    "--yolo",
    "--cd",
    repoDir,
  ];

  if (model) {
    args.push("--model", model);
  }

  args.push(prompt);

  const result = await exec("codex", args, {
    timeout: SUMMARISE_TIMEOUT,
  });

  // Auth / hard failures → fall back
  const all = result.stdout + "\n" + result.stderr;
  if (
    all.includes("refresh_token_reused") ||
    all.includes("Failed to refresh token") ||
    all.includes("401 Unauthorized") ||
    !result.success
  ) {
    return null;
  }

  const text = result.stdout.trim();
  return text.length > 0 ? text : null;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Summarise the PR description into a concise intent statement.
 * Returns the original body unchanged if it is short enough.
 */
export async function summarizeDescription(
  body: string,
  repoDir: string,
  model?: string,
  lang?: string,
): Promise<string> {
  if (!body || body.length <= DESC_SKIP_THRESHOLD) {
    return body;
  }

  logStep("Summarising PR description...");

  const capped = truncate(body, DESC_INPUT_CAP);

  const langLine = lang ? `Write the summary in ${lang}.` : "";

  const prompt = [
    "Summarise the following Pull Request description into a concise paragraph (max 500 characters).",
    "Focus on: what the PR changes, why, and any key design decisions mentioned.",
    "Return ONLY the summary text, no extra commentary.",
    langLine,
    "",
    "---",
    capped,
    "---",
  ].filter(Boolean).join("\n");

  const summary = await codexSummarise(prompt, repoDir, model);

  if (summary) {
    logSuccess("PR description summarised");
    return summary;
  }

  logWarn("Description summarisation failed — using truncated raw text");
  return truncate(body, 2000);
}

/**
 * Summarise test output into actionable findings.
 * Returns the original output unchanged if it is short enough.
 */
export async function summarizeTestResults(
  output: string,
  repoDir: string,
  model?: string,
  lang?: string,
): Promise<string> {
  if (!output || output.length <= RESULT_SKIP_THRESHOLD) {
    return output;
  }

  logStep("Summarising test results...");

  const capped = truncate(output, RESULT_INPUT_CAP);

  const langLine = lang ? `Write the summary in ${lang}.` : "";

  const prompt = [
    "Summarise the following test-runner output into a concise report (max 1000 characters).",
    "Include: total tests run, number passed/failed/skipped,",
    "and for each failure: test name, error message, and relevant stack-trace line.",
    "Return ONLY the summary text, no extra commentary.",
    langLine,
    "",
    "---",
    capped,
    "---",
  ].filter(Boolean).join("\n");

  const summary = await codexSummarise(prompt, repoDir, model);

  if (summary) {
    logSuccess("Test results summarised");
    return summary;
  }

  logWarn("Test result summarisation failed — using truncated raw text");
  return truncate(output, 3000);
}

/**
 * Summarise linter output into a grouped error/warning report.
 * Returns the original output unchanged if it is short enough.
 */
export async function summarizeLintResults(
  output: string,
  repoDir: string,
  model?: string,
  lang?: string,
): Promise<string> {
  if (!output || output.length <= RESULT_SKIP_THRESHOLD) {
    return output;
  }

  logStep("Summarising lint results...");

  const capped = truncate(output, RESULT_INPUT_CAP);

  const langLine = lang ? `Write the summary in ${lang}.` : "";

  const prompt = [
    "Summarise the following linter output into a concise report (max 1000 characters).",
    "Group errors and warnings by file, include rule names and counts.",
    "Highlight the most critical issues first.",
    "Return ONLY the summary text, no extra commentary.",
    langLine,
    "",
    "---",
    capped,
    "---",
  ].filter(Boolean).join("\n");

  const summary = await codexSummarise(prompt, repoDir, model);

  if (summary) {
    logSuccess("Lint results summarised");
    return summary;
  }

  logWarn("Lint result summarisation failed — using truncated raw text");
  return truncate(output, 3000);
}
