import { describe, expect, it } from "vite-plus/test";

import {
  extractPairingUrlFromQrPayload,
  PairingQrPayloadEmptyError,
  parsePairingUrl,
} from "./pairing";

describe("extractPairingUrlFromQrPayload", () => {
  it("trims raw pairing urls from qr payloads", () => {
    expect(
      extractPairingUrlFromQrPayload("  https://remote.example.com/pair#token=pairing-token  "),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it("unwraps mobile deep links that carry an encoded pairing url", () => {
    expect(
      extractPairingUrlFromQrPayload(
        "starcode://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
      ),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  // A QR code printed before the rename has to keep scanning; the old schemes
  // stay registered in app.config.ts for exactly this.
  it("unwraps deep links on the pre-rename schemes", () => {
    for (const scheme of ["t3code", "t3code-dev", "starcode-dev"]) {
      expect(
        extractPairingUrlFromQrPayload(
          `${scheme}://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token`,
        ),
      ).toBe("https://remote.example.com/pair#token=pairing-token");
    }
  });

  it("leaves deep links on unrelated schemes as raw text", () => {
    expect(extractPairingUrlFromQrPayload("othercode://pair?pairingUrl=https%3A%2F%2Fx")).toBe(
      "othercode://pair?pairingUrl=https%3A%2F%2Fx",
    );
  });

  it("rejects empty qr payloads", () => {
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(PairingQrPayloadEmptyError);
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(
      "Scanned QR code did not contain a pairing URL.",
    );
  });
});

describe("parsePairingUrl", () => {
  it("reads hosted pairing links into backend host fields", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
    });
  });
});
