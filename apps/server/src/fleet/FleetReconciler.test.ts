import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  FleetNodeName,
  type FleetMember,
  type FleetRoster,
} from "@starcode/contracts";

import {
  deriveFleetNodeName,
  fleetRosterRecordsEqual,
  fleetRosterRequiresExchange,
  fleetRegistrationFailureDetail,
  nextFleetRegistrationTimestamp,
  reassertRegisteredFleetMember,
  resolveSelfBaseUrl,
} from "./FleetReconciler.ts";

const member = (name: string, updatedAt: string): FleetMember => ({
  node: {
    environmentId: EnvironmentId.make(name),
    name: FleetNodeName.make(name),
    label: name,
    platform: { os: "linux", arch: "x64" },
    endpoints: [],
    sshUser: null,
    updatedAt,
  },
  registeredAt: updatedAt,
  updatedAt,
});

const roster = (revision: number, members: ReadonlyArray<FleetMember>): FleetRoster => ({
  version: 1,
  revision,
  members,
  tombstones: [],
});

describe("fleet self metadata", () => {
  it("derives a schema-safe stable name from a human machine label", () => {
    const name = deriveFleetNodeName(
      "Michael’s MacBook Pro",
      EnvironmentId.make("5b683a80-5b6c-47f4-ad93-dd1c32b07c95"),
    );
    assert.match(name, /^[a-z0-9][a-z0-9._-]*$/);
    assert.isAtMost(name.length, 64);
    assert.equal(
      name,
      deriveFleetNodeName(
        "Michael’s MacBook Pro",
        EnvironmentId.make("5b683a80-5b6c-47f4-ad93-dd1c32b07c95"),
      ),
    );
  });

  it("preserves an existing reachable endpoint without an explicit override", () => {
    assert.equal(
      resolveSelfBaseUrl({
        existing: "https://macbook.tailnet.example/",
        fallback: "http://127.0.0.1:3773",
      }),
      "https://macbook.tailnet.example",
    );
  });

  it("uses an explicit reciprocal endpoint when supplied", () => {
    assert.equal(
      resolveSelfBaseUrl({
        explicit: "https://new.tailnet.example/path",
        existing: "https://old.tailnet.example",
        fallback: "http://127.0.0.1:3773",
      }),
      "https://new.tailnet.example",
    );
  });

  it("uses fixed registration details that cannot echo credentials or request bodies", () => {
    const sensitiveValue = "subject_token=must-never-be-returned";
    const details = [
      fleetRegistrationFailureDetail("node_unreachable"),
      fleetRegistrationFailureDetail("exchange_rejected"),
    ];

    assert.isTrue(details.every((detail) => detail?.includes(sensitiveValue) === false));
  });

  it("reasserts the reachable registration endpoint after initial reconciliation", () => {
    const initial = member("remote", "2026-07-30T00:00:00.000Z");
    const registered: FleetMember = {
      ...initial,
      node: {
        ...initial.node,
        endpoints: [
          {
            id: "fleet-default",
            label: "Remote",
            provider: {
              id: "fleet",
              label: "StarCode fleet",
              kind: "private-network",
              isAddon: false,
            },
            httpBaseUrl: "http://100.64.0.23:3773/",
            wsBaseUrl: "ws://100.64.0.23:3773/",
            reachability: "private-network",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "server",
            status: "available",
            isDefault: true,
          },
        ],
      },
    };

    const reasserted = reassertRegisteredFleetMember(registered, "2026-07-30T00:00:01.000Z");

    assert.equal(reasserted.node.endpoints[0]?.httpBaseUrl, "http://100.64.0.23:3773/");
    assert.equal(reasserted.node.updatedAt, "2026-07-30T00:00:01.000Z");
    assert.equal(reasserted.updatedAt, "2026-07-30T00:00:01.000Z");
    assert.equal(reasserted.registeredAt, "2026-07-30T00:00:00.000Z");
  });

  it("advances beyond a remote self-record even when that machine's clock is ahead", () => {
    assert.equal(
      nextFleetRegistrationTimestamp("2026-07-30T00:00:01.000Z", [
        "2026-07-30T00:00:00.000Z",
        "2026-07-30T00:05:00.000Z",
      ]),
      "2026-07-30T00:05:00.001Z",
    );
  });
});

describe("fleet reconciliation stability", () => {
  it("treats revision-only differences as converged", () => {
    const alpha = member("alpha", "2026-07-30T00:00:00.000Z");
    const local = roster(17, [alpha]);
    const remote = roster(4, [alpha]);

    assert.isTrue(fleetRosterRecordsEqual(local, remote));
    assert.isFalse(fleetRosterRequiresExchange(local, remote));
  });

  it("requests exchange only when the remote is missing a durable record", () => {
    const alpha = member("alpha", "2026-07-30T00:00:00.000Z");
    const beta = member("beta", "2026-07-30T00:00:01.000Z");

    assert.isTrue(fleetRosterRequiresExchange(roster(2, [alpha, beta]), roster(1, [alpha])));
    assert.isFalse(fleetRosterRequiresExchange(roster(2, [alpha, beta]), roster(9, [alpha, beta])));
  });
});
