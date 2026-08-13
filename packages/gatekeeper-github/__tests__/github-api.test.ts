import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubApi,
  type GitHubIssueResponse,
} from "../src/github-api";
import { boundJobLog, validateCommitFilesOptions, validateRepoPath } from "../src/github-ci";
import {
  assertIssueSearchResultsInRepo,
  buildIssueSearchQuery,
} from "../src/github-search";

function issueAt(htmlUrl: string): Pick<GitHubIssueResponse, "html_url"> {
  return { html_url: htmlUrl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assertIssueSearchResultsInRepo", () => {
  it("accepts exact repository path segments case-insensitively", () => {
    expect(() => assertIssueSearchResultsInRepo("Cloudflare", "Workerd", [
      issueAt("https://github.com/cloudflare/workerd/issues/1"),
    ])).not.toThrow();
  });

  it("rejects results from another repository", () => {
    expect(() => assertIssueSearchResultsInRepo("cloudflare", "workerd", [
      issueAt("https://github.com/cloudflare/quiche/issues/1"),
    ])).toThrow("outside the connected repository");
  });

  it("does not accept repository names that only share a prefix", () => {
    expect(() => assertIssueSearchResultsInRepo("cloudflare", "workerd", [
      issueAt("https://github.com/cloudflare/workerd-private/issues/1"),
    ])).toThrow("outside the connected repository");
  });

  it("rejects pull requests returned by an injected search expression", () => {
    expect(() => assertIssueSearchResultsInRepo("cloudflare", "workerd", [
      issueAt("https://github.com/cloudflare/workerd/pull/1"),
    ])).toThrow("non-issue result");
  });

  it("rejects malformed and non-GitHub result URLs", () => {
    expect(() => assertIssueSearchResultsInRepo("cloudflare", "workerd", [
      issueAt("not a URL"),
    ])).toThrow("outside the connected repository");
    expect(() => assertIssueSearchResultsInRepo("cloudflare", "workerd", [
      issueAt("https://example.com/cloudflare/workerd/issues/1"),
    ])).toThrow("outside the connected repository");
  });
});

describe("buildIssueSearchQuery", () => {
  it("builds a benign literal phrase search with structured filters", () => {
    expect(buildIssueSearchQuery("cloudflare", "workerd", {
      text: "durable objects",
      state: "open",
      labels: ["bug"],
      author: "jasnell",
    })).toBe(
      '"durable objects" repo:cloudflare/workerd is:issue state:open label:"bug" author:"jasnell"',
    );
  });

  it("quotes every caller-controlled query fragment", () => {
    expect(buildIssueSearchQuery("cloudflare", "workerd", {
      text: "repo:cloudflare/quiche OR scheduler",
      author: "jasnell OR repo:cloudflare/quiche",
      assignee: "octocat OR repo:cloudflare/quiche",
    })).toBe(
      '"repo:cloudflare/quiche OR scheduler" repo:cloudflare/workerd is:issue '
      + 'author:"jasnell OR repo:cloudflare/quiche" assignee:"octocat OR repo:cloudflare/quiche"',
    );
  });

  it("escapes quotes inside plain search text", () => {
    expect(buildIssueSearchQuery("cloudflare", "workerd", {
      text: 'bug" OR repo:cloudflare/quiche OR "',
    })).toBe('"bug\\" OR repo:cloudflare/quiche OR \\"" repo:cloudflare/workerd is:issue');
  });
});

describe("GitHubApi.searchIssuesConditional", () => {
  it("enables GitHub advanced search parsing", async () => {
    let requestUrl: URL | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requestUrl = new URL(String(input));
      return new Response(JSON.stringify({ items: [] }), {
        headers: { "content-type": "application/json" },
      });
    }));

    const api = new GitHubApi(async () => "test-token");
    await api.searchIssuesConditional(
      "repo:cloudflare/quiche OR repo:cloudflare/workerd is:issue",
      1,
      100,
    );

    expect(requestUrl?.searchParams.get("advanced_search")).toBe("true");
  });
});

