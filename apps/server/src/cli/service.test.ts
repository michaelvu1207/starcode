import { assert, it } from "@effect/vitest";

import { formatServiceStatus } from "./service.ts";

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/starcode.service",
  logPath: "/home/me/.starcode/userdata/logs/boot-service.log",
} as const;

it("reports the installed service version and host paths", () => {
  assert.equal(
    formatServiceStatus(status, "0.0.29"),
    [
      "StarCode service",
      "  Status: installed · starcode@0.0.29",
      "  Definition: /home/me/.config/systemd/user/starcode.service",
      "  Logs: /home/me/.starcode/userdata/logs/boot-service.log",
    ].join("\n"),
  );
});

it("gives a direct repair command for a stale service", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29"),
    "Next: Run `npx starcode@latest service update`.",
  );
});

it("explains service availability on unsupported platforms", () => {
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, "0.0.29"),
    "Supported on: macOS with launchd or Linux with systemd",
  );
});
