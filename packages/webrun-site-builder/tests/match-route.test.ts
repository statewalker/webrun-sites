import { describe, expect, it } from "vitest";
import { newRouteMatcher } from "../src/match-route.js";

describe("newRouteMatcher", () => {
  it("matches exact pathnames with no params", () => {
    const matcher = newRouteMatcher("/api/health");
    expect(matcher.match(new Request("http://x/api/health"))).toEqual({});
    expect(matcher.match(new Request("http://x/api/other"))).toBeNull();
  });

  it("extracts named pathname params", () => {
    const matcher = newRouteMatcher("/todo/:id");
    expect(matcher.match(new Request("http://x/todo/42"))?.id).toBe("42");
  });

  it("extracts multiple named params", () => {
    const matcher = newRouteMatcher("/users/:uid/posts/:pid");
    expect(matcher.match(new Request("http://x/users/1/posts/9"))).toEqual({
      uid: "1",
      pid: "9",
    });
  });

  it("captures wildcard tail as index '0'", () => {
    const matcher = newRouteMatcher("/static/*");
    const params = matcher.match(new Request("http://x/static/css/style.css"));
    expect(params).toEqual({ "0": "css/style.css" });
  });

  it("restricts to the configured method when not wildcard", () => {
    const matcher = newRouteMatcher("/api/data", "POST");
    expect(matcher.match(new Request("http://x/api/data", { method: "POST" }))).toEqual({});
    expect(matcher.match(new Request("http://x/api/data"))).toBeNull();
  });

  it("allows any method for '*' and 'ALL'", () => {
    const any = newRouteMatcher("/api", "*");
    const all = newRouteMatcher("/api", "ALL");
    for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
      expect(any.match(new Request("http://x/api", { method }))).toEqual({});
      expect(all.match(new Request("http://x/api", { method }))).toEqual({});
    }
  });

  it("compares methods case-insensitively", () => {
    const matcher = newRouteMatcher("/api", "post");
    expect(matcher.match(new Request("http://x/api", { method: "POST" }))).toEqual({});
  });

  it("ignores query strings during matching", () => {
    const matcher = newRouteMatcher("/search");
    expect(matcher.match(new Request("http://x/search?q=test"))).toEqual({});
  });
});
