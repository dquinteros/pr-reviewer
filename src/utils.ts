import { execa, type Options as ExecaOptions } from "execa";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import type { CommandResult } from "./types.js";

// ── Logging ──────────────────────────────────────────────────────────

export function logInfo(msg: string): void {
  console.error(chalk.blue("info") + "  " + msg);
}

export function logSuccess(msg: string): void {
  console.error(chalk.green("done") + "  " + msg);
}

export function logWarn(msg: string): void {
  console.error(chalk.yellow("warn") + "  " + msg);
}

export function logError(msg: string): void {
  console.error(chalk.red("fail") + "  " + msg);
}

export function logStep(step: string): void {
  console.error(chalk.cyan("step") + "  " + chalk.bold(step));
}

// ── Shell execution ──────────────────────────────────────────────────

/**
 * Run a shell command and return structured result.
 * Never throws -- returns exitCode and output even on failure.
 * Properly kills timed-out processes (including child trees).
 */
export async function exec(
  command: string,
  args: string[] = [],
  options: ExecaOptions = {},
): Promise<CommandResult> {
  try {
    const result = await execa(command, args, {
      reject: false,
      timeout: 5 * 60 * 1000, // 5 min default timeout
      killSignal: "SIGKILL",  // ensure the process tree is killed on timeout
      ...options,
    });

    const timedOut = (result as unknown as Record<string, unknown>).timedOut === true;

    return {
      stdout: result.stdout?.toString() ?? "",
      stderr: timedOut
        ? `[TIMEOUT] Process killed after ${((options.timeout ?? 5 * 60 * 1000) / 1000).toFixed(0)}s\n${result.stderr?.toString() ?? ""}`
        : result.stderr?.toString() ?? "",
      exitCode: result.exitCode ?? (timedOut ? 124 : 0),
      success: !timedOut && result.exitCode === 0,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // execa throws on timeout when reject is not explicitly false at the right level
    const isTimeout = message.includes("timed out") || message.includes("TIMEOUT");
    return {
      stdout: "",
      stderr: isTimeout
        ? `[TIMEOUT] Process killed: ${message}`
        : message,
      exitCode: isTimeout ? 124 : 1,
      success: false,
    };
  }
}

// ── Temp directory management ────────────────────────────────────────

/**
 * Create a temporary directory for cloning a repository.
 */
export async function createTempDir(prefix = "ai-pr-reviewer-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Remove a directory recursively.
 */
export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ── Truncation helper ────────────────────────────────────────────────

/**
 * Truncate long output to avoid bloating prompts or comments.
 */
// ── Diff parsing ──────────────────────────────────────────────────────

/**
 * Parse a unified diff to extract valid line numbers (in the new file)
 * for each changed file. These are lines within diff hunks where GitHub
 * allows inline review comments.
 */
export function parseDiffValidLines(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let currentFile: string | null = null;
  let newLine = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    // New file in diff: diff --git a/path b/path
    const fileMatch = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!result.has(currentFile)) {
        result.set(currentFile, new Set());
      }
      inHunk = false;
      continue;
    }

    // Hunk header: @@ -old,count +new,count @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      newLine = parseInt(hunkMatch[1], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk || !currentFile) continue;

    const fileLines = result.get(currentFile)!;

    if (line.startsWith("+")) {
      fileLines.add(newLine);
      newLine++;
    } else if (line.startsWith("-")) {
      // Deleted line: no new-file line number, don't advance counter
    } else if (line.startsWith(" ")) {
      // Context line: valid for comments
      fileLines.add(newLine);
      newLine++;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — skip
    } else {
      // Outside hunk content (e.g., between hunks or diff headers)
      inHunk = false;
    }
  }

  return result;
}

// ── Truncation helper ────────────────────────────────────────────────

/**
 * Truncate long output to avoid bloating prompts or comments.
 */
export function truncate(text: string, maxLen = 5000): string {
  if (text.length <= maxLen) return text;
  const half = Math.floor((maxLen - 40) / 2);
  return (
    text.slice(0, half) +
    "\n\n... [truncated " +
    (text.length - maxLen) +
    " chars] ...\n\n" +
    text.slice(-half)
  );
}

// ── Diff splitting ───────────────────────────────────────────────────

/** A single file's portion of a unified diff. */
export interface FileDiff {
  file: string;
  content: string; // includes the "diff --git …" header
}

/**
 * Split a unified diff string into per-file entries.
 * Each entry contains the full diff text for a single file (headers + hunks).
 */
export function splitDiffByFile(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = diff.split("\n");

  let currentFile: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const fileMatch = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (fileMatch) {
      // Flush the previous file
      if (currentFile && currentLines.length > 0) {
        files.push({ file: currentFile, content: currentLines.join("\n") });
      }
      currentFile = fileMatch[1];
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  // Flush last file
  if (currentFile && currentLines.length > 0) {
    files.push({ file: currentFile, content: currentLines.join("\n") });
  }

  return files;
}

/**
 * Group per-file diffs into batches where each batch stays under
 * `maxCharsPerBatch` characters.  Files that are individually larger
 * than the budget are placed in their own solo batch.
 */
export function batchDiffChunks(
  fileDiffs: FileDiff[],
  maxCharsPerBatch = 30_000,
): string[] {
  const batches: string[] = [];
  let currentBatch: string[] = [];
  let currentSize = 0;

  for (const fd of fileDiffs) {
    const entrySize = fd.content.length;

    // If adding this file would exceed the budget, flush current batch first
    if (currentBatch.length > 0 && currentSize + entrySize > maxCharsPerBatch) {
      batches.push(currentBatch.join("\n"));
      currentBatch = [];
      currentSize = 0;
    }

    currentBatch.push(fd.content);
    currentSize += entrySize;

    // If a single file already exceeds the budget, flush it immediately as a solo batch
    if (entrySize > maxCharsPerBatch) {
      batches.push(currentBatch.join("\n"));
      currentBatch = [];
      currentSize = 0;
    }
  }

  // Flush remaining
  if (currentBatch.length > 0) {
    batches.push(currentBatch.join("\n"));
  }

  return batches;
}
