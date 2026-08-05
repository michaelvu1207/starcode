import { assert, it } from "@effect/vitest";
import {
  AuthAdministrativeScopes,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
} from "@starcode/contracts";

import { deriveFleetClientScopes } from "./FleetReconciler.ts";
import {
  FLEET_ACCOUNT_IMPORT_REQUIRED_SCOPE,
  FLEET_CLIENT_BOOTSTRAP_REQUIRED_SCOPE,
} from "./http.ts";

it("allows a read-only anchor while preserving its authority", () => {
  assert.strictEqual(FLEET_CLIENT_BOOTSTRAP_REQUIRED_SCOPE, AuthOrchestrationReadScope);
  assert.deepEqual(deriveFleetClientScopes([AuthOrchestrationReadScope]), [
    AuthOrchestrationReadScope,
  ]);
});

it("requires write authority before accepting fleet account material", () => {
  assert.strictEqual(FLEET_ACCOUNT_IMPORT_REQUIRED_SCOPE, AuthAccessWriteScope);
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
