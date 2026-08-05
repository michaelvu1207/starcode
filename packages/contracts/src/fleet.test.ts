import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  FleetClientBootstrapResult,
  FleetRoster,
  FleetThreadIndex,
} from "./index.ts";

const decodeFleetRoster = Schema.decodeUnknownSync(FleetRoster);
const decodeFleetThreadIndex = Schema.decodeUnknownSync(FleetThreadIndex);
const decodeFleetClientBootstrap = Schema.decodeUnknownSync(FleetClientBootstrapResult);

describe("fleet contracts", () => {
  it("round-trips a metadata-only roster with tombstones", () => {
    const roster = decodeFleetRoster({
      version: 1,
      revision: 3,
      members: [
        {
          node: {
            environmentId: "alpha",
            name: "alpha",
            label: "Alpha",
            platform: { os: "darwin", arch: "arm64" },
            endpoints: [
              {
                id: "manual",
                label: "Manual",
                provider: { id: "manual", label: "Manual", kind: "manual", isAddon: false },
                httpBaseUrl: "http://127.0.0.1:3773/",
                wsBaseUrl: "ws://127.0.0.1:3773/",
                reachability: "lan",
                compatibility: {
                  hostedHttpsApp: "mixed-content-blocked",
                  desktopApp: "compatible",
                },
                source: "user",
                status: "available",
                isDefault: true,
              },
            ],
            sshUser: null,
            updatedAt: "2026-07-30T00:00:00.000Z",
          },
          registeredAt: "2026-07-30T00:00:00.000Z",
          updatedAt: "2026-07-30T00:00:00.000Z",
        },
      ],
      tombstones: [
        {
          environmentId: "gamma",
          removedAt: "2026-07-30T01:00:00.000Z",
          updatedAt: "2026-07-30T01:00:00.000Z",
        },
      ],
    });

    expect(roster.members[0]?.node.environmentId).toBe(EnvironmentId.make("alpha"));
    expect(JSON.stringify(roster)).not.toContain("credential");
  });

  it("defaults endpoint compatibility for rosters written by older desktop builds", () => {
    const roster = decodeFleetRoster({
      version: 1,
      revision: 1,
      members: [
        {
          node: {
            environmentId: "legacy",
            name: "legacy",
            label: "Legacy",
            platform: { os: "darwin", arch: "arm64" },
            endpoints: [
              {
                id: "manual",
                label: "Manual",
                provider: { id: "manual", label: "Manual", kind: "manual", isAddon: false },
                httpBaseUrl: "http://legacy.test/",
                wsBaseUrl: "ws://legacy.test/",
                reachability: "private-network",
                source: "user",
                status: "available",
              },
            ],
            sshUser: null,
            updatedAt: "2026-07-30T00:00:00.000Z",
          },
          registeredAt: "2026-07-30T00:00:00.000Z",
          updatedAt: "2026-07-30T00:00:00.000Z",
        },
      ],
      tombstones: [],
    });

    expect(roster.members[0]?.node.endpoints[0]?.compatibility).toEqual({
      hostedHttpsApp: "unknown",
      desktopApp: "unknown",
    });
  });

  it("defaults the SSH user for fleet nodes written by older desktop builds", () => {
    const roster = decodeFleetRoster({
      version: 1,
      revision: 1,
      members: [
        {
          node: {
            environmentId: "legacy",
            name: "legacy",
            label: "Legacy",
            platform: { os: "darwin", arch: "arm64" },
            endpoints: [],
            updatedAt: "2026-07-30T00:00:00.000Z",
          },
          registeredAt: "2026-07-30T00:00:00.000Z",
          updatedAt: "2026-07-30T00:00:00.000Z",
        },
      ],
      tombstones: [],
    });

    expect(roster.members[0]?.node.sshUser).toBeNull();
  });

  it("defines the routing fields required by the fleet thread index", () => {
    const index = decodeFleetThreadIndex({
      revision: 1,
      entries: [
        {
          threadId: "thread-1",
          node: "alpha",
          nodeName: "alpha",
          project: "starcode",
          title: "Fleet work",
          status: "working",
          lastActivityAt: "2026-07-30T00:00:00.000Z",
          createdAt: "2026-07-30T00:00:00.000Z",
          provider: "codex",
          model: "gpt-5",
          branch: null,
        },
      ],
      failures: [],
    });
    expect(index.entries[0]?.node).toBe(EnvironmentId.make("alpha"));
  });

  it("keeps viewer credentials outside fleet roster records", () => {
    const bootstrap = decodeFleetClientBootstrap({
      revision: 2,
      nodes: [
        {
          nodeId: "alpha",
          environmentId: "alpha",
          label: "Alpha",
          endpoint: {
            httpBaseUrl: "http://127.0.0.1:3773/",
            wsBaseUrl: "ws://127.0.0.1:3773/",
          },
          credential: { bearerToken: "transient-token", expiresAtEpochMs: 1 },
        },
      ],
    });
    expect(bootstrap.nodes[0]?.credential.bearerToken).toBe("transient-token");
  });
});
