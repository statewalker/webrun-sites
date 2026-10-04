/**
 * Thin wrapper around `URLPattern` that matches a `(method, path)` pair and
 * extracts named + wildcard path groups. Used by both endpoints and auth.
 *
 * Methods are compared case-insensitively; `"*"` or `"ALL"` match every
 * HTTP method.
 */
export interface RouteMatcher {
  /**
   * Run the matcher against a request. Returns extracted params (possibly
   * empty) on match, or `null` on no match.
   */
  match(request: Request): Record<string, string> | null;
}

export function newRouteMatcher(pattern: string, method: string = "*"): RouteMatcher {
  const urlPattern = new URLPattern({ pathname: pattern });
  const normalizedMethod = method.toUpperCase();
  const matchesAny = normalizedMethod === "*" || normalizedMethod === "ALL";
  return {
    match(request: Request): Record<string, string> | null {
      if (!matchesAny && request.method.toUpperCase() !== normalizedMethod) return null;
      const result = urlPattern.exec(new URL(request.url));
      if (!result) return null;
      const groups = result.pathname.groups ?? {};
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(groups)) {
        if (value !== undefined) params[key] = value;
      }
      return params;
    },
  };
}
