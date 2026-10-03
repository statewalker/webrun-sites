import { describe, expect, it } from "vitest";
import { getMimeType } from "../src/mime.js";

describe("getMimeType", () => {
  it("resolves common web extensions", () => {
    expect(getMimeType("index.html")).toBe("text/html; charset=utf-8");
    expect(getMimeType("app.js")).toBe("text/javascript; charset=utf-8");
    expect(getMimeType("style.css")).toBe("text/css; charset=utf-8");
    expect(getMimeType("data.json")).toBe("application/json; charset=utf-8");
  });

  it("falls back to application/octet-stream for unknown extensions", () => {
    expect(getMimeType("weird.xyz")).toBe("application/octet-stream");
  });

  it("falls back to application/octet-stream for extensionless paths", () => {
    expect(getMimeType("README")).toBe("application/octet-stream");
  });

  it("is case-insensitive on the extension", () => {
    expect(getMimeType("PHOTO.JPG")).toBe("image/jpeg");
  });

  it("uses the last dot in a multi-dot name", () => {
    expect(getMimeType("archive.tar.gz")).toBe("application/octet-stream");
    expect(getMimeType("source.min.js")).toBe("text/javascript; charset=utf-8");
  });
});
