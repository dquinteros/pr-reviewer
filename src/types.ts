/** Parsed pull request URL components */
export interface PrInfo {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

/** PR metadata fetched from GitHub */
export interface PrMetadata {
  title: string;
  body: string;
  /** AI-generated summary of the PR description (set after pre-processing). */
  bodySummary?: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  files: PrFile[];
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

/** Detected project configuration */
export interface ProjectConfig {
  type: ProjectType;
  installCmd: string | null;
  testCmd: string | null;
  lintCmd: string | null;
}

export type ProjectType =
  | "nodejs"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "unknown";

/** Result from running a shell command */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

/** Result from running tests or linting */
export interface StepResult {
  step: "install" | "test" | "lint";
  success: boolean;
  output: string;
  /** AI-generated summary of the raw output (set after pre-processing). */
  summarizedOutput?: string;
  duration: number;
}

/** A single finding from the Codex AI review */
export interface ReviewFinding {
  file: string;
  line: number;
  severity: "critical" | "warning" | "suggestion" | "nitpick";
  title: string;
  body: string;
  suggestion?: string;
}

/** Structured output from Codex AI review */
export interface ReviewOutput {
  summary: string;
  findings: ReviewFinding[];
  verdict: "approve" | "request_changes" | "comment";
}

/** GitHub PR review inline comment */
export interface GitHubReviewComment {
  path: string;
  line: number;
  body: string;
}

/** Full GitHub PR review payload */
export interface GitHubReviewPayload {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  comments: GitHubReviewComment[];
}

/** CLI options parsed from command line */
export interface CliOptions {
  keep: boolean;
  skipTests: boolean;
  skipLint: boolean;
  skipReview: boolean;
  skipArch: boolean;
  model?: string;
  concurrency: number;
  includeAll: boolean;
}

// ── Architecture Conformance Review types ─────────────────────────────

/** A layer definition from .arch-rules.yml */
export interface ArchLayer {
  name: string;
  paths: string[];
  allowed_imports: string[];
}

/** A naming convention rule from .arch-rules.yml */
export interface ArchNamingConvention {
  pattern: string;
  rule: string;
}

/** Parsed .arch-rules.yml configuration */
export interface ArchRules {
  layers?: ArchLayer[];
  naming_conventions?: ArchNamingConvention[];
  design_patterns?: string[];
}

/** Category of an architecture violation */
export type ArchViolationCategory =
  | "layer_violation"
  | "naming_convention"
  | "design_pattern"
  | "circular_dependency";

/** A single architecture conformance violation */
export interface ArchViolation {
  file: string;
  line: number;
  category: ArchViolationCategory;
  severity: "critical" | "warning" | "suggestion";
  rule: string;
  description: string;
  suggestion: string;
}

/** Structured output from the architecture conformance review */
export interface ArchReviewOutput {
  summary: string;
  conformance_score: number;
  violations: ArchViolation[];
}
