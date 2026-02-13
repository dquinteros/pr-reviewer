# ai-pr-reviewer

A CLI tool that reviews GitHub pull requests using **OpenAI Codex CLI** and **GitHub CLI**. It clones the repository, runs tests and linting, performs AI-powered code review, checks architecture conformance, and posts inline suggestions plus a summary comment directly to the PR.

## Prerequisites

Before using `ai-pr-reviewer`, make sure you have the following installed and authenticated:

| Tool | Install | Auth |
|------|---------|------|
| **Node.js** >= 18 | [nodejs.org](https://nodejs.org/) | N/A |
| **GitHub CLI** (`gh`) | [cli.github.com](https://cli.github.com/) | `gh auth login` |
| **Codex CLI** (`codex`) | `npm i -g @openai/codex` | `codex login` |

### Verifying prerequisites

```bash
# Check GitHub CLI
gh auth status

# Check Codex CLI
codex --version
```

If your Codex session expires (you see `refresh_token_reused` errors), re-authenticate:

```bash
codex logout && codex login
```

## Installation

### Quick start with npx (no install needed)

```bash
npx ai-pr-reviewer https://github.com/owner/repo/pull/123
```

### Install globally from npm

```bash
npm i -g ai-pr-reviewer
ai-pr-reviewer https://github.com/owner/repo/pull/123
```

### Install from source

```bash
git clone https://github.com/dquinteros/reviewer.git
cd reviewer
npm install
npm run build
npm link   # makes `ai-pr-reviewer` available globally
```

Or run in development mode without building:

```bash
npx tsx src/cli.ts <PR_URL>
```

## Usage

```bash
# Basic usage
ai-pr-reviewer https://github.com/owner/repo/pull/123

# Keep the cloned repo for debugging
ai-pr-reviewer https://github.com/owner/repo/pull/123 --keep

# Skip tests
ai-pr-reviewer https://github.com/owner/repo/pull/123 --skip-tests

# Skip linting
ai-pr-reviewer https://github.com/owner/repo/pull/123 --skip-lint

# Skip AI review (only run tests and lint, post those results)
ai-pr-reviewer https://github.com/owner/repo/pull/123 --skip-review

# Skip architecture conformance review
ai-pr-reviewer https://github.com/owner/repo/pull/123 --skip-arch

# Use a specific Codex model
ai-pr-reviewer https://github.com/owner/repo/pull/123 --model gpt-5.3-codex

# Combine flags
ai-pr-reviewer https://github.com/owner/repo/pull/123 --skip-lint --keep --model gpt-5.3-codex
```

### CLI Flags Reference

| Flag | Description | Default |
|------|-------------|---------|
| `--keep` | Keep the cloned repo directory after review | `false` |
| `--skip-tests` | Skip running the test suite | `false` |
| `--skip-lint` | Skip running the linter | `false` |
| `--skip-review` | Skip AI code review (only run tests/lint) | `false` |
| `--skip-arch` | Skip architecture conformance review | `false` |
| `-m, --model <model>` | Codex model to use | Codex default |
| `-V, --version` | Show version number | -- |
| `-h, --help` | Show help | -- |

## What It Does

1. **Checks prerequisites** -- verifies `gh` and `codex` are installed and authenticated.
2. **Parses the PR URL** -- extracts owner, repo, and PR number.
3. **Fetches PR metadata** -- title, description, changed files, and the full diff via `gh`.
4. **Clones the repository** -- into a temporary directory using `gh repo clone` (shallow, depth 50).
5. **Checks out the PR branch** -- fetches the PR ref and checks it out locally.
6. **Detects the project type** -- scans for `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, etc. and determines install/test/lint commands automatically.
7. **Installs dependencies** -- runs the appropriate install command for the detected project type.
8. **Runs the test suite** -- executes the detected test command with `CI=true` and captures results. For Jest projects, uses `--forceExit --watchAll=false` to prevent hanging.
9. **Runs the linter** -- executes the detected lint command and captures results.
10. **Performs AI code review** -- sends the PR diff, test results, and lint results to Codex CLI (`codex exec`) for structured analysis using a JSON schema.
11. **Architecture conformance review** -- runs a separate AI analysis checking the PR changes against the project's architecture rules (from `.arch-rules.yml` if present, or AI-inferred from the codebase structure).
12. **Posts results to GitHub** -- creates a PR review with inline comments on specific lines (using GitHub suggestion syntax) plus an overall summary comment including architecture conformance score.
13. **Cleans up** -- removes the temporary clone (unless `--keep` is used).

## Supported Project Types

| Type | Detection | Install | Test | Lint |
|------|-----------|---------|------|------|
| **Node.js** | `package.json` | `npm ci` / `yarn` / `pnpm` (auto-detected via lockfile) | Jest: `npx jest --forceExit --watchAll=false`; Vitest: `npx vitest run`; Other: `npm test` | `npm run lint` / eslint |
| **Python** | `pyproject.toml` / `requirements.txt` / `setup.py` | `pip install -e .` / `pip install -r requirements.txt` | `pytest` / `python -m unittest discover` | `ruff` / `pylint` |
| **Rust** | `Cargo.toml` | `cargo build` | `cargo test` | `cargo clippy` |
| **Go** | `go.mod` | `go build ./...` | `go test ./...` | `golangci-lint` / `go vet` |
| **Java/Kotlin** | `pom.xml` / `build.gradle` / `build.gradle.kts` | `mvn compile` / `gradle build` | `mvn test` / `gradle test` | -- |
| **Makefile** | `Makefile` (looks for `test:`, `lint:`, `install:` targets) | `make install` | `make test` | `make lint` |

### Node.js specifics

The tool auto-detects the package manager from lockfiles:
- `package-lock.json` -> `npm ci`
- `yarn.lock` -> `yarn install --frozen-lockfile`
- `pnpm-lock.yaml` -> `pnpm install --frozen-lockfile`

For test runners, it inspects `package.json` dependencies and scripts:
- **Jest** (including NestJS projects) -- uses `npx jest --forceExit --watchAll=false --no-coverage` to prevent watch mode and force-kill open handles (DB connections, HTTP servers).
- **Vitest** -- uses `npx vitest run` (single-run mode).
- **Other** -- falls back to `npm test`.

All commands run with `CI=true` and `FORCE_COLOR=0` environment variables set.

## How the AI Review Works

The tool uses `codex exec` in non-interactive mode with `--yolo` (no approvals, no sandbox) and `--output-schema` to get structured JSON output.

The review prompt includes:
- The full PR diff (truncated to 30K chars for large PRs)
- Test results (pass/fail + output)
- Lint results (pass/fail + output)
- Instructions to focus on bugs, security, performance, style, and error handling

The structured output schema enforces:
- **summary** -- overall assessment of the PR
- **findings[]** -- specific issues, each with:
  - `file` -- relative file path
  - `line` -- line number in the new code
  - `severity` -- `critical`, `warning`, `suggestion`, or `nitpick`
  - `title` -- short description
  - `body` -- detailed explanation
  - `suggestion` -- concrete code fix (empty string if none)
- **verdict** -- `approve`, `request_changes`, or `comment`

### How findings are posted

- Each finding is posted as an **inline comment** on the specific file and line in the PR.
- When a finding includes a suggestion, it uses GitHub's suggestion syntax so reviewers can apply the fix with one click:
  ````
  ```suggestion
  fixed code here
  ```
  ````
- An **overall summary comment** is posted with a severity table, test results, and lint results.
- The GitHub review event is set to `APPROVE`, `REQUEST_CHANGES`, or `COMMENT` based on the AI verdict.

## Architecture Conformance Review

After the code review, a separate AI step checks the PR changes for architecture violations. It supports two modes:

### Explicit rules (`.arch-rules.yml`)

If the repository contains a `.arch-rules.yml` (or `.arch-rules.yaml`) at the root, the tool loads it and evaluates changes against those rules. Example config:

```yaml
layers:
  - name: presentation
    paths: ["src/components/**", "src/pages/**"]
    allowed_imports: ["domain", "application"]
  - name: application
    paths: ["src/services/**", "src/hooks/**"]
    allowed_imports: ["domain"]
  - name: domain
    paths: ["src/models/**", "src/types/**"]
    allowed_imports: []
  - name: infrastructure
    paths: ["src/api/**", "src/db/**"]
    allowed_imports: ["domain"]

naming_conventions:
  - pattern: "src/components/**/*.tsx"
    rule: "PascalCase filenames"
  - pattern: "src/services/**/*.ts"
    rule: "camelCase filenames, must export a class ending in 'Service'"

design_patterns:
  - "Services should not import directly from components"
  - "Repository pattern for data access"
```

### AI-inferred rules

When no config file is present, the AI infers the project's architecture from its directory structure, naming conventions, and import graph, then checks the PR changes for conformance.

### What it checks

| Category | Description |
|----------|-------------|
| **Layer violations** | Imports that cross layer boundaries incorrectly (e.g., domain importing from presentation) |
| **Naming conventions** | Files, classes, or functions that don't follow established naming patterns |
| **Design patterns** | Code that breaks established patterns (e.g., business logic in controllers) |
| **Circular dependencies** | New imports that create or contribute to circular dependency chains |

### Architecture review output

The structured output includes:
- **summary** -- overall architecture conformance assessment
- **conformance_score** -- 0 to 100 (100 = fully conformant)
- **violations[]** -- specific violations, each with:
  - `file` -- relative file path
  - `line` -- line number
  - `category` -- `layer_violation`, `naming_convention`, `design_pattern`, or `circular_dependency`
  - `severity` -- `critical`, `warning`, or `suggestion`
  - `rule` -- the architecture rule that was violated
  - `description` -- detailed explanation
  - `suggestion` -- concrete fix

Architecture violations are posted as inline PR comments (just like code review findings) and appear in a dedicated "Architecture Conformance" section of the summary comment with a score and violations table.

## Timeouts

| Step | Timeout | Notes |
|------|---------|-------|
| Clone | 5 min | Default exec timeout |
| Install | 5 min | Default exec timeout |
| Tests | 3 min | Shorter to avoid hanging test suites |
| Lint | 5 min | Default exec timeout |
| AI Review | 5 min | Codex exec timeout |
| Arch Review | 5 min | Codex exec timeout |

If a step times out, the output shows `[TIMEOUT]` and the pipeline continues with the remaining steps.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Dependency install fails | Review continues; failure noted in context |
| Tests fail | Results included in the AI review prompt for richer analysis |
| Linting fails | Results included in the AI review prompt for richer analysis |
| Codex auth expired | Clear error message: "Run `codex logout && codex login`" |
| Codex schema rejected | Error logged with details; fallback review posted |
| Codex fails (other) | Fallback review with test/lint results only is posted |
| GitHub review API fails | Falls back to a simple PR comment |
| GitHub comment also fails | Review payload printed to stdout for manual use |

## Troubleshooting

### Tests hang indefinitely

The tool sets `CI=true` and uses `--forceExit` for Jest, but some test suites may still hang if they start servers or have unusual configurations. Use `--skip-tests` to bypass:

```bash
ai-pr-reviewer https://github.com/owner/repo/pull/123 --skip-tests
```

### Codex authentication errors

If you see `refresh_token_reused` or `401 Unauthorized`:

```bash
codex logout && codex login
```

### GitHub permissions

The `gh` CLI needs read access to the repository and write access to pull requests. For private repos, make sure your `gh auth` token has the `repo` scope:

```bash
gh auth login --scopes repo
```

### Large PRs

PRs with very large diffs (>30K chars) are automatically truncated in the review prompt. For best results on large PRs, consider reviewing specific areas by using Codex CLI directly on the cloned repo with `--keep`:

```bash
ai-pr-reviewer https://github.com/owner/repo/pull/123 --keep --skip-review
# Then manually: cd /tmp/ai-pr-reviewer-XXXXXX/repo && codex
```

## Project Structure

```
reviewer/
  package.json              # npm package with bin entry
  tsconfig.json             # TypeScript config (ES2022, Node16)
  schemas/
    review-output.json      # JSON Schema for Codex code review output
    arch-review-output.json # JSON Schema for architecture review output
  src/
    cli.ts                  # Entry point: commander CLI, orchestration
    github.ts               # gh CLI wrapper: PR metadata, clone, post review
    detect.ts               # Auto-detect project type and commands
    runner.ts               # Run install/test/lint, capture output
    review.ts               # Build prompt, call codex exec, parse results
    arch-review.ts          # Architecture conformance review (load rules, prompt, call codex)
    reporter.ts             # Build GitHub review payload with inline suggestions
    types.ts                # Shared TypeScript interfaces
    utils.ts                # Exec wrapper, logger, temp dir, truncation
```

## Publishing to npm

The project includes GitHub Actions workflows for CI and publishing.

### Setup

1. Create an npm access token at [npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens) (use **Automation** type).
2. Add the token as a repository secret named `NPM_TOKEN` in your GitHub repo settings (Settings > Secrets and variables > Actions).

### Release process

1. Update the version in `package.json`:

```bash
npm version patch   # 1.0.0 -> 1.0.1
# or
npm version minor   # 1.0.0 -> 1.1.0
# or
npm version major   # 1.0.0 -> 2.0.0
```

2. Push the tag to trigger the publish workflow:

```bash
git push origin main --tags
```

The workflow will automatically build, verify, and publish to npm with provenance.

### Manual publish

You can also trigger a publish (or dry run) manually from the **Actions** tab in GitHub:

- Go to Actions > "Publish to npm" > Run workflow
- Check "Dry run" to preview what would be published without actually publishing

### Workflows

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| **CI** (`.github/workflows/ci.yml`) | Push to `main`, PRs | Builds and verifies on Node 18, 20, 22 |
| **Publish** (`.github/workflows/publish.yml`) | Version tags (`v*`), manual | Builds, verifies, publishes to npm |

## License

MIT
