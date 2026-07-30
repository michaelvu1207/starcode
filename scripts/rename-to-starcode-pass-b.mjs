#!/usr/bin/env node
/**
 * Pass B of the starcode rename: the `t3code` / `t3tools` tokens.
 *
 * Split out from pass A because these two tokens are where the *deliberate*
 * leftovers live. Several places must keep saying `t3code` forever:
 *
 *  - `pingdotgg/t3code` is the upstream repository.
 *  - the migration sources (`legacyUserDataDirNames`, `LEGACY_PROJECT_FILE_NAME`)
 *    exist precisely to read the old names.
 *  - `t3code://app` stays in the CORS allowlist and in the registered scheme
 *    list so clients installed before the rename keep working.
 *
 * A blanket pass would erase exactly the compatibility this rename depends on,
 * so every one of those is protected by line pattern rather than by hoping the
 * token never appears.
 *
 * Usage: node scripts/rename-to-starcode-pass-b.mjs [--dry]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const DRY = process.argv.includes("--dry");

const REPLACEMENTS = [
  ["t3code", "starcode"],
  ["t3tools", "starcode"],
];

/**
 * Lines that must keep the old token. Order of concerns:
 * upstream identity, migration sources, and backward-compatible registrations.
 */
const PROTECTED_LINE = [
  /pingdotgg/,
  /legacy/i, // legacyUserDataDirNames, LEGACY_PROJECT_FILE_NAME, and their tests
  /T3 Code \((Alpha|Dev)\)/, // the oldest user-data names, on the same line as their list
];

/**
 * Backward-compatible registrations, protected by file *and* pattern.
 *
 * Deliberately narrow. Protecting every line that merely mentions `t3code://`
 * would also freeze the launcher's own scheme registration and the dev-setup
 * docs, which must move to the new scheme or dev deep links stop resolving.
 */
const PROTECTED_IN_FILE = [
  [/^apps\/server\/src\/(http|server\.test)\.ts$/, /t3code(-dev)?:\/\/app/],
  [/^scripts\/build-desktop-artifact(\.test)?\.ts$/, /"t3code(-dev)?"/],
  // Repository-name fixtures. Their paired assertions are protected by the
  // upstream-URL rule, so renaming only the input desynchronises the test.
  [/^apps\/server\/src\/git\/GitManager\.test\.ts$/, /binbandit\/t3code/],
  [/^apps\/server\/src\/sourceControl\/BitbucketApi\.test\.ts$/, /owner\/t3code/],
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
  /^apps\/mobile\//, // owned by the native-module rename running separately
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
  if (!/t3code|t3tools/.test(before)) continue;

  let touched = false;
  const after = before
    .split("\n")
    .map((line) => {
      if (!/t3code|t3tools/.test(line)) return line;
      const fileScoped = PROTECTED_IN_FILE.some(
        ([filePattern, linePattern]) => filePattern.test(path) && linePattern.test(line),
      );
      if (fileScoped || PROTECTED_LINE.some((pattern) => pattern.test(line))) {
        protectedLines += 1;
        return line;
      }
      let next = line;
      for (const [from, to] of REPLACEMENTS) next = next.split(from).join(to);
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
