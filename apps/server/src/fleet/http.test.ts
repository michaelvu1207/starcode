import { assert, it } from "@effect/vitest";
import {
  AuthAdministrativeScopes,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
} from "@starcode/contracts";

import { deriveFleetClientScopes } from "./FleetReconciler.ts";
import { FLEET_CLIENT_BOOTSTRAP_REQUIRED_SCOPE } from "./http.ts";

it("allows a read-only anchor while preserving its authority", () => {
  assert.strictEqual(FLEET_CLIENT_BOOTSTRAP_REQUIRED_SCOPE, AuthOrchestrationReadScope);
  assert.deepEqual(deriveFleetClientScopes([AuthOrchestrationReadScope]), [
    AuthOrchestrationReadScope,
  ]);
});

it("attenuates standard and administrative anchors to client scopes", () => {
  assert.deepEqual(deriveFleetClientScopes([...AuthStandardClientScopes]), [
    ...AuthStandardClientScopes,
  ]);
  assert.deepEqual(deriveFleetClientScopes([...AuthAdministrativeScopes]), [
    ...AuthStandardClientScopes,
  ]);
  assert.include(
    deriveFleetClientScopes([...AuthStandardClientScopes]),
    AuthOrchestrationOperateScope,
  );
});
