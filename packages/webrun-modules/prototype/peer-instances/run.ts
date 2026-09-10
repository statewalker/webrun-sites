/** PROTOTYPE — `pnpm proto:peers`. Runs every experiment in order. */
await import("./exp1-lock.js");
await import("./exp2-instances.js");
await import("./exp3-restart.js");
