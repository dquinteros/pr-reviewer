import type { ProjectConfig, StepResult } from "./types.js";
import { exec, logStep, logSuccess, logWarn, logError, truncate } from "./utils.js";

/**
 * Environment variables set for all child processes.
 * CI=true prevents test runners (Jest, Vitest, etc.) from entering watch mode.
 * FORCE_COLOR=0 keeps output plain for parsing.
 */
const CI_ENV: Record<string, string> = {
  ...process.env as Record<string, string>,
  CI: "true",
  FORCE_COLOR: "0",
};

/**
 * Run a command described as a single shell string in the given directory.
 * Uses `sh -c` so pipes, redirects, and `||` work.
 */
async function runShellCmd(
  cmd: string,
  cwd: string,
  timeoutMs = 5 * 60 * 1000,
): ReturnType<typeof exec> {
  return exec("sh", ["-c", cmd], { cwd, timeout: timeoutMs, env: CI_ENV });
}

/**
 * Install project dependencies.
 */
export async function runInstall(
  config: ProjectConfig,
  repoDir: string,
): Promise<StepResult> {
  if (!config.installCmd) {
    return {
      step: "install",
      success: true,
      output: "No install command detected; skipped.",
      duration: 0,
    };
  }

  logStep(`Installing dependencies: ${config.installCmd}`);
  const start = Date.now();
  const result = await runShellCmd(config.installCmd, repoDir);
  const duration = Date.now() - start;

  if (result.success) {
    logSuccess(`Dependencies installed in ${(duration / 1000).toFixed(1)}s`);
  } else {
    logError(`Dependency install failed (exit ${result.exitCode})`);
  }

  return {
    step: "install",
    success: result.success,
    output: truncate(result.stdout + "\n" + result.stderr),
    duration,
  };
}

/**
 * Run the project's test suite.
 */
export async function runTests(
  config: ProjectConfig,
  repoDir: string,
): Promise<StepResult> {
  if (!config.testCmd) {
    return {
      step: "test",
      success: true,
      output: "No test command detected; skipped.",
      duration: 0,
    };
  }

  logStep(`Running tests: ${config.testCmd}`);
  const start = Date.now();
  // Tests get a 3-minute timeout (shorter than default) to avoid hanging
  const result = await runShellCmd(config.testCmd, repoDir, 3 * 60 * 1000);
  const duration = Date.now() - start;

  const timedOut = result.stderr.includes("[TIMEOUT]");
  if (timedOut) {
    logWarn(`Tests timed out after ${(duration / 1000).toFixed(1)}s`);
  } else if (result.success) {
    logSuccess(`Tests passed in ${(duration / 1000).toFixed(1)}s`);
  } else {
    logWarn(`Tests failed (exit ${result.exitCode})`);
  }

  return {
    step: "test",
    success: result.success,
    output: truncate(result.stdout + "\n" + result.stderr),
    duration,
  };
}

/**
 * Run the project's linter.
 */
export async function runLint(
  config: ProjectConfig,
  repoDir: string,
): Promise<StepResult> {
  if (!config.lintCmd) {
    return {
      step: "lint",
      success: true,
      output: "No lint command detected; skipped.",
      duration: 0,
    };
  }

  logStep(`Running linter: ${config.lintCmd}`);
  const start = Date.now();
  const result = await runShellCmd(config.lintCmd, repoDir);
  const duration = Date.now() - start;

  if (result.success) {
    logSuccess(`Linting passed in ${(duration / 1000).toFixed(1)}s`);
  } else {
    logWarn(`Linter reported issues (exit ${result.exitCode})`);
  }

  return {
    step: "lint",
    success: result.success,
    output: truncate(result.stdout + "\n" + result.stderr),
    duration,
  };
}
