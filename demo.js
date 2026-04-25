// Convenience launcher: spawn the provider, wait for it to be ready,
// run the buyer once, then keep the provider running so judges can hit it.
//
// Run: node demo.js

import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

const log = (tag, line, color = "245") =>
  process.stdout.write(`\x1b[38;5;${color}m[${tag.padEnd(8)}]\x1b[0m ${line}\n`);

// ─── start provider ──────────────────────────────────────────────────
log("demo", "starting provider on :3000 …", "214");
const provider = spawn("npm", ["run", "dev", "--prefix", "provider"], {
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
});

let ready = false;
const onLine = (chunk) => {
  const lines = chunk.toString().split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    log("provider", line, "245");
    if (!ready && /Ready in|started server|Local:.*3000/.test(line)) ready = true;
  }
};
provider.stdout.on("data", onLine);
provider.stderr.on("data", onLine);

// ─── wait for ready, with a sane timeout ─────────────────────────────
const deadline = Date.now() + 30_000;
while (!ready && Date.now() < deadline) await wait(250);
if (!ready) {
  log("demo", "provider did not become ready in 30s; aborting.", "203");
  provider.kill();
  process.exit(1);
}

await wait(500); // route compile breathing room
const flow = process.argv[2] === "multi" ? "demo:multi" : "demo";
log("demo", `running buyer (${flow}) …`, "87");

// ─── run buyer once ──────────────────────────────────────────────────
const buyer = spawn("npm", ["run", flow, "--prefix", "buyer"], { shell: true, stdio: "inherit" });
buyer.on("exit", (code) => {
  log("demo", `buyer exited with code ${code}.`, code === 0 ? "120" : "203");
  log("demo", "provider still running on http://localhost:3000  (Ctrl+C to stop)", "214");
});

// keep the provider alive on Ctrl+C
process.on("SIGINT", () => { provider.kill(); process.exit(0); });
