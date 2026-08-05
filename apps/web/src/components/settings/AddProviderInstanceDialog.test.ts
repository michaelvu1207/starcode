import { describe, expect, it } from "vite-plus/test";

import { ACCOUNT_SIGN_IN_PROVIDERS } from "./AddProviderInstanceDialog";
import { DRIVER_OPTIONS } from "./providerDriverMeta";

describe("account sign-in", () => {
  it("offers subscription families directly without choosing an execution driver", () => {
    expect(ACCOUNT_SIGN_IN_PROVIDERS).toEqual(["anthropic", "openai"]);
    expect(DRIVER_OPTIONS.map((option) => option.value)).toEqual(["pi"]);
  });
});
