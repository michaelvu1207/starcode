# Running StarCode in the Background

On macOS or Linux, StarCode can run as a background service for your user. On macOS, its per-user
LaunchAgent starts after sign-in. On Linux, its systemd user service starts at boot and remains
available after logout.

## Manage the Service

Install it from the StarCode CLI:

```sh
starcode service install
```

Check whether it is installed:

```sh
starcode service status
```

Update or repair it:

```sh
starcode service update
```

Stop it and remove it from startup:

```sh
starcode service uninstall
```

Updating restarts StarCode briefly. Let active agent work and terminal commands finish first.

## Using It with StarCode Connect

StarCode Connect may offer to install the service during setup so the host starts automatically and
stays reachable in the background. The service and StarCode Connect are managed separately.

Signing out of StarCode Connect does not remove the service. Use `starcode service uninstall` when
you no longer want StarCode to start in the background.

The background service requires macOS with launchd or Linux with systemd.
