/**
 * The storage port the prototypes keep their durable state in — the same one
 * the real engine (`@statewalker/webrun-builder`) uses: an ordered key-value
 * store with prefix scans and atomic multi-key commits (optionally
 * conditional per write), with I/O counters in `MemKV`, and `CrashingKV` to
 * kill the process before the N-th commit. Prototypes and the engine are
 * measured on equal footing.
 */
export {
  CrashError,
  CrashingKV,
  emptyMetrics,
  type KV,
  type KvMetrics,
  type KvWrite,
  MemKV,
} from "@statewalker/webrun-builder";
