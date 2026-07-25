/**
 * Mailbox service composition.
 *
 * The store itself is *not* composed here. `ThreadMailbox` is provided in the
 * runtime dependency chain rather than in the routes layer, because the turn
 * reactor consumes it too — and there must be exactly one instance, or a claim
 * made by the HTTP side would not be visible to the delivery side.
 *
 * @module MailboxLayer
 */
export { mailboxHttpApiLayer } from "./http.ts";