describe("GitHub Actions API", () => {
  it("lists failed runs for one workflow using bounded structured query parameters", async () => {
    let requestUrl: URL | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requestUrl = new URL(String(input));
      return Response.json({ total_count: 0, workflow_runs: [] });
    }));

    const api = new GitHubApi(async () => "test-token");
    await api.listWorkflowRuns("Original-Pictures", "DeutschtecAI", {
      branch: "main",
      event: "push",
      status: "failure",
      per_page: 30,
      page: 1,
    }, "unit-tests.yml");

    expect(requestUrl?.pathname).toBe(
      "/repos/Original-Pictures/DeutschtecAI/actions/workflows/unit-tests.yml/runs",
    );
    expect(requestUrl?.searchParams.get("status")).toBe("failure");
    expect(requestUrl?.searchParams.get("branch")).toBe("main");
    expect(requestUrl?.searchParams.get("event")).toBe("push");
    expect(requestUrl?.searchParams.get("per_page")).toBe("30");
  });

  it("downloads an individual job log without exposing the bearer token in the URL", async () => {
    let request: { url: URL; authorization: string | null } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      request = {
        url: new URL(String(input)),
        authorization: headers.get("authorization"),
      };
      return new Response("failing assertion", { status: 200 });
    }));

    const api = new GitHubApi(async () => "secret-test-token");
    await expect(api.downloadWorkflowJobLog("owner", "repo", 94404660070))
      .resolves.toBe("failing assertion");
    expect(request?.url.pathname).toBe("/repos/owner/repo/actions/jobs/94404660070/logs");
    expect(request?.url.toString()).not.toContain("secret-test-token");
    expect(request?.authorization).toBe("Bearer secret-test-token");
  });
});

describe("GitHub repository content and atomic commits", () => {
  it("encodes every repository path segment when reading content", async () => {
    let requestUrl: URL | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requestUrl = new URL(String(input));
      return Response.json({
        type: "file",
        encoding: "base64",
        content: "dGVzdA==",
        name: "spec file.ts",
        path: "src/spec file.ts",
        sha: "a".repeat(40),
        size: 4,
      });
    }));

    const api = new GitHubApi(async () => "test-token");
    await api.getContent("owner", "repo", "src/spec file.ts", "a".repeat(40));

    expect(requestUrl?.pathname).toBe("/repos/owner/repo/contents/src/spec%20file.ts");
    expect(requestUrl?.searchParams.get("ref")).toBe("a".repeat(40));
  });

  it("validates a bounded multi-file fix and blocks workflow modification", () => {
    expect(validateCommitFilesOptions({
      baseRef: "main",
      expectedBaseSha: "a".repeat(40),
      branch: "titan/ci-fix-123",
      message: "Fix failing unit test",
      files: [{ path: "src/example.ts", content: "export const fixed = true;\n" }],
    })).toMatchObject({ branch: "titan/ci-fix-123" });

    expect(() => validateCommitFilesOptions({
      baseRef: "main",
      expectedBaseSha: "a".repeat(40),
      branch: "titan/ci-fix-123",
      message: "Rewrite CI",
      files: [{ path: ".github/workflows/ci.yml", content: "jobs: {}\n" }],
    })).toThrow("cannot modify GitHub Actions workflow files");
  });

  it("rejects control characters in paths and bounds oversized job logs", () => {
    expect(() => validateRepoPath("src/bad\npath.ts")).toThrow("relative paths");

    const bounded = boundJobLog("x".repeat(600 * 1024));
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).toContain("log bytes omitted by Titan");
    expect(new TextEncoder().encode(bounded.text).byteLength).toBeLessThan(512 * 1024);
  });

  it("rejects stale or ambiguous commit inputs before queuing a write", () => {
    expect(() => validateCommitFilesOptions({
      baseRef: "main",
      expectedBaseSha: "short-sha",
      branch: "main",
      message: "Fix",
      files: [{ path: "src/example.ts", content: "fixed\n" }],
    })).toThrow("fix branch must differ");

    expect(() => validateCommitFilesOptions({
      baseRef: "main",
      expectedBaseSha: "a".repeat(40),
      branch: "titan/fix",
      message: "Fix",
      files: [
        { path: "src/example.ts", content: "one\n" },
        { path: "src/example.ts", content: "two\n" },
      ],
    })).toThrow("duplicate path");
  });
});
