import { describe, it, expect } from "vitest";
import { parsePrUrl } from "../src/github.js";

describe("parsePrUrl", () => {
  it("parses a standard PR URL", () => {
    const result = parsePrUrl("https://github.com/owner/repo/pull/123");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      number: 123,
      url: "https://github.com/owner/repo/pull/123",
    });
  });

  it("parses a PR URL with trailing slash", () => {
    const result = parsePrUrl("https://github.com/owner/repo/pull/456/");
    expect(result.owner).toBe("owner");
    expect(result.repo).toBe("repo");
    expect(result.number).toBe(456);
  });

  it("parses a PR URL with extra path segments (e.g. /files)", () => {
    const result = parsePrUrl("https://github.com/owner/repo/pull/789/files");
    expect(result.number).toBe(789);
  });

  it("parses a PR URL with http (no TLS)", () => {
    const result = parsePrUrl("http://github.com/owner/repo/pull/1");
    expect(result.number).toBe(1);
  });

  it("handles repos with hyphens and dots", () => {
    const result = parsePrUrl("https://github.com/my-org/my-repo.js/pull/42");
    expect(result.owner).toBe("my-org");
    expect(result.repo).toBe("my-repo.js");
    expect(result.number).toBe(42);
  });

  it("throws on a completely invalid string", () => {
    expect(() => parsePrUrl("not-a-url")).toThrow("Invalid PR URL");
  });

  it("throws on a non-PR GitHub URL", () => {
    expect(() => parsePrUrl("https://github.com/owner/repo")).toThrow(
      "Invalid PR URL",
    );
  });

  it("throws on a GitHub issues URL", () => {
    expect(() =>
      parsePrUrl("https://github.com/owner/repo/issues/1"),
    ).toThrow("Invalid PR URL");
  });

  it("throws on a non-GitHub URL", () => {
    expect(() =>
      parsePrUrl("https://gitlab.com/owner/repo/pull/1"),
    ).toThrow("Invalid PR URL");
  });

  it("throws on empty string", () => {
    expect(() => parsePrUrl("")).toThrow("Invalid PR URL");
  });
});
