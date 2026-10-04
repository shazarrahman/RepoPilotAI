import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGitHubRepository, parseGitHubRepositoryUrl } from "./github.js";

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("GitHub repository imports", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a GitHub repository URL and rejects other hosts", () => {
    expect(parseGitHubRepositoryUrl("https://github.com/acme/project.git/")).toMatchObject({ owner: "acme", repo: "project", fullName: "acme/project" });
    expect(() => parseGitHubRepositoryUrl("https://example.com/acme/project")).toThrow(/repository URL in the form/);
    expect(() => parseGitHubRepositoryUrl("https://github.com/acme/project/tree/main")).toThrow(/owner\/repository/);
  });

  it("fetches supported source files and excludes dependencies and secrets", async () => {
    const headersSeen: Array<Record<string, string>> = [];
    const apiUrls: string[] = [];
    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) {
        headersSeen.push(init?.headers as Record<string, string>);
        apiUrls.push(url);
      }
      if (url.endsWith("/repos/acme/project")) return jsonResponse({ default_branch: "main", full_name: "acme/project" });
      if (url.includes("/git/trees/")) return jsonResponse({ truncated: false, tree: [
        { type: "blob", path: "src/main.ts", size: 12, sha: "source-sha" },
        { type: "blob", path: "README.md", size: 10, sha: "readme-sha" },
        { type: "blob", path: "node_modules/pkg/index.js", size: 20, sha: "dependency-sha" },
        { type: "blob", path: ".env.example", size: 20, sha: "env-sha" },
        { type: "blob", path: "client_secret.json", size: 20, sha: "secret-sha" },
        { type: "blob", path: "image.png", size: 20, sha: "image-sha" },
      ] });
      if (url.endsWith("/git/blobs/source-sha")) return jsonResponse({ encoding: "base64", content: Buffer.from("export const answer = 42;").toString("base64") });
      if (url.endsWith("/git/blobs/readme-sha")) return jsonResponse({ encoding: "base64", content: Buffer.from("Project notes").toString("base64") });
      throw new Error(`Unexpected GitHub request: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchGitHubRepository("https://github.com/acme/project", "read-only-token");

    expect(result.files.map((file) => file.path)).toEqual(["src/main.ts", "README.md"]);
    expect(result.defaultBranch).toBe("main");
    expect(result.skippedFiles).toBe(0);
    expect(headersSeen.every((headers) => headers.Authorization === "Bearer read-only-token")).toBe(true);
    expect(apiUrls).toHaveLength(4);
  });

  it("downloads public file contents from raw hosting without spending blob API quota", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url === "https://api.github.com/repos/acme/public-project") return jsonResponse({ default_branch: "main", full_name: "acme/public-project" });
      if (url.includes("/git/trees/")) return jsonResponse({ truncated: false, tree: [{ type: "blob", path: "src/main file.ts", size: 20, sha: "source-sha" }] });
      if (url === "https://raw.githubusercontent.com/acme/public-project/main/src/main%20file.ts") return new Response("export const publicSource = true;", { status: 200 });
      throw new Error(`Unexpected GitHub request: ${url}`);
    }));

    const result = await fetchGitHubRepository("https://github.com/acme/public-project");

    expect(result.files).toEqual([{ path: "src/main file.ts", content: "export const publicSource = true;" }]);
    expect(urls.filter((url) => url.startsWith("https://api.github.com/"))).toHaveLength(2);
    expect(urls.some((url) => url.includes("/git/blobs/"))).toBe(false);
  });

  it("explains when a private repository needs a token", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse({}, 404)));
    await expect(fetchGitHubRepository("https://github.com/acme/private-project")).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringContaining("fine-grained token"),
    });
  });

  it("distinguishes public API rate exhaustion from repository permissions", async () => {
    const mockFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) },
    }));
    vi.stubGlobal("fetch", mockFetch);

    await expect(fetchGitHubRepository("https://github.com/acme/project")).rejects.toMatchObject({
      statusCode: 429,
      message: expect.stringContaining("This repository is public and can be fetched"),
    });
  });
});