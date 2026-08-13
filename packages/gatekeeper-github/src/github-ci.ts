import type { GitHubCommitFilesOptions } from "./types";

export const MAX_JOB_LOG_BYTES = 512 * 1024;
export const JOB_LOG_EDGE_BYTES = 240 * 1024;
export const MAX_TEXT_FILE_BYTES = 512 * 1024;
export const MAX_COMMIT_FILES = 20;
export const MAX_COMMIT_TOTAL_BYTES = 512 * 1024;

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REF_COMPONENT_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.?\/?(?:$|\/))(?!.*\.\.)(?!.*@\{)(?!.*[~^:?*[\\\s])(?!.*\/$)(?!.*\.lock(?:\/|$)).+$/;

/** Returns true for ASCII control characters that are unsafe in logs and approval descriptions. */
export function hasControlCharacters(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0)!;
    return code < 0x20 || code === 0x7f;
  });
}

/** Validates a repository-relative path without normalizing attacker-controlled segments. */
export function validateRepoPath(path: string): string {
  if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("\\") ||
      hasControlCharacters(path)) {
    throw new Error("Repository paths must be non-empty relative paths.");
  }
  const segments = path.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error("Repository paths cannot contain empty, '.' or '..' segments.");
  }
  return path;
}

function validateRefName(ref: string, label: string): string {
  if (!ref || !REF_COMPONENT_PATTERN.test(ref)) {
    throw new Error(`${label} is not a valid Git reference name.`);
  }
  return ref;
}

/** Validates and normalizes the bounded atomic-commit contract before an action is submitted. */
export function validateCommitFilesOptions(options: GitHubCommitFilesOptions): GitHubCommitFilesOptions {
  validateRefName(options.baseRef, "baseRef");
  validateRefName(options.branch, "branch");
  if (options.branch === options.baseRef) {
    throw new Error("The fix branch must differ from the base branch.");
  }
  if (!SHA_PATTERN.test(options.expectedBaseSha)) {
    throw new Error("expectedBaseSha must be a full 40-character Git commit SHA.");
  }
  if (!options.message.trim() || options.message.length > 10_000) {
    throw new Error("Commit messages must contain 1 to 10,000 characters.");
  }
  if (options.files.length < 1 || options.files.length > MAX_COMMIT_FILES) {
    throw new Error(`A fix commit must contain 1 to ${MAX_COMMIT_FILES} file changes.`);
  }

  const encoder = new TextEncoder();
  const seen = new Set<string>();
  let totalBytes = 0;
  const files = options.files.map(file => {
    const path = validateRepoPath(file.path);
    if (path === ".github/workflows" || path.startsWith(".github/workflows/")) {
      throw new Error("Phase 1 remediation cannot modify GitHub Actions workflow files.");
    }
    if (seen.has(path)) {
      throw new Error(`Fix commit contains duplicate path ${path}.`);
    }
    seen.add(path);
    if (file.content !== undefined) {
      totalBytes += encoder.encode(file.content).byteLength;
    }
    return { path, content: file.content };
  });
  if (totalBytes > MAX_COMMIT_TOTAL_BYTES) {
    throw new Error(`Fix commit content exceeds ${MAX_COMMIT_TOTAL_BYTES} bytes.`);
  }
  return {
    ...options,
    message: options.message.trim(),
    files,
  };
}

/** Bounds logs before they cross into agent context while retaining both failure context edges. */
export function boundJobLog(text: string): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= MAX_JOB_LOG_BYTES) {
    return { text, truncated: false };
  }
  const decoder = new TextDecoder();
  const head = decoder.decode(encoded.slice(0, JOB_LOG_EDGE_BYTES));
  const tail = decoder.decode(encoded.slice(-JOB_LOG_EDGE_BYTES));
  const omitted = encoded.byteLength - JOB_LOG_EDGE_BYTES * 2;
  return {
    text: `${head}\n\n--- ${omitted} log bytes omitted by Titan ---\n\n${tail}`,
    truncated: true,
  };
}
