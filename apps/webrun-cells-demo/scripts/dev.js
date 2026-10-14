import { spawn } from "node:child_process";
import "./copy-assets.js";

const bin = (name) => new URL(`../node_modules/.bin/${name}`, import.meta.url).pathname;
const children = [
  spawn(bin("rolldown"), ["-c", "--watch"], { stdio: "inherit" }),
  spawn(bin("tailwindcss"), ["-i", "src/styles.css", "-o", "dist/styles.css", "--watch"], {
    stdio: "inherit",
  }),
  spawn(bin("sirv"), ["dist", "--dev", "--port", "5180"], { stdio: "inherit" }),
];

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
