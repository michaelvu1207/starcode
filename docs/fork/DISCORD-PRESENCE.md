# Discord rich presence

Fork-only. The desktop app can publish a Discord status showing how much agent work is in flight
across every connected machine — "3 agents running · across 4 connections", with a timer running
since the oldest turn started.

Off by default, and **counts only**: no project name, thread title, branch, repository, or machine
name ever crosses into the presence. A Discord presence is visible to every member of every server
you are in, so the privacy boundary is drawn at the contract
(`packages/contracts/src/discordPresence.ts`) rather than at the rendering code, and there is a test
in `apps/desktop/src/presence/discordActivity.test.ts` that fails if a name ever appears in a
rendered activity.

## Setup (one time, ~5 minutes)

Presence publishes _under a Discord application_, which is what supplies the name and artwork shown
on your profile. There is no id baked into this repo — an inherited one would put someone else's
branding on your status — so register one:

1. Go to <https://discord.com/developers/applications> → **New Application**. Name it `starcode`;
   the name is what Discord shows as the bold heading of the presence.
2. On **General Information**, copy the **Application ID**.
3. On **Rich Presence → Art Assets**, upload an image with the key `starcode`
   (`DISCORD_LARGE_IMAGE_KEY` in `apps/desktop/src/presence/discordActivity.ts`). Skipping this is
   fine — Discord silently omits unknown asset keys and the text presence still works.
4. Make the id available to the desktop app, either by:
   - setting `T3CODE_DISCORD_APP_ID` in the environment the app launches from, or
   - filling in `BUNDLED_DISCORD_APPLICATION_ID` in
     `apps/desktop/src/presence/DesktopDiscordPresence.ts` and rebuilding.
5. Launch starcode → **Settings → General → Discord presence** and turn it on.

Without an id the settings row still appears and says so; nothing connects.

## What shows up

| State                            | Presence                                            |
| -------------------------------- | --------------------------------------------------- |
| Any turn running                 | `3 agents running` / `across 4 connections` + timer |
| Nothing running, threads blocked | `2 threads need attention` / `across 4 connections` |
| Neither                          | `Idle` / `4 connections`                            |
| Nothing connected                | `Idle` / `No connections`                           |

"Needs attention" is the same three signals the sidebar's badge uses — pending approval, pending
user input, actionable proposed plan — so the two can never disagree. Archived threads are excluded;
their last turn never changes, so counting them would pin the presence forever.

## How it works

- **Renderer** (`apps/web/src/state/discordPresence.ts`) derives the counts. It has to be this side:
  the main process owns backends, not thread state, and a machine reached over SSH has no main
  process of its own. `DiscordPresencePublisher` is mounted at the app root and pushes on change.
- **Main process** (`apps/desktop/src/presence/`) owns the Discord connection. A 4-second loop
  reconnects, de-duplicates, and publishes — Discord rate-limits `SET_ACTIVITY` to roughly five
  updates per twenty seconds and silently drops the excess, so the tick _is_ the rate limiter.
- **Transport** is Discord's local IPC socket, spoken directly: an 8-byte little-endian header
  (opcode, payload length) plus UTF-8 JSON. No dependency — the published clients pull in native
  modules for a protocol that fits in a paragraph. Socket discovery covers Windows named pipes,
  macOS `TMPDIR`, Linux `XDG_RUNTIME_DIR`, and the snap/flatpak sandbox layouts.

When Discord is not running, the loop reports `waiting` and retries about every 16 seconds. That is
the normal state, not an error, and it resolves on its own the moment Discord starts.

## Notes

- The setting lives in desktop settings (per machine, `discordPresenceEnabled`), not in synced
  client settings: presence is published by the machine you are sitting at, and syncing it would
  turn it on for every other machine at the same time.
- Turning the setting off clears an already-published presence immediately rather than waiting for
  Discord to notice the socket closed.
- Only the desktop app publishes presence. The hosted web app has no way to reach a local socket,
  and the settings row hides itself there.
