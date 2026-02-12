import { join } from "node:path";
import type {
  PrInfo,
  PrMetadata,
  PrFile,
  GitHubReviewPayload,
} from "./types.js";
import { exec, logInfo, logError, createTempDir } from "./utils.js";

// ── URL Parsing ──────────────────────────────────────────────────────

const PR_URL_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?/;

/**
 * Parse a GitHub pull request URL into its components.
 */
export function parsePrUrl(url: string): PrInfo {
  const match = url.match(PR_URL_RE);
  if (!match) {
    throw new Error(
      `Invalid PR URL: "${url}". Expected format: https://github.com/owner/repo/pull/123`,
    );
  }
  return {
    owner: match[1],
    repo: match[2],
    number: parseInt(match[3], 10),
    url,
  };
}

// ── PR Metadata ──────────────────────────────────────────────────────

/**
 * Fetch PR metadata using `gh pr view`.
 */
export async function fetchPrMetadata(pr: PrInfo): Promise<PrMetadata> {
  const nwo = `${pr.owner}/${pr.repo}`;
  const fields =
    "title,body,baseRefName,headRefName,headRefOid,files";

  const result = await exec("gh", [
    "pr",
    "view",
    String(pr.number),
    "--repo",
    nwo,
    "--json",
    fields,
  ]);

  if (!result.success) {
    throw new Error(`Failed to fetch PR metadata: ${result.stderr}`);
  }

  const data = JSON.parse(result.stdout);

  return {
    title: data.title ?? "",
    body: data.body ?? "",
    baseRefName: data.baseRefName ?? "main",
    headRefName: data.headRefName ?? "",
    headRefOid: data.headRefOid ?? "",
    files: (data.files ?? []).map((f: Record<string, unknown>) => ({
      path: f.path as string,
      additions: (f.additions as number) ?? 0,
      deletions: (f.deletions as number) ?? 0,
    })) as PrFile[],
  };
}

// ── Fetch PR diff ────────────────────────────────────────────────────

/**
 * Get the unified diff of the PR.
 */
export async function fetchPrDiff(pr: PrInfo): Promise<string> {
  const nwo = `${pr.owner}/${pr.repo}`;
  const result = await exec("gh", [
    "pr",
    "diff",
    String(pr.number),
    "--repo",
    nwo,
  ]);

  if (!result.success) {
    throw new Error(`Failed to fetch PR diff: ${result.stderr}`);
  }
  return result.stdout;
}

// ── Clone ────────────────────────────────────────────────────────────

/**
 * Clone the repository and checkout the PR head.
 * Returns the path to the cloned directory.
 */
export async function cloneAndCheckout(
  pr: PrInfo,
  targetDir?: string,
): Promise<string> {
  const cloneDir = targetDir ?? (await createTempDir());
  const nwo = `${pr.owner}/${pr.repo}`;
  const repoDir = join(cloneDir, pr.repo);

  logInfo(`Cloning ${nwo} into ${cloneDir}`);

  // Clone with shallow history
  const cloneResult = await exec("gh", [
    "repo",
    "clone",
    nwo,
    repoDir,
    "--",
    "--depth=50",
  ]);

  if (!cloneResult.success) {
    throw new Error(`Failed to clone repo: ${cloneResult.stderr}`);
  }

  // Fetch the PR ref and checkout
  logInfo(`Checking out PR #${pr.number}`);

  const fetchResult = await exec(
    "git",
    ["fetch", "origin", `pull/${pr.number}/head:pr-${pr.number}`],
    { cwd: repoDir },
  );

  if (!fetchResult.success) {
    throw new Error(`Failed to fetch PR ref: ${fetchResult.stderr}`);
  }

  const checkoutResult = await exec(
    "git",
    ["checkout", `pr-${pr.number}`],
    { cwd: repoDir },
  );

  if (!checkoutResult.success) {
    throw new Error(`Failed to checkout PR branch: ${checkoutResult.stderr}`);
  }

  return repoDir;
}

// ── Prerequisite checks ─────────────────────────────────────────────

/**
 * Verify that `gh` is installed and authenticated.
 */
export async function checkGhAuth(): Promise<void> {
  const version = await exec("gh", ["--version"]);
  if (!version.success) {
    throw new Error(
      "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
    );
  }

  const auth = await exec("gh", ["auth", "status"]);
  if (!auth.success) {
    throw new Error(
      "GitHub CLI is not authenticated. Run `gh auth login` first.",
    );
  }
}

/**
 * Verify that `codex` CLI is installed.
 */
export async function checkCodexInstalled(): Promise<void> {
  const result = await exec("codex", ["--version"]);
  if (!result.success) {
    throw new Error(
      "Codex CLI is not installed. Install it with: npm i -g @openai/codex",
    );
  }
}

// ── Post review ──────────────────────────────────────────────────────

/**
 * Post a PR review with inline comments using the GitHub API.
 */
export async function postPrReview(
  pr: PrInfo,
  payload: GitHubReviewPayload,
  commitId: string,
): Promise<void> {
  const apiPayload = {
    commit_id: commitId,
    event: payload.event,
    body: payload.body,
    comments: payload.comments.map((c) => ({
      path: c.path,
      line: c.line,
      body: c.body,
    })),
  };

  const jsonStr = JSON.stringify(apiPayload);

  const result = await exec("gh", [
    "api",
    `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
    "--method",
    "POST",
    "--input",
    "-",
  ], {
    input: jsonStr,
  });

  if (!result.success) {
    logError(`Failed to post PR review via API: ${result.stderr}`);
    // Fallback: post as a simple comment
    logInfo("Falling back to posting a simple PR comment...");
    await postPrComment(pr, payload.body);
  }
}

/**
 * Fallback: post a simple comment on the PR.
 */
export async function postPrComment(
  pr: PrInfo,
  body: string,
): Promise<void> {
  const nwo = `${pr.owner}/${pr.repo}`;
  const result = await exec("gh", [
    "pr",
    "comment",
    String(pr.number),
    "--repo",
    nwo,
    "--body",
    body,
  ]);

  if (!result.success) {
    logError(`Failed to post PR comment: ${result.stderr}`);
    logInfo("Review output:\n" + body);
  }
}
