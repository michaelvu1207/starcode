# starcode — a fork of starcode

> **This repository is `michaelvu1207/starcode`, a personal fork of
> [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code).** It is not affiliated with or endorsed
> by T3 Tools. Everything below this banner is upstream's README, kept as-is.
>
> - **Working branch is `hub`**, not `main` — `main` tracks upstream. `hub` is the GitHub default
>   branch so the repo lands on the fork's actual code.
> - **What the fork adds:** a multi-machine agent hub — pair several machines over a tailnet and
>   drive agent work on all of them from one client. Fork-specific design notes, the architecture
>   map, and the rollout runbook live in [`docs/fork/`](docs/fork/) (start with `PLAN.md`).
> - **The user-facing brand is `starcode`** (lowercase). Internal identifiers deliberately still say
>   `t3` / `starcode` — package names, env vars, bundle ids, URL schemes, storage keys. Renaming those
>   churns infrastructure for zero daily value and is tracked as a release-pipeline concern in
>   `docs/fork/NOTES-mapper-addendum.md` §7.7.
> - **Do not publish from this fork.** It still ships under upstream's npm package name `t3`, so
>   self-update is hard-disabled (`apps/server/src/cloud/forkSwitches.ts`,
>   `FORK_DISABLE_SELF_UPDATE`) to stop any install path from replacing the fork's server with
>   upstream's published build.

---

# starcode

starcode is a minimal web GUI for coding agents (currently Codex, Claude, Cursor, and Grok, with more coming soon).

## Installation

> [!WARNING]
> starcode currently supports Codex, Claude, Cursor, and Grok.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`
> - Grok: install [Grok CLI](https://github.com/superagent-ai/grok-cli) and run `grok login`

### Run without installing

```bash
npx t3@latest
```

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install Starcode.Starcode
```

#### macOS (Homebrew)

```bash
brew install --cask starcode
```

#### Arch Linux (AUR)

```bash
yay -S starcode-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

There's no public docs site yet, checkout the miscellaneous markdown files in [docs](./docs).

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Remote access](./docs/user/remote-access.md)
- [Keeping starcode in sync](./docs/user/server-updates.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Provider guides](./docs/providers/codex.md)
- [Operations](./docs/operations/ci.md)
- [Reference](./docs/reference/encyclopedia.md)

## If you REALLY want to contribute still.... read this first

### Install `vp`

starcode uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
