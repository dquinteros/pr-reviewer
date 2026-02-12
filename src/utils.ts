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
export async function createTempDir(prefix = "pr-reviewer-"): Promise<string> {
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
