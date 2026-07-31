import {
  DesktopFleetHostDiscovery,
  DesktopFleetOnboardingHost,
  DesktopFleetOnboardingPreflight,
  type DesktopDiscoveredSshHost,
} from "@starcode/contracts";
import { runSshRemotePreflight } from "@starcode/ssh/preflight";
import { discoverTailscalePeers } from "@starcode/tailscale/peers";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const normalizedHost = (value: string): string =>
  value.trim().replace(/\.$/u, "").toLocaleLowerCase();

function matchingSshTarget(
  sshHosts: ReadonlyArray<DesktopDiscoveredSshHost>,
  candidates: ReadonlyArray<string>,
): DesktopDiscoveredSshHost | undefined {
  const keys = new Set(candidates.map(normalizedHost));
  return sshHosts.find(
    (host) => keys.has(normalizedHost(host.alias)) || keys.has(normalizedHost(host.hostname)),
  );
}

export function fallbackFleetSshHostname(peer: {
  readonly hostname: string;
  readonly dnsName: string | null;
  readonly addresses: ReadonlyArray<string>;
  readonly tailnetIpv4Addresses: ReadonlyArray<string>;
}): string {
  return peer.tailnetIpv4Addresses[0] ?? peer.dnsName ?? peer.addresses[0] ?? peer.hostname;
}

export const discoverFleetHosts = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCOVER_FLEET_HOSTS_CHANNEL,
  payload: Schema.Void,
  result: DesktopFleetHostDiscovery,
  handler: Effect.fn("desktop.ipc.fleetOnboarding.discoverHosts")(function* () {
    const discovery = yield* discoverTailscalePeers;
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    const sshHosts = yield* sshEnvironment.discoverHosts().pipe(Effect.orElseSucceed(() => []));

    return {
      tailnetName: discovery.tailnet?.name ?? discovery.magicDnsSuffix,
      backendState: discovery.backendState,
      hosts: discovery.peers.map((peer) => {
        const candidates = [
          peer.hostname,
          ...(peer.dnsName === null ? [] : [peer.dnsName]),
          ...peer.addresses,
        ];
        const configured = matchingSshTarget(sshHosts, candidates);
        const fallbackHostname = fallbackFleetSshHostname(peer);
        return {
          hostname: peer.hostname,
          dnsName: peer.dnsName,
          addresses: peer.addresses,
          online: peer.online,
          sshTarget:
            configured === undefined
              ? {
                  alias: peer.hostname,
                  hostname: fallbackHostname,
                  username: null,
                  port: null,
                }
              : {
                  alias: configured.alias,
                  hostname: configured.hostname,
                  username: configured.username,
                  port: configured.port,
                },
        };
      }),
    };
  }),
});

export const preflightFleetHost = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREFLIGHT_FLEET_HOST_CHANNEL,
  payload: DesktopFleetOnboardingHost,
  result: DesktopFleetOnboardingPreflight,
  handler: Effect.fn("desktop.ipc.fleetOnboarding.preflightHost")(function* (host) {
    const report = yield* runSshRemotePreflight(host.sshTarget);
    return {
      readyForProvisioning: report.readyForProvisioning,
      platform:
        report.system?.platform === "linux" ||
        report.system?.platform === "darwin" ||
        report.system?.platform === "windows"
          ? report.system.platform
          : "unknown",
      starcodeInstalled: report.starcode.availability === "available",
      starcodeServiceRunning: report.starcode.service.status === "running",
      port: report.port,
      diagnostics: report.diagnostics,
    };
  }),
});
