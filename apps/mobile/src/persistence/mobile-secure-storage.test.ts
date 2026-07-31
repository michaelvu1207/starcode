import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import { makeWithBackend, MobileSecureStorageError } from "./mobile-secure-storage";

const makeBackend = () => ({
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(),
  setItemAsync: vi.fn<(key: string, value: string) => Promise<void>>(),
  deleteItemAsync: vi.fn<(key: string) => Promise<void>>(),
});

describe("MobileSecureStorage", () => {
  it.effect("routes reads, writes, and deletes through the selected backend", () =>
    Effect.gen(function* () {
      const backend = makeBackend();
      backend.getItemAsync.mockResolvedValue("saved");
      backend.setItemAsync.mockResolvedValue();
      backend.deleteItemAsync.mockResolvedValue();
      const storage = makeWithBackend(backend);

      expect(yield* storage.getItem("connection")).toBe("saved");
      yield* storage.setItem("connection", "next");
      yield* storage.removeItem("connection");

      expect(backend.getItemAsync).toHaveBeenCalledWith("connection");
      expect(backend.setItemAsync).toHaveBeenCalledWith("connection", "next");
      expect(backend.deleteItemAsync).toHaveBeenCalledWith("connection");
    }),
  );

  it.effect("keeps backend failures typed and secret-safe", () =>
    Effect.gen(function* () {
      const backend = makeBackend();
      backend.getItemAsync.mockRejectedValue(new Error("backend detail"));
      const storage = makeWithBackend(backend);

      const result = yield* Effect.result(storage.getItem("connection"));

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "MobileSecureStorageError" },
      });
      if (result._tag !== "Failure") return;
      const error = result.failure;
      expect(error).toBeInstanceOf(MobileSecureStorageError);
      expect(error.message).toBe("Mobile secure storage operation read failed for key connection.");
      expect(error.message).not.toContain("backend detail");
    }),
  );
});
