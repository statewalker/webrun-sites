import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { newServeFiles } from "../src/serve-files.js";

async function populate(
  api: MemFilesApi,
  entries: Record<string, string | Uint8Array>,
): Promise<void> {
  for (const [path, content] of Object.entries(entries)) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await api.write(path, [bytes]);
  }
}

describe("newServeFiles", () => {
  let api: MemFilesApi;
  beforeEach(() => {
    api = new MemFilesApi();
  });

  it("streams a file with the right Content-Type and Content-Length", async () => {
    await populate(api, { "/index.html": "<h1>ok</h1>" });
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/"), "/index.html");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Length")).toBe("11");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await response.text()).toBe("<h1>ok</h1>");
  });

  it("returns 404 for a missing path", async () => {
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/"), "/missing.txt");
    expect(response.status).toBe(404);
  });

  it("serves directoryIndex when the path resolves to a folder", async () => {
    await populate(api, { "/site/index.html": "<p>home</p>" });
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/"), "/site");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe("<p>home</p>");
  });

  it("honours a custom directoryIndex", async () => {
    await populate(api, { "/d/start.html": "<p>start</p>" });
    const serve = newServeFiles(api, { directoryIndex: "start.html" });
    const response = await serve(new Request("http://x/"), "/d");
    expect(await response.text()).toBe("<p>start</p>");
  });

  it("returns 404 for a directory with no index", async () => {
    await populate(api, { "/empty/other.txt": "hi" });
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/"), "/empty");
    expect(response.status).toBe(404);
  });

  it("HEAD returns the headers but no body", async () => {
    await populate(api, { "/a.txt": "hello" });
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/", { method: "HEAD" }), "/a.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("5");
    expect(response.body).toBeNull();
  });

  it("rejects unsupported methods with 405 + Allow header", async () => {
    const serve = newServeFiles(api);
    const response = await serve(new Request("http://x/", { method: "POST" }), "/a.txt");
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
  });

  it("serves a Range: bytes=<start>-<end> slice as 206 Partial Content", async () => {
    await populate(api, { "/data.bin": new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) });
    const serve = newServeFiles(api);
    const request = new Request("http://x/", { headers: { Range: "bytes=2-5" } });
    const response = await serve(request, "/data.bin");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(response.headers.get("Content-Length")).toBe("4");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes)).toEqual([3, 4, 5, 6]);
  });

  it("handles a suffix range (bytes=-N)", async () => {
    await populate(api, { "/data.bin": new Uint8Array([1, 2, 3, 4, 5]) });
    const serve = newServeFiles(api);
    const response = await serve(
      new Request("http://x/", { headers: { Range: "bytes=-2" } }),
      "/data.bin",
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 3-4/5");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes)).toEqual([4, 5]);
  });

  it("handles an open-ended range (bytes=N-)", async () => {
    await populate(api, { "/data.bin": new Uint8Array([1, 2, 3, 4, 5]) });
    const serve = newServeFiles(api);
    const response = await serve(
      new Request("http://x/", { headers: { Range: "bytes=3-" } }),
      "/data.bin",
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 3-4/5");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes)).toEqual([4, 5]);
  });

  it("rejects an out-of-bounds range with 416", async () => {
    await populate(api, { "/data.bin": new Uint8Array([1, 2, 3]) });
    const serve = newServeFiles(api);
    const response = await serve(
      new Request("http://x/", { headers: { Range: "bytes=10-20" } }),
      "/data.bin",
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */3");
  });

  it("allows a custom MIME resolver", async () => {
    await populate(api, { "/weird.abc": "hello" });
    const serve = newServeFiles(api, {
      getMimeType: () => "application/x-test",
    });
    const response = await serve(new Request("http://x/"), "/weird.abc");
    expect(response.headers.get("Content-Type")).toBe("application/x-test");
  });
});
