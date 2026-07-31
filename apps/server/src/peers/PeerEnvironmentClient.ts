/**
 * Deprecated one-release aliases for FleetClient.
 *
 * FleetClient owns every node-to-node HTTP operation. This module retains the
 * former export names so migration-only registry and tests do not need a
 * flag-day rename.
 *
 * @module PeerEnvironmentClient
 */
export {
  FLEET_REQUEST_TIMEOUT as PEER_REQUEST_TIMEOUT,
  dispatchFleetCommand as dispatchPeerCommand,
  fetchFleetDescriptor as fetchPeerDescriptor,
  fetchFleetProjectCatalog as fetchPeerProjectCatalog,
  fetchFleetSessionState as fetchPeerSessionState,
  fetchFleetShellSnapshot as fetchPeerShellSnapshot,
  fetchFleetThreadSnapshot as fetchPeerThreadSnapshot,
  sendFleetMailboxMessage as sendPeerMailboxMessage,
} from "../fleet/FleetClient.ts";

/**
 * Normalize an operator-supplied legacy peer origin. Kept here because legacy
 * registration still accepts a URL before it becomes a fleet endpoint.
 */
export const normalizePeerBaseUrl = (value: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.origin;
};
