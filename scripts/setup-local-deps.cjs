/**
 * dsh-opencode-go — local-source install helper.
 *
 * `dsh plugin add <local-dir>` installs via pnpm `link:`: the profile's
 * node_modules entry is just a junction back at the source tree, so Node
 * resolves the host half's `@deepseek-ai/*` peer imports upward from the
 * REAL source path — where no `@deepseek-ai/*` exists — and dsh dies at
 * loader import time with `Cannot find package '@deepseek-ai/schemastery'`.
 * (Registry/github installs don't hit this: pnpm materializes peers into
 * the package's own `.pnpm` store.)
 *
 * This script bridges that gap by linking
 *   <plugin>/node_modules/@deepseek-ai
 *     -> <dsh host tree>/node_modules/@deepseek-ai
 * as a Windows junction (`junction` needs no elevation, unlike symlinks).
 * The bridge lives under git-ignored `node_modules/`, affects only this
 * machine, and keeps a single copy of every host package (no duplicate
 * `LlmAdapter` base class, so `instanceof` keeps working).
 *
 * Usage:
 *   node scripts/setup-local-deps.cjs [--host <dir>] [--dry-run]
 *
 * `--host` accepts the dsh install root, its `node_modules`, or the
 * `@deepseek-ai` directory itself; without it the script probes `npm
 * root -g`, the `dsh` launcher location, and well-known install paths
 * (including the EAC desktop layout). A candidate wins when
 * `@deepseek-ai/dsh-llm/package.json` exists under it.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const LINK_PATH = path.join(PLUGIN_ROOT, "node_modules", "@deepseek-ai");
const PROBE_PACKAGE = path.join("@deepseek-ai", "dsh-llm", "package.json");

/** Normalize a user/env candidate to the node_modules dir holding `@deepseek-ai`. */
function normalizeCandidate(raw) {
  if (!raw) return null;
  const dir = path.resolve(raw);
  const bases = [dir];
  if (path.basename(dir) === "@deepseek-ai") {
    // The candidate IS the scope dir: dsh-llm sits directly inside it.
    try {
      if (fs.existsSync(path.join(dir, "dsh-llm", "package.json"))) return path.dirname(dir);
    } catch {}
    bases.push(path.dirname(dir));
  } else if (path.basename(dir) !== "node_modules") {
    bases.push(path.join(dir, "node_modules"));
    bases.push(path.join(dir, "dsh-desktop", "node_modules"));
  }
  // Some installs nest the tree: <root>/node_modules/@deepseek-ai/dsh/node_modules.
  const nested = [path.join(dir, "node_modules", "@deepseek-ai", "dsh", "node_modules"), path.join(dir, "dsh", "node_modules")];
  for (const nm of [...bases, ...nested]) {
    try {
      if (fs.existsSync(path.join(nm, PROBE_PACKAGE))) return nm;
    } catch {}
  }
  return null;
}

function probeHostNodeModules() {
  const tried = [];
  const consider = (raw) => {
    if (!raw) return null;
    tried.push(raw);
    try {
      return normalizeCandidate(raw);
    } catch {
      return null;
    }
  };
  // 1. Explicit override wins (flag or env).
  const argvHost = (() => {
    const i = process.argv.indexOf("--host");
    return i !== -1 ? process.argv[i + 1] : undefined;
  })();
  let hit = consider(argvHost) ?? consider(process.env.DSH_HOST_NODE_MODULES);
  if (hit) return { hit, tried };
  // 2. Global npm root: `npm root -g` sits above `@deepseek-ai/dsh`.
  // 3. Next to the `dsh` launcher itself (npm shim, deepseek-harness bin).
  try {
    const npmRoots = new Set();
    try {
      npmRoots.add(execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    } catch {}
    try {
      npmRoots.add(execFileSync("npm", ["root"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    } catch {}
    for (const npmRoot of npmRoots) {
      hit = consider(npmRoot);
      if (hit) return { hit, tried };
      // The dsh wrapper package may sit one level deeper (@deepseek-ai/dsh).
      hit = consider(path.join(npmRoot, "@deepseek-ai", "dsh"));
      if (hit) return { hit, tried };
    }
  } catch {}
  // 3. Next to the `dsh` launcher itself.
  try {
    const where = os.platform() === "win32" ? "where" : "which";
    const launchers = execFileSync(where, ["dsh"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const launcher of launchers) {
      let dir = path.dirname(launcher);
      // npm shims (.cmd) live beside node_modules, not inside it — step out first.
      for (let depth = 0; depth < 5 && !hit; depth++) {
        hit = consider(dir);
        dir = path.dirname(dir);
      }
      if (hit) return { hit, tried };
    }
  } catch {}
  // 4. Well-known install layouts (EAC desktop, npm globals, nvm).
  const home = os.homedir();
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? "", "Deepseek Harness EAC", "dsh-desktop", "node_modules"),
    path.join(process.env.APPDATA ?? "", "npm", "node_modules"),
    path.join("D:", "software", "nodejs", "node_modules"),
  ];
  const nvm = process.env.NVM_HOME ?? process.env.NVM_SYMLINK;
  if (nvm) candidates.push(path.join(nvm, "node_modules"));
  for (const c of candidates) {
    hit = consider(c);
    if (hit) return { hit, tried };
  }
  return { hit: null, tried };
}

function main() {
  if (require.main !== module) return;
  const dryRun = process.argv.includes("--dry-run");
  const { hit, tried } = probeHostNodeModules();
  if (!hit) {
    console.error("setup-local-deps: could not locate the dsh host dependency tree.");
    if (tried.length > 0) console.error(`probed:\n  ${tried.join("\n  ")}`);
    console.error('pass it explicitly: node scripts/setup-local-deps.cjs --host "<dsh-install>/node_modules"');
    process.exitCode = 1;
    return;
  }
  const target = path.join(hit, "@deepseek-ai");
  console.log(`setup-local-deps: host tree: ${hit}`);
  console.log(`setup-local-deps: bridge:   ${LINK_PATH} -> ${target}`);
  let existing = null;
  try {
    existing = fs.readlinkSync(LINK_PATH);
  } catch {}
  if (existing) {
    const same = path.resolve(path.dirname(LINK_PATH), existing) === path.resolve(target);
    console.log(`setup-local-deps: bridge already exists (${same ? "correct, nothing to do" : "points elsewhere — remove node_modules/@deepseek-ai and re-run"})`);
    if (!same) process.exitCode = 1;
    return;
  }
  if (dryRun) {
    console.log("setup-local-deps: --dry-run, link not created.");
    return;
  }
  fs.mkdirSync(path.dirname(LINK_PATH), { recursive: true });
  fs.symlinkSync(target, LINK_PATH, "junction");
  // Prove the import that killed EAC boots now resolves from the real path.
  const resolved = require.resolve("@deepseek-ai/dsh-llm/package.json", { paths: [path.join(PLUGIN_ROOT, "lib")] });
  console.log(`setup-local-deps: bridge created; dsh-llm resolves to ${resolved}`);
}

main();

module.exports = { normalizeCandidate, probeHostNodeModules, PLUGIN_ROOT, LINK_PATH };
