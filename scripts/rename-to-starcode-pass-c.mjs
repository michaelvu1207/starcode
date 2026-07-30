#!/usr/bin/env node
/**
 * Pass C of the starcode rename: the `t3-` prefix namespace.
 *
 * Passes A and B took the compound tokens (`@t3tools/`, `T3CODE_`, `t3code`).
 * What is left is a wide, shallow namespace: CSS custom properties (`--t3-bold`),
 * Tailwind utilities (`font-t3-bold`), SVG symbol ids (`t3-file-icon-*`), OTLP
 * service names, log prefixes, and several hundred test temp-dir prefixes.
 *
 * Most of that is cosmetic, but a handful of `t3-` tokens are contracts with
 * something deployed or configured *outside this checkout*, where a rename is a
 * flag-day outage rather than a rebrand. Those are protected by line pattern:
 *
 *  - `t3-env:<id>` JWT `iss`/`aud` and the `t3-*+jwt` `typ` headers. The relay
 *    (infra/relay, deployed to Cloudflare) and the server verify these against
 *    each other. Renaming both sides still breaks every skew pair in between.
 *  - `/api/t3-connect/*`. The relay calls these paths on environment servers it
 *    did not build; the path is the contract.
 *  - `t3-relay` as a Clerk JWT template name — that record lives in the Clerk
 *    dashboard, not here.
 *  - `t3@<version>` npm specs. That is upstream's published package.
 *
 * `[t3-connect]` console prefixes are *not* protected: those are log text, and
 * only the path form carries the contract.
 *
 * Whole-token only, anchored on a word boundary, so `pingdotgg/t3code` (no
 * `t3-`) and anything with `t3` mid-word are structurally out of reach.
 *
 * Usage: node scripts/rename-to-starcode-pass-c.mjs [--dry]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const DRY = process.argv.includes("--dry");

const TOKEN = /\bt3-/g;

/** Lines that must keep the old token. See the header for why each one. */
const PROTECTED_LINE = [
  /pingdotgg/,
  /legacy/i,
  /t3-env[:-]/, //       relay <-> server JWT iss/aud, and the t3-env-*+jwt typs
  /t3-[a-z-]*\+jwt/, //  every other JWT typ header on that same wire
  /t3-connect\//, //     /api/t3-connect/* routes the relay calls by path
  // `t3-relay` names a template record in the Clerk dashboard. Protected as a
  // whole token rather than by neighbouring text: it also shows up in prose
  // ("the `t3-relay` template") and in a markdown table cell, where no keyword
  // sits on the line to key off.
  /\bt3-relay\b/,
  /t3@/, //              upstream's published npm package
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
  // Fork history: these files record the decisions that led here, including the
  // earlier decision *not* to rename. Rewriting them rewrites the record.
  /^docs\/fork\//,
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
  if (!/\bt3-/.test(before)) continue;

  let touched = false;
  const after = before
    .split("\n")
    .map((line) => {
      if (!/\bt3-/.test(line)) return line;
      if (PROTECTED_LINE.some((pattern) => pattern.test(line))) {
        protectedLines += 1;
        return line;
      }
      const next = line.replace(TOKEN, "starcode-");
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
