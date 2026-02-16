#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import ora from "ora";
import chalk from "chalk";
import type { CliOptions, StepResult, ArchReviewOutput, ReviewFinding } from "./types.js";
import {
  parsePrUrl,
  fetchPrMetadata,
  fetchPrDiff,
  cloneAndCheckout,
  checkGhAuth,
  checkCodexInstalled,
  postPrReview,
} from "./github.js";
import { detectProject } from "./detect.js";
import { runInstall, runTests, runLint } from "./runner.js";
import { runCodexReview } from "./review.js";
import { runArchReview } from "./arch-review.js";
import { buildReviewPayload } from "./reporter.js";
import {
  summarizeDescription,
  summarizeTestResults,
  summarizeLintResults,
} from "./summarize.js";
import {
  logInfo,
  logSuccess,
  logError,
  logStep,
  cleanupDir,
} from "./utils.js";

// ── Resolve package metadata ─────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"),
) as { version: string };

// ── CLI definition ───────────────────────────────────────────────────

const program = new Command();

program
  .name("ai-pr-reviewer")
  .description(
    "Review GitHub pull requests using Codex CLI and GitHub CLI. " +
    "Clones the repo, runs tests and linting, performs AI code review, " +
    "and posts inline suggestions plus a summary comment to the PR.",
  )
  .version(pkg.version)
  .argument("<pr-url>", "GitHub pull request URL (e.g. https://github.com/owner/repo/pull/123)")
  .option("--keep", "Keep the cloned repo directory after review", false)
  .option("--skip-tests", "Skip running the test suite", false)
  .option("--skip-lint", "Skip running the linter", false)
  .option("--skip-review", "Skip AI code review (only run tests/lint)", false)
  .option("--skip-arch", "Skip architecture conformance review", false)
  .option("-m, --model <model>", "Codex model to use (e.g. gpt-5.3-codex)")
  .option("-c, --concurrency <n>", "Max parallel Codex calls for batch processing", "3")
  .option("--include-all", "Disable file filtering (review lock files, generated code, etc.)", false)
  .action(async (prUrl: string, opts: CliOptions) => {
    await run(prUrl, opts);
  });

program.parse();

// ── Main orchestration ───────────────────────────────────────────────

