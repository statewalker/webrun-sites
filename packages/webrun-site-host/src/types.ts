import type { FilesApi } from "@statewalker/webrun-files";

/**
 * A `FilesApi` instance or a plain path → content map. When a record is
 * given, `HostedSiteBuilder` wraps it in a fresh `MemFilesApi` during
 * `.build()`. Values can be strings or `Uint8Array`.
 */
export type FilesSource = FilesApi | Record<string, string | Uint8Array>;

/**
 * The running-site handle returned by `HostedSiteBuilder.build()`.
 */
export interface HostedSite {
  /** Service key the site was registered under (generated if not set explicitly). */
  readonly siteKey: string;
  /** Absolute site base URL, e.g. `http://localhost:5173/demo/`. */
  readonly baseUrl: string;
  /**
   * Remove the handler from the adapter's routing table and tear down the
   * adapter (if it exposes a `stop()` method). Symmetric counterpart to
   * `.build()`: after `stop()`, the site is fully detached.
   */
  stop(): Promise<void>;
}

/**
 * Minimal interface the builder needs from the underlying adapter.
 * `SwHttpAdapter` from `@statewalker/webrun-http-browser/sw` satisfies this
 * out of the box; tests can inject a fake.
 */
export interface SiteAdapter {
  start(): Promise<void>;
  register(
    prefix: string,
    handler: (request: Request) => Promise<Response>,
  ): Promise<SiteAdapterRegistration>;
  /**
   * Optional teardown hook. `HostedSite.stop()` calls this after
   * `registration.remove()` so the adapter's own resources (SW listeners,
   * IndexedDB bookkeeping, …) are released.
   */
  stop?(): Promise<void>;
}

export interface SiteAdapterRegistration {
  baseUrl: string;
  remove(): Promise<void>;
}

/**
 * Factory that builds a `SiteAdapter` from a key + SW URL. Defaults to
 * `new SwHttpAdapter(...)`; swap for testing or to plug in a different
 * transport.
 */
export type AdapterFactory = (options: { key: string; serviceWorkerUrl: string }) => SiteAdapter;
