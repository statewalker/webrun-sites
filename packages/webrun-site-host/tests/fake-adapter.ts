import type { SiteAdapter, SiteAdapterRegistration } from "../src/types.js";

/**
 * In-memory `SiteAdapter` for tests. Captures the registered handler + key
 * so tests can invoke it directly and assert on the response without
 * touching the ServiceWorker API.
 */
export class FakeAdapter implements SiteAdapter {
  static readonly ORIGIN = "http://fake.local";

  started = false;
  stopped = false;
  key?: string;
  handler?: (request: Request) => Promise<Response>;

  constructor(readonly options: { key: string }) {
    this.key = options.key;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async register(
    prefix: string,
    handler: (request: Request) => Promise<Response>,
  ): Promise<SiteAdapterRegistration> {
    this.handler = handler;
    const clean = prefix.replace(/^[./]+/, "");
    const baseUrl = `${FakeAdapter.ORIGIN}/${clean}`;
    return {
      baseUrl,
      remove: async () => {
        this.handler = undefined;
        this.stopped = true;
      },
    };
  }

  /** Convenience: build a full URL under this adapter's baseUrl. */
  url(subPath: string): string {
    return `${FakeAdapter.ORIGIN}/${this.key}/${subPath.replace(/^\/+/, "")}`;
  }

  /** Dispatch a request through the registered handler. */
  async dispatch(subPath: string, init: RequestInit = {}): Promise<Response> {
    if (!this.handler) throw new Error("no handler registered");
    return this.handler(new Request(this.url(subPath), init));
  }
}
