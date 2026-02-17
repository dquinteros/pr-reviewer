import { basename, resolve } from "node:path";
import type { PrInfo, PrMetadata, PrFile } from "./types.js";
import { exec } from "./utils.js";

// ── Branch validation ────────────────────────────────────────────────

/**
 * Verify the target branch exists locally or as a remote tracking branch.
 * Throws if the branch cannot be resolved.
 */
export async function validateBranch(
  repoDir: string,
  branch: string,
): Promise<void> {
  const result = await exec(
    "git",
    ["rev-parse", "--verify", branch],
    { cwd: repoDir },
  );

  if (!result.success) {
    // Try with origin/ prefix
    const remoteResult = await exec(
      "git",
      ["rev-parse", "--verify", `origin/${branch}`],
      { cwd: repoDir },
    );

    if (!remoteResult.success) {
      throw new Error(
        `Branch "${branch}" not found locally or as origin/${branch}. ` +
        `Make sure the branch exists and has been fetched.`,
      );
    }
  }
}

// ── Git info helpers ─────────────────────────────────────────────────

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(repoDir: string): Promise<string> {
  const result = await exec(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: repoDir },
  );

  if (!result.success) {
    throw new Error(`Failed to determine current branch: ${result.stderr}`);
  }

  return result.stdout.trim();
}

/**
 * Get the HEAD commit SHA.
 */
export async function getHeadOid(repoDir: string): Promise<string> {
  const result = await exec(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoDir },
  );

  if (!result.success) {
    throw new Error(`Failed to get HEAD SHA: ${result.stderr}`);
  }

  return result.stdout.trim();
}

/**
 * Extract owner/repo from the git remote URL, falling back to directory name.
 */
export async function getRepoInfo(
  repoDir: string,
): Promise<{ owner: string; repo: string }> {
  const result = await exec(
    "git",
    ["remote", "get-url", "origin"],
    { cwd: repoDir },
  );

  if (result.success) {
    const url = result.stdout.trim();

    // SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/[:\/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }

    // HTTPS: https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }
  }

  // Fallback: use directory name
  const dirName = basename(resolve(repoDir));
  return { owner: "local", repo: dirName };
}

// ── Diff operations ──────────────────────────────────────────────────

/**
 * Get the unified diff between HEAD (or working tree) and a target branch.
 *
 * - `includeUncommitted = false`: `git diff <branch>...HEAD` (committed only)
 * - `includeUncommitted = true`:  `git diff <branch>` (includes working tree)
 */
export async function getLocalDiff(
  repoDir: string,
  branch: string,
  includeUncommitted: boolean,
): Promise<string> {
  const args = includeUncommitted
    ? ["diff", branch]
    : ["diff", `${branch}...HEAD`];

  const result = await exec("git", args, { cwd: repoDir });

  if (!result.success) {
    throw new Error(`Failed to generate diff against ${branch}: ${result.stderr}`);
  }

  return result.stdout;
}

/**
 * Get the list of changed files with addition/deletion counts.
 */
export async function getLocalChangedFiles(
  repoDir: string,
  branch: string,
  includeUncommitted: boolean,
): Promise<PrFile[]> {
  const args = includeUncommitted
    ? ["diff", "--numstat", branch]
    : ["diff", "--numstat", `${branch}...HEAD`];

  const result = await exec("git", args, { cwd: repoDir });

  if (!result.success) {
    throw new Error(`Failed to list changed files: ${result.stderr}`);
  }

  const files: PrFile[] = [];

  for (const line of result.stdout.trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;

    const additions = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
    const deletions = parts[1] === "-" ? 0 : parseInt(parts[1], 10);
    const path = parts[2];

    files.push({ path, additions, deletions });
  }

  return files;
}

// ── Context builder ──────────────────────────────────────────────────

/**
 * Build synthetic PrInfo + PrMetadata + diff from local git state.
 * These objects can be fed directly into the existing review pipeline.
 */
export async function buildLocalContext(
  repoDir: string,
  branch: string,
  includeUncommitted: boolean,
): Promise<{ pr: PrInfo; meta: PrMetadata; diff: string }> {
  const [currentBranch, headOid, repoInfo, diff, files] = await Promise.all([
    getCurrentBranch(repoDir),
    getHeadOid(repoDir),
    getRepoInfo(repoDir),
    getLocalDiff(repoDir, branch, includeUncommitted),
    getLocalChangedFiles(repoDir, branch, includeUncommitted),
  ]);

  const uncommittedNote = includeUncommitted ? " (including uncommitted changes)" : "";

  const pr: PrInfo = {
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    number: 0,
    url: repoDir,
    label: `local changes on branch \`${currentBranch}\` against \`${branch}\`${uncommittedNote}`,
  };

  const meta: PrMetadata = {
    title: `Local changes on ${currentBranch} against ${branch}`,
    body: "",
    baseRefName: branch,
    headRefName: currentBranch,
    headRefOid: headOid,
    files,
  };

  return { pr, meta, diff };
}
