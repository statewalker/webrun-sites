import { describe, expect, it } from "vitest";
import { newBasicAuth } from "../src/basic-auth.js";

function authHeader(username: string, password: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`${username}:${password}`)}` };
}

describe("newBasicAuth", () => {
  const predicate = newBasicAuth({ tom: "!jerry!", bob: "*marley*" });

  it("returns a 401 when the Authorization header is missing", async () => {
    const response = await predicate(new Request("http://x/admin"));
    expect(response?.status).toBe(401);
    expect(response?.headers.get("WWW-Authenticate")).toMatch(/^Basic realm=/);
  });

  it("accepts a valid username + password pair", async () => {
    const request = new Request("http://x/admin", { headers: authHeader("tom", "!jerry!") });
    const response = await predicate(request);
    expect(response).toBeUndefined();
  });

  it("rejects a wrong password for a known user", async () => {
    const request = new Request("http://x/admin", { headers: authHeader("tom", "nope") });
    const response = await predicate(request);
    expect(response?.status).toBe(401);
  });

  it("rejects an unknown username", async () => {
    const request = new Request("http://x/admin", { headers: authHeader("eve", "whatever") });
    const response = await predicate(request);
    expect(response?.status).toBe(401);
  });

  it("rejects a non-Basic Authorization scheme", async () => {
    const request = new Request("http://x/admin", {
      headers: { Authorization: "Bearer some-token" },
    });
    const response = await predicate(request);
    expect(response?.status).toBe(401);
  });

  it("rejects garbage base64", async () => {
    const request = new Request("http://x/admin", { headers: { Authorization: "Basic !!!" } });
    const response = await predicate(request);
    expect(response?.status).toBe(401);
  });

  it("handles UTF-8 passwords correctly (RFC 7617 charset=UTF-8)", async () => {
    // Browsers encode non-ASCII credentials as UTF-8 bytes then base64 — not
    // as Latin-1. Replicate that explicitly so the test reflects the wire.
    const utf8 = new TextEncoder().encode("alice:päßwörd");
    const base64 = btoa(String.fromCharCode(...utf8));
    const p = newBasicAuth({ alice: "päßwörd" });
    const request = new Request("http://x/admin", {
      headers: { Authorization: `Basic ${base64}` },
    });
    expect(await p(request)).toBeUndefined();
  });

  it("puts the configured realm in the challenge", async () => {
    const p = newBasicAuth({ u: "p" }, { realm: "Dashboard" });
    const response = await p(new Request("http://x/admin"));
    expect(response?.headers.get("WWW-Authenticate")).toContain('realm="Dashboard"');
  });

  it("each rejection returns a fresh Response (no body reuse)", async () => {
    const first = await predicate(new Request("http://x/admin"));
    const second = await predicate(new Request("http://x/admin"));
    expect(first).not.toBe(second);
    expect(await first?.text()).toBe("Unauthorized");
    expect(await second?.text()).toBe("Unauthorized");
  });
});
