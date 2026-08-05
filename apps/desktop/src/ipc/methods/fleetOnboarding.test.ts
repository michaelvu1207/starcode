import { describe, expect, it } from "@effect/vitest";

import { fallbackFleetSshHostname } from "./fleetOnboarding.ts";

describe("desktop fleet onboarding", () => {
  it("prefers a reachable Tailscale IPv4 address when MagicDNS is unavailable", () => {
    expect(
      fallbackFleetSshHostname({
        hostname: "fresh-vm",
        dnsName: "fresh-vm.example.ts.net",
        addresses: ["100.84.10.23", "fd7a:115c:a1e0::23"],
        tailnetIpv4Addresses: ["100.84.10.23"],
      }),
    ).toBe("100.84.10.23");
  });

  it("falls back through MagicDNS, any peer address, and hostname", () => {
    expect(
      fallbackFleetSshHostname({
        hostname: "fresh-vm",
        dnsName: "fresh-vm.example.ts.net",
        addresses: [],
        tailnetIpv4Addresses: [],
      }),
    ).toBe("fresh-vm.example.ts.net");
    expect(
      fallbackFleetSshHostname({
        hostname: "fresh-vm",
        dnsName: null,
        addresses: ["fd7a:115c:a1e0::23"],
        tailnetIpv4Addresses: [],
      }),
    ).toBe("fd7a:115c:a1e0::23");
    expect(
      fallbackFleetSshHostname({
        hostname: "fresh-vm",
        dnsName: null,
        addresses: [],
        tailnetIpv4Addresses: [],
      }),
    ).toBe("fresh-vm");
  });
});
