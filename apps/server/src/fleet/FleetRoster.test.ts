import { assert, describe, it } from "@effect/vitest";
import type { EnvironmentId, FleetMember, FleetNode, FleetRoster } from "@starcode/contracts";
import * as DateTime from "effect/DateTime";

import {
  EMPTY_FLEET_ROSTER,
  FLEET_TOMBSTONE_TTL_MS,
  mergeFleetRosters,
  pruneExpiredFleetTombstones,
  tombstoneFleetMember,
  upsertFleetMember,
} from "./FleetRoster.ts";

const node = (name: string, updatedAt: string): FleetNode => ({
  environmentId: name as EnvironmentId,
  name,
  label: name.toUpperCase(),
  platform: { os: "linux", arch: "x64" },
  endpoints: [
    {
      id: "manual",
      label: "Manual",
      provider: { id: "manual", label: "Manual", kind: "manual", isAddon: false },
      httpBaseUrl: `http://${name}.test/`,
      wsBaseUrl: `ws://${name}.test/`,
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
  updatedAt,
});

const member = (name: string, updatedAt: string): FleetMember => ({
  node: node(name, updatedAt),
  registeredAt: updatedAt,
  updatedAt,
});

const roster = (...members: ReadonlyArray<FleetMember>): FleetRoster => ({
  version: 1,
  revision: members.length,
  members: [...members],
  tombstones: [],
});

describe("fleet roster convergence", () => {
  it("converges transitively across three nodes", () => {
    const alpha = roster(member("alpha", "2026-07-30T00:00:00.000Z"));
    const beta = roster(member("beta", "2026-07-30T00:00:01.000Z"));
    const gamma = roster(member("gamma", "2026-07-30T00:00:02.000Z"));

    const alphaBeta = mergeFleetRosters(alpha, beta);
    const betaGamma = mergeFleetRosters(mergeFleetRosters(beta, alphaBeta), gamma);
    const convergedAlpha = mergeFleetRosters(alphaBeta, betaGamma);
    const convergedGamma = mergeFleetRosters(gamma, betaGamma);

    assert.deepEqual(
      convergedAlpha.members.map((entry) => entry.node.name),
      ["alpha", "beta", "gamma"],
    );
    assert.deepEqual(convergedAlpha.members, convergedGamma.members);
  });

  it("keeps a removal tombstone through reconciliation with a stale roster", () => {
    const joined = roster(
      member("alpha", "2026-07-30T00:00:00.000Z"),
      member("gamma", "2026-07-30T00:00:01.000Z"),
    );
    const removed = tombstoneFleetMember(
      joined,
      "gamma" as EnvironmentId,
      "2026-07-30T01:00:00.000Z",
    ).roster;
    const merged = mergeFleetRosters(removed, joined);

    assert.isFalse(merged.members.some((entry) => entry.node.name === "gamma"));
    assert.deepEqual(
      merged.tombstones.map((entry) => entry.environmentId),
      ["gamma"],
    );
  });

  it("lets a newer distributed re-pair replace an older tombstone", () => {
    const joined = roster(
      member("alpha", "2026-07-30T00:00:00.000Z"),
      member("beta", "2026-07-30T00:00:00.000Z"),
      member("gamma", "2026-07-30T00:00:00.000Z"),
    );
    const alphaRemoved = tombstoneFleetMember(
      joined,
      "gamma" as EnvironmentId,
      "2026-07-30T01:00:00.000Z",
    ).roster;
    const betaFromGamma = mergeFleetRosters(
      roster(member("beta", "2026-07-30T00:00:00.000Z")),
      roster(member("gamma", "2026-07-30T02:00:00.000Z")),
    );
    const reconciled = mergeFleetRosters(alphaRemoved, betaFromGamma);

    assert.deepEqual(
      reconciled.members.map((entry) => entry.node.name),
      ["alpha", "beta", "gamma"],
    );
    assert.deepEqual(reconciled.tombstones, []);
  });

  it("allows an explicit later re-registration to clear a tombstone", () => {
    const removed = tombstoneFleetMember(
      EMPTY_FLEET_ROSTER,
      "gamma" as EnvironmentId,
      "2026-07-30T01:00:00.000Z",
    ).roster;
    const repaired = upsertFleetMember(removed, member("gamma", "2026-07-30T02:00:00.000Z"));

    assert.deepEqual(
      repaired.members.map((entry) => entry.node.name),
      ["gamma"],
    );
    assert.deepEqual(repaired.tombstones, []);
  });

  it("expires tombstones after thirty days", () => {
    const removedAt = "2026-07-30T01:00:00.000Z";
    const removed = tombstoneFleetMember(
      EMPTY_FLEET_ROSTER,
      "gamma" as EnvironmentId,
      removedAt,
    ).roster;
    const removedAtEpochMs = DateTime.toEpochMillis(DateTime.makeUnsafe(removedAt));
    const beforeExpiry = pruneExpiredFleetTombstones(
      removed,
      removedAtEpochMs + FLEET_TOMBSTONE_TTL_MS - 1,
    );
    const expired = pruneExpiredFleetTombstones(removed, removedAtEpochMs + FLEET_TOMBSTONE_TTL_MS);

    assert.lengthOf(beforeExpiry.tombstones, 1);
    assert.deepEqual(expired.tombstones, []);
    assert.strictEqual(expired.revision, removed.revision + 1);
  });
});
