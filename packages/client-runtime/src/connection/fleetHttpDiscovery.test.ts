import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";

import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";
import { fleetDiscoveryFailureLogAttributes } from "./fleetHttpDiscovery.ts";

describe("fleet HTTP discovery", () => {
  it("never includes bearer-like secrets in failure log attributes", () => {
    const secret = "fleet-bootstrap-secret-value";
    const cause = Cause.fail(
      new RemoteEnvironmentAuthFetchError({
        message: `Request failed with Authorization: Bearer ${secret}`,
        cause: {
          request: {
            headers: {
              authorization: `Bearer ${secret}`,
            },
          },
        },
      }),
    );

    const serialized = JSON.stringify(fleetDiscoveryFailureLogAttributes(cause));

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("Request failed");
    expect(serialized).toContain("RemoteEnvironmentAuthFetchError");
  });
});
