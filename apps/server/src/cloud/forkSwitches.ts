/**
 * Fork-only behaviour switches. This file does not exist upstream, so it never
 * conflicts on a merge - keep every deliberate divergence from upstream
 * behaviour declared here rather than buried as a deletion.
 */

/**
 * Refuse every path that would replace this fork's server with upstream's
 * published build.
 *
 * This fork ships under upstream's package name `t3`, so every install path
 * runs `npm install t3@<version>` against the PUBLIC registry
 * (pinnedRuntime.ts) and then points a systemd unit or a respawned process at
 * the resulting node_modules/t3 tree - upstream's code, not ours. Two entry
 * points reach it:
 *
 * 1. The version-skew banner's "Update server" button, via the
 *    serverSelfUpdate capability. The banner fires on any version-string
 *    inequality, including every dev build, so that click is always one stray
 *    tap away.
 * 2. `starcode service install` / `starcode service update` and the onboarding prompt,
 *    when the CLI itself was launched from an ephemeral npx/dlx/bunx cache.
 *
 * With this on, the capability resolves to null (client degrades to "Copy
 * update command", update RPC rejects) and the npm install refuses outright.
 * Service management from a stable checkout is untouched: that path never
 * calls npm, so it still points the unit at this fork's own artifact.
 *
 * Turn this off only once the published package name is no longer upstream's.
 */
export const FORK_DISABLE_SELF_UPDATE: boolean = true;
