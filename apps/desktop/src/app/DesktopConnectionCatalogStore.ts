import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  ConnectionCatalogDocument as RuntimeConnectionCatalogDocument,
  type ConnectionCatalogDocument as RuntimeConnectionCatalogDocumentType,
} from "@t3tools/client-runtime/platform";
import type { PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as ForkConnectionCatalogFile from "./forkConnectionCatalogFile.ts";

const RuntimeConnectionCatalogDocumentJson = Schema.fromJsonString(
  RuntimeConnectionCatalogDocument,
);
const encodeRuntimeConnectionCatalogDocumentJson = Schema.encodeEffect(
  RuntimeConnectionCatalogDocumentJson,
);

const DesktopConnectionCatalogStoreWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-catalog-file",
]);

const DesktopConnectionCatalogStoreMigrationOperation = Schema.Literals([
  "read-legacy-registry",
  "read-legacy-secret",
  "encode-catalog",
  "persist-catalog",
]);

const DesktopConnectionCatalogStoreProtectionOperation = Schema.Literals([
  "check-encryption-availability",
  "encrypt-catalog",
  "decrypt-catalog",
]);

export class DesktopConnectionCatalogStoreWriteError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreWriteError>()(
  "DesktopConnectionCatalogStoreWriteError",
  {
    operation: DesktopConnectionCatalogStoreWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop connection catalog write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopConnectionCatalogStoreDecodeError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreDecodeError>()(
  "DesktopConnectionCatalogStoreDecodeError",
  {
    resource: Schema.Literal("encryptedCatalog"),
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource} for the desktop connection catalog at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreReadError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreReadError>()(
  "DesktopConnectionCatalogStoreReadError",
  {
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the desktop connection catalog at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreDocumentDecodeError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreDocumentDecodeError>()(
  "DesktopConnectionCatalogStoreDocumentDecodeError",
  {
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode the desktop connection catalog document at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreMigrationError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreMigrationError>()(
  "DesktopConnectionCatalogStoreMigrationError",
  {
    operation: DesktopConnectionCatalogStoreMigrationOperation,
    catalogPath: Schema.String,
    environmentId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const environment =
      this.environmentId === undefined ? "" : ` for environment ${this.environmentId}`;
    return `Legacy desktop saved-environment migration failed during ${this.operation}${environment} into ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreProtectionError extends Schema.TaggedErrorClass<DesktopConnectionCatalogStoreProtectionError>()(
  "DesktopConnectionCatalogStoreProtectionError",
  {
    operation: DesktopConnectionCatalogStoreProtectionOperation,
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop connection catalog protection failed during ${this.operation} at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStore extends Context.Service<
  DesktopConnectionCatalogStore,
  {
    readonly get: Effect.Effect<
      Option.Option<string>,
      | DesktopConnectionCatalogStoreReadError
      | DesktopConnectionCatalogStoreDocumentDecodeError
      | DesktopConnectionCatalogStoreDecodeError
      | DesktopConnectionCatalogStoreMigrationError
      | DesktopConnectionCatalogStoreProtectionError
    >;
    readonly set: (
      catalog: string,
    ) => Effect.Effect<
      boolean,
      DesktopConnectionCatalogStoreWriteError | DesktopConnectionCatalogStoreProtectionError
    >;
    readonly clear: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopConnectionCatalogStore") {}

function decodeSecretBytes(
  catalogPath: string,
  encoded: string,
): Effect.Effect<Uint8Array, DesktopConnectionCatalogStoreDecodeError> {
  return Effect.fromResult(Encoding.decodeBase64(encoded)).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreDecodeError({
          resource: "encryptedCatalog",
          catalogPath,
          cause,
        }),
    ),
  );
}

const readDocument = (
  fileSystem: FileSystem.FileSystem,
  catalogPath: string,
): Effect.Effect<
  Option.Option<ForkConnectionCatalogFile.StoredConnectionCatalogDocument>,
  DesktopConnectionCatalogStoreReadError | DesktopConnectionCatalogStoreDocumentDecodeError
> =>
  ForkConnectionCatalogFile.readStoredDocument({
    fileSystem,
    catalogPath,
    onReadError: (cause) =>
      new DesktopConnectionCatalogStoreReadError({
        catalogPath,
        cause,
      }),
    onDecodeError: (cause) =>
      new DesktopConnectionCatalogStoreDocumentDecodeError({
        catalogPath,
        cause,
      }),
  });

function connectionId(prefix: "bearer" | "ssh", environmentId: string): string {
  return `${prefix}:${environmentId}`;
}

const migrateSavedEnvironmentRecords = Effect.fn(
  "desktop.connectionCatalogStore.migrateSavedEnvironmentRecords",
)(function* (
  records: readonly PersistedSavedEnvironmentRecord[],
  savedEnvironments: DesktopSavedEnvironments.DesktopSavedEnvironments["Service"],
  catalogPath: string,
): Effect.fn.Return<
  RuntimeConnectionCatalogDocumentType,
  DesktopConnectionCatalogStoreMigrationError
> {
  const targets: Array<RuntimeConnectionCatalogDocumentType["targets"][number]> = [];
  const profiles: Array<RuntimeConnectionCatalogDocumentType["profiles"][number]> = [];
  const credentials: Array<RuntimeConnectionCatalogDocumentType["credentials"][number]> = [];

  for (const record of records) {
    if (record.relayManaged !== undefined) {
      targets.push(
        new RelayConnectionTarget({
          environmentId: record.environmentId,
          label: record.label,
        }),
      );
      continue;
    }

    if (record.desktopSsh !== undefined) {
      const id = connectionId("ssh", record.environmentId);
      targets.push(
        new SshConnectionTarget({
          environmentId: record.environmentId,
          label: record.label,
          connectionId: id,
        }),
      );
      profiles.push(
        new SshConnectionProfile({
          connectionId: id,
          environmentId: record.environmentId,
          label: record.label,
          target: record.desktopSsh,
        }),
      );
      continue;
    }

    const id = connectionId("bearer", record.environmentId);
    targets.push(
      new BearerConnectionTarget({
        environmentId: record.environmentId,
        label: record.label,
        connectionId: id,
      }),
    );
    profiles.push(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: record.environmentId,
        label: record.label,
        httpBaseUrl: record.httpBaseUrl,
        wsBaseUrl: record.wsBaseUrl,
      }),
    );
    const token = yield* savedEnvironments.getSecret(record.environmentId).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "read-legacy-secret",
            catalogPath,
            environmentId: record.environmentId,
            cause,
          }),
      ),
    );
    if (Option.isSome(token)) {
      credentials.push({
        connectionId: id,
        credential: new BearerConnectionCredential({ token: token.value }),
      });
    }
  }

  return {
    schemaVersion: 1,
    targets,
    profiles,
    credentials,
    remoteDpopTokens: [],
  };
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;
  const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
  const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
  const encryptionAvailable = safeStorage.isEncryptionAvailable.pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreProtectionError({
          operation: "check-encryption-availability",
          catalogPath,
          cause,
        }),
    ),
  );

  // Fork: writes are plaintext v2 (see forkConnectionCatalogFile.ts). Nothing
  // here touches safeStorage any more, which is what keeps a rebuilt app from
  // stalling on a keychain dialog at boot.
  const writeCatalog = Effect.fn("desktop.connectionCatalogStore.writeCatalog")(function* (
    catalog: string,
  ) {
    const suffix = (yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "create-temporary-file-name",
            path: catalogPath,
            cause,
          }),
      ),
    )).replace(/-/g, "");
    yield* ForkConnectionCatalogFile.writePlainDocument({
      fileSystem,
      path,
      catalogPath,
      catalog,
      suffix,
      onEncodeError: (cause) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "encode-document",
          path: catalogPath,
          cause,
        }),
      onDirectoryError: (cause, directory) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
      onTempWriteError: (cause, tempPath) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "write-temporary-file",
          path: tempPath,
          cause,
        }),
      onRenameError: (cause) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "replace-catalog-file",
          path: catalogPath,
          cause,
        }),
    });
  });

  const migrateLegacyCatalog = Effect.gen(function* () {
    // Fork: the registry read comes first on purpose. It is a plain file read,
    // whereas `encryptionAvailable` initialises Electron's keychain-backed
    // storage — asking it before we know there is anything to migrate would put
    // a password dialog in front of every first boot, which is the whole bug.
    const records = yield* savedEnvironments.getRegistry.pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "read-legacy-registry",
            catalogPath,
            cause,
          }),
      ),
    );
    if (records.length === 0) {
      return Option.none<string>();
    }
    if (!(yield* encryptionAvailable)) {
      return Option.none<string>();
    }
    const catalog = yield* migrateSavedEnvironmentRecords(records, savedEnvironments, catalogPath);
    const encoded = yield* encodeRuntimeConnectionCatalogDocumentJson(catalog).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "encode-catalog",
            catalogPath,
            cause,
          }),
      ),
    );
    yield* writeCatalog(encoded).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "persist-catalog",
            catalogPath,
            cause,
          }),
      ),
    );
    return Option.some(encoded);
  });

  return DesktopConnectionCatalogStore.of({
    get: Effect.gen(function* () {
      const document = yield* readDocument(fileSystem, catalogPath);
      if (Option.isNone(document)) {
        return yield* migrateLegacyCatalog;
      }
      // Fork: the common path. A v2 document is plaintext, so a normal boot
      // never reaches safeStorage and never raises a keychain prompt.
      if (ForkConnectionCatalogFile.isPlainDocument(document.value)) {
        return Option.some(document.value.catalog);
      }
      // Fork: one-time upgrade of an existing v1 document. This is the last
      // keychain prompt a given profile will ever see — after the rewrite below
      // the file is v2 and this branch is unreachable.
      if (!(yield* encryptionAvailable)) {
        return Option.none<string>();
      }
      const decrypted = yield* decodeSecretBytes(catalogPath, document.value.encryptedCatalog).pipe(
        Effect.flatMap((encryptedCatalog) =>
          safeStorage.decryptString(encryptedCatalog).pipe(
            Effect.mapError(
              (cause) =>
                new DesktopConnectionCatalogStoreProtectionError({
                  operation: "decrypt-catalog",
                  catalogPath,
                  cause,
                }),
            ),
          ),
        ),
      );
      // Rewrite failures are logged, not fatal: the catalog we just decrypted is
      // still good, and failing the read would lock the user out of every paired
      // machine over what is only an optimisation for the next boot.
      yield* writeCatalog(decrypted).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not rewrite the connection catalog as plaintext.", {
            catalogPath,
            error,
          }),
        ),
      );
      return Option.some(decrypted);
    }).pipe(Effect.withSpan("desktop.connectionCatalogStore.get")),
    set: Effect.fn("desktop.connectionCatalogStore.set")(function* (catalog) {
      yield* writeCatalog(catalog);
      return true;
    }),
    clear: fileSystem.remove(catalogPath, { force: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not clear the desktop connection catalog.", {
          catalogPath,
          error,
        }),
      ),
      Effect.withSpan("desktop.connectionCatalogStore.clear"),
    ),
  });
});

export const layer = Layer.effect(DesktopConnectionCatalogStore, make);
