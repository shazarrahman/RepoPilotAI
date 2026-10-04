import { config } from "../config.js";

const API_ROOT = "https://api.github.com";
const RAW_ROOT = "https://raw.githubusercontent.com";
const MAX_FILES = 40;
const MAX_FILE_BYTES = 150_000;
const MAX_TOTAL_BYTES = 500_000;
const ALLOWED_EXTENSIONS = new Set([
  "adoc", "bash", "c", "cc", "cpp", "cs", "css", "cxx", "go", "h", "hh", "hpp", "html", "java", "js", "jsx", "json", "kt", "md", "mdx", "mjs", "php", "py", "rb", "rs", "rst", "sass", "scala", "scss", "sh", "sql", "svelte", "swift", "toml", "ts", "tsx", "txt", "vue", "xml", "yaml", "yml",
]);
const EXCLUDED_PARTS = new Set([".git", "build", "coverage", "dist", "node_modules", "target", "vendor", "__pycache__"]);
const EXCLUDED_FILES = new Set(["bun.lockb", "bun.lock", "package-lock.json", "pnpm-lock.yaml", "poetry.lock", "yarn.lock"]);

export class GitHubImportError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export interface GitHubFile {
  path: string;
  content: string;
}

export interface GitHubRepositoryContent {
  fullName: string;
  defaultBranch: string;
  files: GitHubFile[];
  skippedFiles: number;
}

export function parseGitHubRepositoryUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new GitHubImportError("Enter a valid GitHub repository URL.", 400);
  }
  const [owner, rawRepo, ...extra] = url.pathname.split("/").filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/i, "");
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash || extra.length || !owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    throw new GitHubImportError("Use a repository URL in the form https://github.com/owner/repository.", 400);
  }
  return { owner, repo, fullName: `${owner}/${repo}` };
}

function githubFailure(response: Response, message = "") {
  const status = response.status;
  if (status === 401) return new GitHubImportError("GitHub rejected the configured or supplied access token. Check that it is valid, not expired, and scoped for this repository.", 401);
  if (status === 403 || status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (status === 429 || remaining === "0" || /rate limit|secondary rate limit/i.test(message)) {
      const resetTime = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toLocaleTimeString("en", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }) : undefined;
      return new GitHubImportError(`This repository is public and can be fetched, but GitHub temporarily rate-limited anonymous requests from this server${resetTime ? ` until around ${resetTime}` : ""}. Retry after the reset, ask the site administrator to configure GITHUB_API_TOKEN, or enter your own fine-grained token with Contents: Read-only access.`, 429);
    }
    return new GitHubImportError("GitHub refused this request. Check the token's repository access and Contents: Read-only permission.", 403);
  }
  if (status === 404) return new GitHubImportError("Repository not found. For a private repository, provide a fine-grained token with read-only Contents access.", 404);
  return new GitHubImportError(`GitHub could not read this repository (HTTP ${status}).`, 502);
}

async function githubJson<T>(url: string, accessToken?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "RepoPilotAI",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GitHubImportError("Could not reach GitHub. Check your connection and try again.", 503);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string };
    throw githubFailure(response, body.message ?? "");
  }
  return response.json() as Promise<T>;
}

function isIndexable(path: string, size: number) {
  const parts = path.split("/");
  const name = parts.at(-1)?.toLowerCase() ?? "";
  const extension = name.split(".").at(-1) ?? "";
  return size > 0 && size <= MAX_FILE_BYTES && !parts.some((part) => EXCLUDED_PARTS.has(part.toLowerCase())) && !EXCLUDED_FILES.has(name) && !/^\.env|secret|credential|private.?key|id_rsa/i.test(name) && !name.endsWith(".min.js") && !name.endsWith(".map") && ALLOWED_EXTENSIONS.has(extension);
}

function encodedPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function fetchRawText(owner: string, repo: string, branch: string, path: string) {
  const url = `${RAW_ROOT}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodedPath(branch)}/${encodedPath(path)}`;
  try {
    const response = await fetch(url, { headers: { "User-Agent": "RepoPilotAI" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const content = Buffer.from(await response.arrayBuffer());
    if (!content.length || content.length > MAX_FILE_BYTES || content.includes(0)) return null;
    const text = content.toString("utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

export async function fetchGitHubRepository(repositoryUrl: string, accessToken?: string): Promise<GitHubRepositoryContent> {
  const repository = parseGitHubRepositoryUrl(repositoryUrl);
  const token = accessToken || config.GITHUB_API_TOKEN;
  const base = `${API_ROOT}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const metadata = await githubJson<{ default_branch: string; full_name: string }>(base, token);
  const tree = await githubJson<{ truncated: boolean; tree: Array<{ path: string; type: string; size?: number; sha: string }> }>(`${base}/git/trees/${encodeURIComponent(metadata.default_branch)}?recursive=1`, token);
  if (tree.truncated) throw new GitHubImportError("This repository tree is too large to index in one pass. Try a smaller repository or sub-project.", 413);

  const candidates = tree.tree.filter((entry) => entry.type === "blob" && isIndexable(entry.path, entry.size ?? 0));
  const selected: typeof candidates = [];
  let selectedBytes = 0;
  for (const file of candidates) {
    const size = file.size ?? 0;
    if (selected.length === MAX_FILES || selectedBytes + size > MAX_TOTAL_BYTES) continue;
    selected.push(file);
    selectedBytes += size;
  }

  const files: GitHubFile[] = [];
  for (let index = 0; index < selected.length; index += 4) {
    const batch = await Promise.all(selected.slice(index, index + 4).map(async (file) => {
      const rawText = await fetchRawText(repository.owner, repository.repo, metadata.default_branch, file.path);
      if (rawText) return { path: file.path, content: rawText };
      const blob = await githubJson<{ content: string; encoding: string }>(`${base}/git/blobs/${encodeURIComponent(file.sha)}`, token);
      if (blob.encoding !== "base64") return null;
      const content = Buffer.from(blob.content, "base64").toString("utf8").replace(/\0/g, "").trim();
      return content ? { path: file.path, content } : null;
    }));
    files.push(...batch.filter((file): file is GitHubFile => file !== null));
  }
  if (!files.length) throw new GitHubImportError("No supported text or source files were found in this repository.", 400);
  return { fullName: metadata.full_name, defaultBranch: metadata.default_branch, files, skippedFiles: candidates.length - files.length };
}