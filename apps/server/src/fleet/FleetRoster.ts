/**
 * Pure fleet roster operations.
 *
 * Keeping convergence rules free of I/O makes the most important federation
 * invariant testable without a running server: merge is symmetric,
 * deterministic, and tombstones win ties.
 *
 * @module FleetRoster
 */
import type { EnvironmentId, FleetMember, FleetRoster, FleetTombstone } from "@starcode/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export const EMPTY_FLEET_ROSTER: FleetRoster = {
  version: 1,
  revision: 0,
  members: [],
  tombstones: [],
};

/** Tombstones only need to outlive the maximum expected disconnected interval. */
export const FLEET_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

const byEnvironmentId = <A extends { readonly environmentId: EnvironmentId }>(
  left: A,
  right: A,
): number => left.environmentId.localeCompare(right.environmentId);

const recordUpdatedAt = (record: FleetMember | FleetTombstone): string =>
  "node" in record ? record.updatedAt : record.updatedAt;

const recordsEqual = (
  left: ReadonlyArray<FleetMember | FleetTombstone>,
  right: ReadonlyArray<FleetMember | FleetTombstone>,
): boolean => JSON.stringify(left) === JSON.stringify(right);

/**
 * Merge two complete snapshots with last-writer-wins semantics. A tombstone
 * wins an exact timestamp tie, so delayed active records cannot revive a node.
 */
export const mergeFleetRosters = (local: FleetRoster, remote: FleetRoster): FleetRoster => {
  const candidates = new Map<
    EnvironmentId,
    | { readonly kind: "member"; readonly value: FleetMember }
    | {
        readonly kind: "tombstone";
        readonly value: FleetTombstone;
      }
  >();

  const consider = (kind: "member" | "tombstone", value: FleetMember | FleetTombstone): void => {
    const environmentId = "node" in value ? value.node.environmentId : value.environmentId;
    const existing = candidates.get(environmentId);
    if (existing === undefined) {
      candidates.set(
        environmentId,
        kind === "member"
          ? { kind, value: value as FleetMember }
          : { kind, value: value as FleetTombstone },
      );
      return;
    }

    const comparison = recordUpdatedAt(value).localeCompare(recordUpdatedAt(existing.value));
    if (comparison > 0 || (comparison === 0 && kind === "tombstone")) {
      candidates.set(
        environmentId,
        kind === "member"
          ? { kind, value: value as FleetMember }
          : { kind, value: value as FleetTombstone },
      );
    }
  };

  for (const roster of [local, remote]) {
    for (const member of roster.members) consider("member", member);
    for (const tombstone of roster.tombstones) consider("tombstone", tombstone);
  }

  const members: Array<FleetMember> = [];
  const tombstones: Array<FleetTombstone> = [];
  for (const candidate of candidates.values()) {
    if (candidate.kind === "member") members.push(candidate.value);
    else tombstones.push(candidate.value);
  }
  members.sort((left, right) => left.node.environmentId.localeCompare(right.node.environmentId));
  tombstones.sort(byEnvironmentId);

  const localRecords = [
    ...local.members.toSorted((left, right) =>
      left.node.environmentId.localeCompare(right.node.environmentId),
    ),
    ...local.tombstones.toSorted(byEnvironmentId),
  ];
  const mergedRecords = [...members, ...tombstones];
  const recordsChanged = !recordsEqual(localRecords, mergedRecords);

  return {
    version: 1,
    revision: recordsChanged
      ? Math.max(local.revision, remote.revision) + 1
      : Math.max(local.revision, remote.revision),
    members,
    tombstones,
  };
};

/** Drop removal markers after their bounded convergence window. */
export const pruneExpiredFleetTombstones = (
  roster: FleetRoster,
  nowEpochMs: number,
): FleetRoster => {
  const tombstones = roster.tombstones.filter((tombstone) => {
    const updatedAt = DateTime.make(tombstone.updatedAt);
    return (
      Option.isNone(updatedAt) ||
      nowEpochMs - DateTime.toEpochMillis(updatedAt.value) < FLEET_TOMBSTONE_TTL_MS
    );
  });
  if (tombstones.length === roster.tombstones.length) return roster;
  return { ...roster, revision: roster.revision + 1, tombstones };
};

/** Explicit registration clears an older tombstone and advances the revision. */
export const upsertFleetMember = (roster: FleetRoster, member: FleetMember): FleetRoster => {
  const withoutTarget: FleetRoster = {
    ...roster,
    members: roster.members.filter(
      (candidate) => candidate.node.environmentId !== member.node.environmentId,
    ),
    tombstones: roster.tombstones.filter(
      (candidate) => candidate.environmentId !== member.node.environmentId,
    ),
  };
  return {
    ...withoutTarget,
    revision: roster.revision + 1,
    members: [...withoutTarget.members, member].toSorted((left, right) =>
      left.node.environmentId.localeCompare(right.node.environmentId),
    ),
  };
};

export const tombstoneFleetMember = (
  roster: FleetRoster,
  environmentId: EnvironmentId,
  now: string,
): { readonly roster: FleetRoster; readonly removed: boolean } => {
  const removed = roster.members.some(
    (candidate) => candidate.node.environmentId === environmentId,
  );
  if (
    !removed &&
    roster.tombstones.some((candidate) => candidate.environmentId === environmentId)
  ) {
    return { roster, removed: false };
  }

  const tombstone: FleetTombstone = { environmentId, removedAt: now, updatedAt: now };
  return {
    removed,
    roster: {
      version: 1,
      revision: roster.revision + 1,
      members: roster.members.filter((candidate) => candidate.node.environmentId !== environmentId),
      tombstones: [
        ...roster.tombstones.filter((candidate) => candidate.environmentId !== environmentId),
        tombstone,
      ].toSorted(byEnvironmentId),
    },
  };
};
