# Running starcode in the Background

On a Linux host, starcode can run as a background service for your user. It starts when the machine
boots and keeps running after you log out.

## Manage the Service

Install it with the latest starcode release:

```sh
npx t3@latest service install
```

Check whether it is installed:

```sh
npx t3@latest service status
```

Update or repair it:

```sh
npx t3@latest service update
```

Stop it and remove it from startup:

```sh
npx t3@latest service uninstall
```

Updating restarts starcode briefly. Let active agent work and terminal commands finish first.

## Using It with starcode Connect

starcode Connect may offer to install the service during setup so the host stays reachable after you log
out. This is only an onboarding shortcut: the service and starcode Connect are managed separately.

Signing out of starcode Connect does not remove the service. Use `starcode service uninstall` when you no longer
want starcode to start in the background.

The background service currently requires Linux with systemd.
