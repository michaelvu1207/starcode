import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";
import type { SQLiteDatabase } from "expo-sqlite";

const MobileSecureStorageOperation = Schema.Literals(["read", "write", "delete"]);

export class MobileSecureStorageError extends Schema.TaggedErrorClass<MobileSecureStorageError>()(
  "MobileSecureStorageError",
  {
    operation: MobileSecureStorageOperation,
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Mobile secure storage operation ${this.operation} failed for key ${this.key}.`;
  }
}

export class MobileSecureStorage extends Context.Service<
  MobileSecureStorage,
  {
    readonly getItem: (key: string) => Effect.Effect<string | null, MobileSecureStorageError>;
    readonly setItem: (key: string, value: string) => Effect.Effect<void, MobileSecureStorageError>;
    readonly removeItem: (key: string) => Effect.Effect<void, MobileSecureStorageError>;
  }
>()("@starcode/mobile/persistence/MobileSecureStorage") {}

interface MobileSecureStorageBackend {
  readonly getItemAsync: (key: string) => Promise<string | null>;
  readonly setItemAsync: (key: string, value: string) => Promise<void>;
  readonly deleteItemAsync: (key: string) => Promise<unknown>;
}

export const makeWithBackend = (backend: MobileSecureStorageBackend) =>
  MobileSecureStorage.of({
    getItem: Effect.fn("MobileSecureStorage.getItem")((key) =>
      Effect.tryPromise({
        try: () => backend.getItemAsync(key),
        catch: (cause) => new MobileSecureStorageError({ operation: "read", key, cause }),
      }),
    ),
    setItem: Effect.fn("MobileSecureStorage.setItem")((key, value) =>
      Effect.tryPromise({
        try: () => backend.setItemAsync(key, value),
        catch: (cause) => new MobileSecureStorageError({ operation: "write", key, cause }),
      }),
    ),
    removeItem: Effect.fn("MobileSecureStorage.removeItem")((key) =>
      Effect.tryPromise({
        try: () => backend.deleteItemAsync(key),
        catch: (cause) => new MobileSecureStorageError({ operation: "delete", key, cause }),
      }),
    ),
  });

const secureStoreBackend: MobileSecureStorageBackend = {
  getItemAsync: SecureStore.getItemAsync,
  setItemAsync: SecureStore.setItemAsync,
  deleteItemAsync: SecureStore.deleteItemAsync,
};

let simulatorDatabase: Promise<SQLiteDatabase> | undefined;
const getSimulatorDatabase = () => {
  simulatorDatabase ??= import("expo-sqlite").then(async (SQLite) => {
    const database = await SQLite.openDatabaseAsync("starcode-insecure-simulator-storage.db");
    await database.execAsync(
      "CREATE TABLE IF NOT EXISTS secure_storage (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
    return database;
  });
  return simulatorDatabase;
};

const simulatorStorageBackend: MobileSecureStorageBackend = {
  getItemAsync: async (key) => {
    const database = await getSimulatorDatabase();
    const row = await database.getFirstAsync<{ readonly value: string }>(
      "SELECT value FROM secure_storage WHERE key = ?",
      key,
    );
    return row?.value ?? null;
  },
  setItemAsync: async (key, value) => {
    const database = await getSimulatorDatabase();
    await database.runAsync(
      "INSERT INTO secure_storage (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  },
  deleteItemAsync: async (key) => {
    const database = await getSimulatorDatabase();
    await database.runAsync("DELETE FROM secure_storage WHERE key = ?", key);
  },
};

// Unsigned iOS Simulator builds have no application-identifier entitlement,
// so Keychain calls fail before client flows can be exercised. The explicit
// Metro-only flag provides a local SQLite fallback for integrated simulator
// verification. Release builds never enable it and continue to require
// SecureStore.
export const make = makeWithBackend(
  process.env.EXPO_PUBLIC_STARCODE_INSECURE_SIMULATOR_STORAGE === "1"
    ? simulatorStorageBackend
    : secureStoreBackend,
);

export const layer = Layer.succeed(MobileSecureStorage, make);