async function run(prUrl: string, opts: CliOptions): Promise<void> {
  const startTime = Date.now();

  console.error(
    chalk.bold("\n  PR Reviewer") + chalk.dim("  — AI-powered pull request review\n"),
  );

  // ── Step 0: Prerequisites ──────────────────────────────────────
  const preSpinner = ora("Checking prerequisites...").start();
  try {
    await checkGhAuth();
    if (!opts.skipReview) {
      await checkCodexInstalled();
    }
    preSpinner.succeed("Prerequisites OK");
  } catch (err) {
    preSpinner.fail("Prerequisite check failed");
    logError((err as Error).message);
    process.exit(1);
  }

  // ── Step 1: Parse PR URL ───────────────────────────────────────
  let pr;
  try {
    pr = parsePrUrl(prUrl);
    logInfo(`Reviewing PR #${pr.number} on ${pr.owner}/${pr.repo}`);
  } catch (err) {
    logError((err as Error).message);
    process.exit(1);
  }

  // ── Step 2: Fetch PR metadata ──────────────────────────────────
  const metaSpinner = ora("Fetching PR metadata...").start();
  let meta;
  let diff: string;
  try {
    meta = await fetchPrMetadata(pr);
    diff = await fetchPrDiff(pr);
    metaSpinner.succeed(
      `PR: "${meta.title}" (${meta.files.length} files, ${meta.baseRefName} <- ${meta.headRefName})`,
    );
  } catch (err) {
    metaSpinner.fail("Failed to fetch PR metadata");
    logError((err as Error).message);
    process.exit(1);
  }

  // ── Step 3: Clone and checkout ─────────────────────────────────
  const cloneSpinner = ora("Cloning repository...").start();
  let repoDir: string;
  try {
    repoDir = await cloneAndCheckout(pr);
    cloneSpinner.succeed(`Cloned to ${repoDir}`);
  } catch (err) {
    cloneSpinner.fail("Failed to clone repository");
    logError((err as Error).message);
    process.exit(1);
  }

  try {
    // ── Step 3.5: Summarise PR description ──────────────────────
    if (!opts.skipReview && meta.body) {
      meta.bodySummary = await summarizeDescription(
        meta.body,
        repoDir,
        opts.model,
      );
    }

    // ── Step 4: Detect project type ──────────────────────────────
    logStep("Detecting project type...");
    const config = await detectProject(repoDir);
    logInfo(
      `Project: ${config.type} | install: ${config.installCmd ?? "none"} | ` +
      `test: ${config.testCmd ?? "none"} | lint: ${config.lintCmd ?? "none"}`,
    );

    // ── Step 5: Install dependencies ─────────────────────────────
    const installResult = await runInstall(config, repoDir);
    if (!installResult.success) {
      logError("Dependency installation failed. Continuing with review...");
    }

    // ── Step 6: Run tests ────────────────────────────────────────
    let testResult: StepResult | null = null;
    if (!opts.skipTests) {
      testResult = await runTests(config, repoDir);
    } else {
      logInfo("Skipping tests (--skip-tests)");
    }

    // ── Step 7: Run linter ───────────────────────────────────────
    let lintResult: StepResult | null = null;
    if (!opts.skipLint) {
      lintResult = await runLint(config, repoDir);
    } else {
      logInfo("Skipping linter (--skip-lint)");
    }

    // ── Step 7.5: Summarise test & lint results ─────────────────
    if (!opts.skipReview) {
      if (testResult && testResult.output && testResult.output !== "No test command detected; skipped.") {
        testResult.summarizedOutput = await summarizeTestResults(
          testResult.output,
          repoDir,
          opts.model,
        );
      }
      if (lintResult && lintResult.output && lintResult.output !== "No lint command detected; skipped.") {
        lintResult.summarizedOutput = await summarizeLintResults(
          lintResult.output,
          repoDir,
          opts.model,
        );
      }
    }

    // ── Step 8 & 9: AI Code Review + Architecture Review (parallel) ──
    const concurrency = Math.max(1, parseInt(String(opts.concurrency), 10) || 3);

    const skippedReview = {
      review: {
        summary: "AI review was skipped.",
        findings: [] as ReviewFinding[],
        verdict: "comment" as const,
      },
      excludedFiles: [] as string[],
    };

    const codeReviewPromise = !opts.skipReview
      ? runCodexReview(
          repoDir, pr, meta, diff,
          testResult, lintResult,
          opts.model, concurrency, opts.includeAll,
        )
      : (logInfo("Skipping AI review (--skip-review)"), Promise.resolve(skippedReview));

    const archReviewPromise = (!opts.skipArch && !opts.skipReview)
      ? runArchReview(
          repoDir, pr, meta, diff,
          opts.model, concurrency, opts.includeAll,
        )
      : (opts.skipArch && logInfo("Skipping architecture review (--skip-arch)"),
         Promise.resolve(null as ArchReviewOutput | null));

    const [codeResult, archReview] = await Promise.all([
      codeReviewPromise,
      archReviewPromise,
    ]);

    const review = codeResult.review;
    const excludedFiles = codeResult.excludedFiles;

    // ── Step 10: Build and post review ───────────────────────────
    logStep("Building review payload...");
    const payload = buildReviewPayload(review, meta, diff, testResult, lintResult, archReview, excludedFiles);

    logInfo(
      `Review: ${payload.event} with ${payload.comments.length} inline comments`,
    );

    const postSpinner = ora("Posting review to GitHub...").start();
    try {
      await postPrReview(pr, payload, meta.headRefOid);
      postSpinner.succeed("Review posted to GitHub");
    } catch (err) {
      postSpinner.fail("Failed to post review");
      logError((err as Error).message);
      // Print the payload so the user can see the review
      console.error("\nReview payload (for manual posting):");
      console.log(JSON.stringify(payload, null, 2));
    }

    // ── Done ─────────────────────────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(
      "\n" +
      chalk.green.bold("  Review complete") +
      chalk.dim(` in ${elapsed}s`) +
      "\n" +
      chalk.dim(`  ${pr.url}`) +
      "\n",
    );
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────
    if (opts.keep) {
      logInfo(`Keeping cloned repo at: ${repoDir}`);
    } else {
      // Clean up the parent temp directory (repoDir is <tempDir>/<repo>)
      const parentDir = dirname(repoDir);
      logInfo("Cleaning up temporary files...");
      await cleanupDir(parentDir);
    }
  }
}
