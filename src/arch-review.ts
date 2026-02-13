import { access, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import type {
  PrInfo,
  PrMetadata,
  ArchRules,
  ArchReviewOutput,
} from "./types.js";
import { exec, logStep, logSuccess, logError, logWarn, truncate } from "./utils.js";

// Path to the architecture review schema (relative to package root)
const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCH_SCHEMA_PATH = resolve(__dirname, "..", "schemas", "arch-review-output.json");

// ── Load architecture rules ──────────────────────────────────────────

/**
 * Look for `.arch-rules.yml` or `.arch-rules.yaml` in the repo root.
 * Returns parsed rules or `null` if no config file is found.
 */
export async function loadArchRules(repoDir: string): Promise<ArchRules | null> {
  const candidates = [
    join(repoDir, ".arch-rules.yml"),
    join(repoDir, ".arch-rules.yaml"),
  ];

  for (const filePath of candidates) {
    try {
      await access(filePath);
      const raw = await readFile(filePath, "utf-8");
      const parsed = yaml.load(raw) as ArchRules;

      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // File does not exist or cannot be read — try next candidate
    }
  }

  return null;
}

// ── Build architecture review prompt ─────────────────────────────────

/**
 * Build the Codex prompt for architecture conformance review.
 * If explicit rules are provided, embed them; otherwise instruct
 * the AI to infer the architecture from the codebase.
 */
function buildArchPrompt(
  pr: PrInfo,
  meta: PrMetadata,
  diff: string,
  rules: ArchRules | null,
): string {
  const parts: string[] = [];

  parts.push(
    "You are an architecture conformance reviewer for " +
    `Pull Request #${pr.number} in ${pr.owner}/${pr.repo}.`,
  );
  parts.push(
    "Your job is to check whether the changes in this PR conform to the " +
    "project's architecture rules and conventions.",
  );
  parts.push("");

  // PR context
  parts.push(`Title: ${meta.title}`);
  if (meta.body) {
    parts.push(`Description: ${truncate(meta.body, 2000)}`);
  }
  parts.push(
    `Base branch: ${meta.baseRefName}, Head branch: ${meta.headRefName}`,
  );
  parts.push("");

  // Files changed
  if (meta.files.length > 0) {
    parts.push("Files changed:");
    for (const f of meta.files) {
      parts.push(`  ${f.path} (+${f.additions} -${f.deletions})`);
    }
    parts.push("");
  }

  // Diff
  parts.push("PR Diff:");
  parts.push("```diff");
  parts.push(truncate(diff, 30000));
  parts.push("```");
  parts.push("");

  // Architecture rules (explicit or inferred)
  if (rules) {
    parts.push("## Explicit Architecture Rules");
    parts.push("");
    parts.push(
      "The project defines the following architecture rules in `.arch-rules.yml`. " +
      "Evaluate the PR changes against these rules strictly.",
    );
    parts.push("");

    if (rules.layers && rules.layers.length > 0) {
      parts.push("### Layer Definitions");
      parts.push("");
      for (const layer of rules.layers) {
        parts.push(`**${layer.name}**`);
        parts.push(`  Paths: ${layer.paths.join(", ")}`);
        parts.push(
          `  Allowed imports from: ${layer.allowed_imports.length > 0 ? layer.allowed_imports.join(", ") : "(none — leaf layer)"}`,
        );
        parts.push("");
      }
    }

    if (rules.naming_conventions && rules.naming_conventions.length > 0) {
      parts.push("### Naming Conventions");
      parts.push("");
      for (const nc of rules.naming_conventions) {
        parts.push(`- Pattern \`${nc.pattern}\`: ${nc.rule}`);
      }
      parts.push("");
    }

    if (rules.design_patterns && rules.design_patterns.length > 0) {
      parts.push("### Design Pattern Rules");
      parts.push("");
      for (const dp of rules.design_patterns) {
        parts.push(`- ${dp}`);
      }
      parts.push("");
    }
  } else {
    parts.push("## Architecture Rules (Inferred)");
    parts.push("");
    parts.push(
      "No `.arch-rules.yml` config was found in this repository. " +
      "Infer the project's architecture by analyzing:",
    );
    parts.push("1. Directory structure and module organization");
    parts.push("2. Import/dependency patterns between modules");
    parts.push("3. Naming conventions used across the codebase");
    parts.push("4. Apparent design patterns (MVC, layered, hexagonal, etc.)");
    parts.push("");
    parts.push(
      "Based on the inferred architecture, check whether the PR changes " +
      "conform to the established patterns or introduce violations.",
    );
    parts.push("");
  }

  // Review instructions
  parts.push("## Review Instructions");
  parts.push("");
  parts.push("Check the PR changes for the following categories of violations:");
  parts.push("");
  parts.push("1. **Layer violations**: Imports that cross layer boundaries incorrectly " +
    "(e.g., a domain layer importing from presentation).");
  parts.push("2. **Naming convention violations**: Files, classes, functions, or variables " +
    "that don't follow the project's established naming patterns.");
  parts.push("3. **Design pattern violations**: Code that breaks established design patterns " +
    "(e.g., business logic in controllers, direct DB access outside repositories).");
  parts.push("4. **Circular dependencies**: New imports that create or contribute to " +
    "circular dependency chains.");
  parts.push("");
  parts.push(
    "For each violation, provide the exact file path, line number, category, " +
    "severity (critical/warning/suggestion), the rule being violated, " +
    "a detailed description, and a concrete suggestion to fix it.",
  );
  parts.push("");
  parts.push(
    "Set conformance_score from 0 to 100 where 100 means fully conformant " +
    "and 0 means severe architecture violations throughout.",
  );
  parts.push("");
  parts.push(
    "If the PR changes are fully conformant, return an empty violations " +
    "array and a score of 100.",
  );

  return parts.join("\n");
}

// ── Run architecture conformance review ──────────────────────────────

/**
 * Run the architecture conformance review using Codex CLI.
 */
export async function runArchReview(
  repoDir: string,
  pr: PrInfo,
  meta: PrMetadata,
  diff: string,
  model?: string,
): Promise<ArchReviewOutput> {
  logStep("Running architecture conformance review with Codex...");

  // Load architecture rules from repo (if present)
  const rules = await loadArchRules(repoDir);
  if (rules) {
    logSuccess("Loaded architecture rules from .arch-rules.yml");
  } else {
    logWarn("No .arch-rules.yml found — AI will infer architecture from codebase");
  }

  const prompt = buildArchPrompt(pr, meta, diff, rules);

  // Temp file for structured output
  const outputPath = join(tmpdir(), `pr-arch-review-${pr.number}-${Date.now()}.json`);

  // Build codex exec arguments
  const args: string[] = [
    "exec",
    "--yolo",
    "--cd",
    repoDir,
    "--output-schema",
    ARCH_SCHEMA_PATH,
    "-o",
    outputPath,
  ];

  if (model) {
    args.push("--model", model);
  }

  args.push(prompt);

  const result = await exec("codex", args, {
    timeout: 5 * 60 * 1000, // 5 min timeout
  });

  // Combine stdout+stderr for error detection (codex logs to stderr)
  const allOutput = result.stdout + "\n" + result.stderr;

  // Check for auth errors
  if (
    allOutput.includes("refresh_token_reused") ||
    allOutput.includes("Failed to refresh token") ||
    allOutput.includes("401 Unauthorized")
  ) {
    logError("Codex authentication expired. Run `codex logout && codex login` to re-authenticate.");
    return buildFallbackArchReview();
  }

  // Check for schema errors
  if (allOutput.includes("invalid_json_schema") || allOutput.includes("Invalid schema")) {
    logError("Codex rejected the output schema. Check schemas/arch-review-output.json");
    logError(result.stderr);
    return buildFallbackArchReview();
  }

  if (!result.success) {
    logError(`Codex architecture review failed: ${result.stderr}`);
    return buildFallbackArchReview();
  }

  // Read the structured output
  try {
    const raw = await readFile(outputPath, "utf-8");
    const parsed = JSON.parse(raw) as ArchReviewOutput;

    // Validate basic structure
    if (
      !parsed.summary ||
      typeof parsed.conformance_score !== "number" ||
      !Array.isArray(parsed.violations)
    ) {
      logWarn("Codex arch review output missing expected fields, using fallback");
      return buildFallbackFromText(result.stdout);
    }

    logSuccess(
      `Architecture review complete: score ${parsed.conformance_score}/100, ` +
      `${parsed.violations.length} violations`,
    );
    return parsed;
  } catch {
    logWarn("Failed to parse Codex arch review output, using fallback");
    return buildFallbackFromText(result.stdout);
  } finally {
    // Clean up temp output file
    await unlink(outputPath).catch(() => {});
  }
}

// ── Fallback builders ────────────────────────────────────────────────

/**
 * Build a fallback architecture review when Codex fails entirely.
 */
function buildFallbackArchReview(): ArchReviewOutput {
  return {
    summary: "Architecture conformance review could not be completed.",
    conformance_score: -1,
    violations: [],
  };
}

/**
 * Build an architecture review from raw text when structured parsing fails.
 */
function buildFallbackFromText(text: string): ArchReviewOutput {
  return {
    summary: truncate(text, 4000) || "Architecture conformance review produced no output.",
    conformance_score: -1,
    violations: [],
  };
}
