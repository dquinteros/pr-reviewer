import { access } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectConfig, ProjectType } from "./types.js";
import { logInfo } from "./utils.js";

/**
 * Check if a file exists in a directory.
 */
async function fileExists(dir: string, file: string): Promise<boolean> {
  try {
    await access(join(dir, file));
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect project type and commands by inspecting config files.
 */
export async function detectProject(repoDir: string): Promise<ProjectConfig> {
  // ── Node.js ─────────────────────────────────────────────────────
  if (await fileExists(repoDir, "package.json")) {
    logInfo("Detected Node.js project");

    const pkg = JSON.parse(
      await readFile(join(repoDir, "package.json"), "utf-8"),
    );
    const scripts = pkg.scripts ?? {};

    // Determine package manager
    const hasYarnLock = await fileExists(repoDir, "yarn.lock");
    const hasPnpmLock = await fileExists(repoDir, "pnpm-lock.yaml");
    const pm = hasPnpmLock ? "pnpm" : hasYarnLock ? "yarn" : "npm";

    const installCmd =
      pm === "npm"
        ? (await fileExists(repoDir, "package-lock.json"))
          ? "npm ci"
          : "npm install"
        : pm === "yarn"
          ? "yarn install --frozen-lockfile"
          : "pnpm install --frozen-lockfile";

    // Detect test command
    let testCmd: string | null = null;
    if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
      const testScript: string = scripts.test;
      const usesJest =
        testScript.includes("jest") ||
        (pkg.devDependencies?.jest || pkg.dependencies?.jest) ||
        (pkg.devDependencies?.["@nestjs/testing"]);
      const usesVitest =
        testScript.includes("vitest") ||
        (pkg.devDependencies?.vitest || pkg.dependencies?.vitest);

      if (usesJest) {
        // --forceExit kills open handles (DB, HTTP); --watchAll=false disables watch mode
        testCmd = `npx jest --forceExit --watchAll=false --no-coverage`;
      } else if (usesVitest) {
        testCmd = `npx vitest run`;
      } else {
        testCmd = `${pm} test`;
      }
    }

    // Detect lint command
    let lintCmd: string | null = null;
    if (scripts.lint) {
      lintCmd = `${pm} run lint`;
    } else if (
      (await fileExists(repoDir, ".eslintrc.json")) ||
      (await fileExists(repoDir, ".eslintrc.js")) ||
      (await fileExists(repoDir, ".eslintrc.cjs")) ||
      (await fileExists(repoDir, ".eslintrc.yml")) ||
      (await fileExists(repoDir, ".eslintrc.yaml")) ||
      (await fileExists(repoDir, "eslint.config.js")) ||
      (await fileExists(repoDir, "eslint.config.mjs")) ||
      (await fileExists(repoDir, "eslint.config.cjs")) ||
      (await fileExists(repoDir, "eslint.config.ts")) ||
      (await fileExists(repoDir, "eslint.config.mts")) ||
      (await fileExists(repoDir, "eslint.config.cts"))
    ) {
      lintCmd = "npx eslint .";
    }

    return { type: "nodejs", installCmd, testCmd, lintCmd };
  }

  // ── Python ──────────────────────────────────────────────────────
  if (
    (await fileExists(repoDir, "pyproject.toml")) ||
    (await fileExists(repoDir, "requirements.txt")) ||
    (await fileExists(repoDir, "setup.py"))
  ) {
    logInfo("Detected Python project");

    let installCmd: string | null = null;
    if (await fileExists(repoDir, "pyproject.toml")) {
      installCmd = "pip install -e '.[dev]' 2>/dev/null || pip install -e .";
    } else if (await fileExists(repoDir, "requirements.txt")) {
      installCmd = "pip install -r requirements.txt";
    }

    // Detect test framework
    let testCmd: string | null = null;
    if (await fileExists(repoDir, "pytest.ini")) {
      testCmd = "pytest";
    } else if (await fileExists(repoDir, "pyproject.toml")) {
      const toml = await readFile(join(repoDir, "pyproject.toml"), "utf-8");
      if (toml.includes("[tool.pytest")) {
        testCmd = "pytest";
      }
    }
    if (!testCmd) {
      testCmd = "python -m pytest 2>/dev/null || python -m unittest discover";
    }

    // Detect linter
    let lintCmd: string | null = null;
    if (await fileExists(repoDir, "ruff.toml")) {
      lintCmd = "ruff check .";
    } else if (await fileExists(repoDir, "pyproject.toml")) {
      const toml = await readFile(join(repoDir, "pyproject.toml"), "utf-8");
      if (toml.includes("[tool.ruff")) {
        lintCmd = "ruff check .";
      } else if (toml.includes("[tool.pylint")) {
        lintCmd = "pylint **/*.py";
      }
    }
    if (!lintCmd) {
      lintCmd = "ruff check . 2>/dev/null || true";
    }

    return { type: "python", installCmd, testCmd, lintCmd };
  }

  // ── Rust ────────────────────────────────────────────────────────
  if (await fileExists(repoDir, "Cargo.toml")) {
    logInfo("Detected Rust project");
    return {
      type: "rust",
      installCmd: "cargo build",
      testCmd: "cargo test",
      lintCmd: "cargo clippy -- -D warnings 2>/dev/null || true",
    };
  }

  // ── Go ──────────────────────────────────────────────────────────
  if (await fileExists(repoDir, "go.mod")) {
    logInfo("Detected Go project");
    return {
      type: "go",
      installCmd: "go build ./...",
      testCmd: "go test ./...",
      lintCmd: "golangci-lint run 2>/dev/null || go vet ./...",
    };
  }

  // ── Java / Kotlin ───────────────────────────────────────────────
  if (await fileExists(repoDir, "pom.xml")) {
    logInfo("Detected Java/Maven project");
    return {
      type: "java",
      installCmd: "mvn compile -q",
      testCmd: "mvn test -q",
      lintCmd: null,
    };
  }
  if (
    (await fileExists(repoDir, "build.gradle")) ||
    (await fileExists(repoDir, "build.gradle.kts"))
  ) {
    logInfo("Detected Java/Gradle project");
    return {
      type: "java",
      installCmd: "gradle build -x test",
      testCmd: "gradle test",
      lintCmd: null,
    };
  }

  // ── Makefile fallback ───────────────────────────────────────────
  if (await fileExists(repoDir, "Makefile")) {
    logInfo("Detected Makefile-based project");
    const makefile = await readFile(join(repoDir, "Makefile"), "utf-8");
    return {
      type: "unknown",
      installCmd: makefile.includes("install:") ? "make install" : null,
      testCmd: makefile.includes("test:") ? "make test" : null,
      lintCmd: makefile.includes("lint:") ? "make lint" : null,
    };
  }

  // ── Unknown ─────────────────────────────────────────────────────
  logInfo("Could not detect project type");
  return {
    type: "unknown",
    installCmd: null,
    testCmd: null,
    lintCmd: null,
  };
}
