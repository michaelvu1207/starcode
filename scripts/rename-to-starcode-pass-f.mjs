#!/usr/bin/env node
/**
 * Pass F of the starcode rename: identifiers, env vars, and metric names that
 * the earlier passes' patterns could not see.
 *
 * Passes A–E keyed off `t3code`, `t3tools`, `T3CODE_`, `T3 `, and `t3-`. That
 * leaves camel/Pascal identifiers where `t3` sits against a letter rather than a
 * separator (`t3Home`, `RemoteT3RunnerOptions`), a `T3_` env prefix that is not
 * `T3CODE_`, and the `t3_` OTLP metric namespace.
 *
 * This pass uses an EXPLICIT token map rather than a pattern, because the
 * obvious pattern is actively dangerous here: `\bT3[A-Z]` also matches inside
 * the base64 credential fixtures in the server tests
 * (`T3YfsSKTJHIkAoMbEagmFU43hnHP62Cn…`), and rewriting one of those silently
 * changes a test's input without changing its expectation.
 *
 * Two tokens are deliberately absent from the map:
 *
 *  - `t3_session` — the session cookie name (`auth/utils.ts`). Renaming a cookie
 *    key does not migrate it; every browser and desktop renderer holding a
 *    session would present a cookie the server no longer reads, i.e. a silent
 *    mass logout, in exchange for a name nobody sees.
 *  - `t3SessionLoadReady` — an ACP `_meta` vendor key. Renamed separately once
 *    it was clear the value is fabricated and consumed locally.
 *  - `t3env_` — the prefix of environment credential tokens the relay mints
 *    (`EnvironmentCredentials.ts`). Every credential already issued to a paired
 *    environment carries it, so the prefix is a live format, not a label.
 *
 * Usage: node scripts/rename-to-starcode-pass-f.mjs [--dry]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const DRY = process.argv.includes("--dry");

/**
 * Longest first: `T3ServerConfig` must be rewritten before `T3Server`, or the
 * shorter rule wins and leaves `StarcodeServerConfig` spelled inconsistently.
 */
const REPLACEMENTS = [
  // identifiers
  ["ConfiguredT3ConnectSidebarAvatar", "ConfiguredStarcodeConnectSidebarAvatar"],
  ["resolveRemoteT3CliPackageSpec", "resolveRemoteStarcodeCliPackageSpec"],
  ["devRemoteT3ServerEntryPath", "devRemoteStarcodeServerEntryPath"],
  ["buildRemoteT3RunnerScript", "buildRemoteStarcodeRunnerScript"],
  ["RemoteT3RunnerOptions", "RemoteStarcodeRunnerOptions"],
  ["T3ConnectSidebarAvatar", "StarcodeConnectSidebarAvatar"],
  ["parentEnvWithoutT3Home", "parentEnvWithoutStarcodeHome"],
  ["T3ShowcaseReadyScene", "StarcodeShowcaseReadyScene"],
  ["T3ShowcaseScene", "StarcodeShowcaseScene"],
  ["T3ServerConfig", "StarcodeServerConfig"],
  ["T3Server", "StarcodeServer"],
  ["RemoteT3", "RemoteStarcode"],
  ["t3EntryPath", "starcodeEntryPath"],
  ["t3MintCredential", "starcodeMintCredential"],
  ["t3CodeVersion", "starcodeVersion"],
  ["t3Home", "starcodeHome"],
  // env vars — `T3_`, which the pass-A `T3CODE_` rule never matched
  ["T3_SHOWCASE_", "STARCODE_SHOWCASE_"],
  ["T3_FILE_ICON_SPRITE", "STARCODE_FILE_ICON_SPRITE"],
  // OTLP metric names. Renaming these breaks continuity of the existing series
  // in the tracing backend — the old name keeps its history, the new name starts
  // empty. Nothing functional depends on them.
  ["t3_db_", "starcode_db_"],
  ["t3_git_", "starcode_git_"],
  ["t3_orchestration_", "starcode_orchestration_"],
  ["t3_provider_", "starcode_provider_"],
  ["t3_rpc_", "starcode_rpc_"],
  ["t3_terminal_", "starcode_terminal_"],
  ["t3_relay", "starcode_relay"],
];

const PROTECTED_LINE = [/pingdotgg/, /legacy/i];

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
];

const isBinary = (buffer) => buffer.includes(0);
const matcher = new RegExp(REPLACEMENTS.map(([from]) => from).join("|"));

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
  if (!matcher.test(before)) continue;

  let touched = false;
  const after = before
    .split("\n")
    .map((line) => {
      if (!matcher.test(line)) return line;
      if (PROTECTED_LINE.some((pattern) => pattern.test(line))) {
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
