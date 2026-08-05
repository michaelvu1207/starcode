#!/usr/bin/env node
/**
 * Pass G of the starcode rename: bare lowercase `t3`.
 *
 * This is the pass the plan warned about, so it is deliberately the narrowest
 * one. It never touches `t3` in general — only two shapes:
 *
 *   1. `t3 ` followed by a space: the CLI's own name in invocations printed to
 *      users (`t3 connect link`, `t3 service install`) and in prose about the
 *      product ("t3 ships with…"). The binary is `starcode` now, so an
 *      instruction saying `t3 connect` names a command that does not exist.
 *   2. `.t3/` as a path segment: the server home, which moved to `~/.starcode`
 *      with a copy-forward migration.
 *
 * Everything else keeps bare `t3`, either because it is not ours or because
 * renaming it breaks something that cannot be migrated:
 *
 *   - `t3@<version>` and `node_modules/t3/` — upstream's published npm package.
 *   - `t3.codes`, `t3.chat`, `t3.sh`, `t3.tools`, `t3tools.com` — domains, which
 *     are explicitly out of scope for this rename.
 *   - `pingdotgg/t3code`, `t3dotgg` — the upstream repo and a person's handle.
 *   - `~/.t3` inside `os-jank.ts` — that file *is* the migration; it has to keep
 *     naming the old home in order to find it.
 *   - `t3_session` — the session cookie name. See pass F.
 *
 * Usage: node scripts/rename-to-starcode-pass-g.mjs [--dry]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const DRY = process.argv.includes("--dry");

const REPLACEMENTS = [
  [/\bt3 /g, "starcode "],
  [/\.t3\//g, ".starcode/"],
];

const PROTECTED_LINE = [
  /pingdotgg|t3dotgg/,
  /legacy/i,
  /t3@/, //                       npm spec for upstream's package
  /node_modules[/\\]t3\b/, //     the installed upstream package
  /t3\.(codes|chat|sh|tools)/, // domains, out of scope
  /t3tools\.com/,
];

const PROTECTED_PATH = [
  /^\.repos\//,
  /^pnpm-lock\.yaml$/,
  /(^|\/)CHANGELOG[^/]*$/i,
  /^scripts\/rename-to-starcode/,
  // Historical archives. These record decisions as they were made, including
  // absolute paths on other developers' machines; rewriting them makes a record
  // of the past wrong rather than rebranding anything.
  /^\.plans\//,
  /^docs\/fork\//,
  // The `~/.t3` migration source, and the .gitignore / Metro entries that
  // deliberately list both state-dir names. All hand-written.
  /^apps\/server\/src\/os-jank\.ts$/,
  /^\.gitignore$/,
  /^apps\/mobile\/metro\.config\.js$/,
];

const isBinary = (buffer) => buffer.includes(0);

const files = NodeChildProcess.execFileSync("git", ["ls-files", "-z"], { maxBuffer: 1 << 28 })
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((path) => !PROTECTED_PATH.some((pattern) => pattern.test(path)));

let changedFiles = 0;
let changedLines = 0;
let protectedLines = 0;

for (const path of files) {
  let raw;
  try {
    if (!NodeFS.statSync(path).isFile()) continue;
    raw = NodeFS.readFileSync(path);
  } catch {
    continue;
  }
  if (isBinary(raw)) continue;

  const before = raw.toString("utf8");
  if (!/\bt3 |\.t3\//.test(before)) continue;

  let touched = false;
  const after = before
    .split("\n")
    .map((line) => {
      if (!/\bt3 |\.t3\//.test(line)) return line;
      if (PROTECTED_LINE.some((pattern) => pattern.test(line))) {
        protectedLines += 1;
        return line;
      }
      let next = line;
      for (const [from, to] of REPLACEMENTS) next = next.replace(from, to);
      if (next !== line) {
        changedLines += 1;
        touched = true;
      }
      return next;
    })
    .join("\n");

  if (touched) {
    changedFiles += 1;
    if (!DRY) NodeFS.writeFileSync(path, after, "utf8");
  }
}

console.log(
  `${DRY ? "[dry] " : ""}${changedFiles} files, ${changedLines} lines rewritten, ` +
    `${protectedLines} protected lines kept on the old token`,
);
