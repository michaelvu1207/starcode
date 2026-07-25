/**
 * Fork-owned: the connection catalog on disk, without the OS keychain.
 *
 * WHY THIS EXISTS
 * Upstream stores the catalog encrypted through Electron `safeStorage`, which
 * on macOS is backed by a login-keychain item ("t3code Safe Storage"). The
 * keychain ACL binds to the *binary*, so every rebuild of an ad-hoc or
 * self-signed app is a new subject and macOS blocks startup on a password
 * dialog until a human answers it. For a fork we rebuild several times a day
 * that turned a routine swap into "the app is broken" — no backend child, no
 * window, `waitForHttpReady` timing out.
 *
 * The trade is deliberate: at-rest encryption of the catalog is worth less than
 * a desktop app that boots. `T3CODE_HOME` is already a private per-user
 * directory, and `~/.t3` stores the same class of data (bearer tokens for
 * machines the user owns) as plain files, so this does not lower the bar the
 * product already sets — it matches it.
 *
 * WHAT IT OWNS
 * Only the document on disk: the v2 plaintext shape, reading either version,
 * and the atomic write. Decryption of a legacy v1 document stays in the store,
 * because only the store holds `safeStorage`. Keeping the fork's logic here
 * means the upstream file's diff is the call sites and nothing else.
 */
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

/** v1: upstream's shape. Read for migration, never written again. */
export const EncryptedConnectionCatalogDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedCatalog: Schema.String,
});
export type EncryptedConnectionCatalogDocument = typeof EncryptedConnectionCatalogDocument.Type;

/** v2: the catalog as it comes off the wire, no cipher in front of it. */
export const PlainConnectionCatalogDocument = Schema.Struct({
  version: Schema.Literal(2),
  catalog: Schema.String,
});
export type PlainConnectionCatalogDocument = typeof PlainConnectionCatalogDocument.Type;

/**
 * Union rather than two decoders: a caller that reads the file must handle both
 * versions anyway, and a union makes the exhaustiveness the compiler's problem.
 */
export const StoredConnectionCatalogDocument = Schema.Union([
  PlainConnectionCatalogDocument,
  EncryptedConnectionCatalogDocument,
]);
export type StoredConnectionCatalogDocument = typeof StoredConnectionCatalogDocument.Type;

const StoredConnectionCatalogDocumentJson = fromLenientJson(StoredConnectionCatalogDocument);
export const decodeStoredConnectionCatalogDocumentJson = Schema.decodeEffect(
  StoredConnectionCatalogDocumentJson,
);

const PlainConnectionCatalogDocumentJson = fromLenientJson(PlainConnectionCatalogDocument);
export const encodePlainConnectionCatalogDocumentJson = Schema.encodeEffect(
  PlainConnectionCatalogDocumentJson,
);

export function isPlainDocument(
  document: StoredConnectionCatalogDocument,
): document is PlainConnectionCatalogDocument {
  return document.version === 2;
}

/**
 * Read the file, if it is there. `NotFound` is not an error — a first run has no
 * catalog — so it maps to `None` and every other failure is reported through
 * `onReadError`, which the store uses to keep its own tagged error types.
 */
export const readStoredDocument = <ReadError, DecodeError>(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly catalogPath: string;
  readonly onReadError: (cause: PlatformError.PlatformError) => ReadError;
  readonly onDecodeError: (cause: unknown) => DecodeError;
}): Effect.Effect<Option.Option<StoredConnectionCatalogDocument>, ReadError | DecodeError> =>
  input.fileSystem.readFileString(input.catalogPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed<string | null>(null)
        : Effect.fail(input.onReadError(error)),
    ),
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed(Option.none<StoredConnectionCatalogDocument>())
        : decodeStoredConnectionCatalogDocumentJson(raw).pipe(
            Effect.map(Option.some),
            Effect.mapError(input.onDecodeError),
          ),
    ),
  );

/**
 * Write through a sibling temp file and rename, so a crash mid-write leaves the
 * previous catalog intact rather than a truncated one. Same guarantee upstream
 * gives; the fork keeps it because losing the catalog means re-pairing every
 * machine by hand.
 */
export const writePlainDocument = <WriteError>(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly catalogPath: string;
  readonly catalog: string;
  readonly suffix: string;
  readonly onEncodeError: (cause: unknown) => WriteError;
  readonly onDirectoryError: (cause: unknown, directory: string) => WriteError;
  readonly onTempWriteError: (cause: unknown, tempPath: string) => WriteError;
  readonly onRenameError: (cause: unknown) => WriteError;
}): Effect.Effect<void, WriteError> =>
  Effect.gen(function* () {
    const directory = input.path.dirname(input.catalogPath);
    const tempPath = `${input.catalogPath}.${process.pid}.${input.suffix}.tmp`;
    const encoded = yield* encodePlainConnectionCatalogDocumentJson({
      version: 2,
      catalog: input.catalog,
    }).pipe(Effect.mapError(input.onEncodeError));

    yield* input.fileSystem
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.mapError((cause) => input.onDirectoryError(cause, directory)));

    yield* Effect.gen(function* () {
      yield* input.fileSystem
        .writeFileString(tempPath, `${encoded}\n`)
        .pipe(Effect.mapError((cause) => input.onTempWriteError(cause, tempPath)));
      yield* input.fileSystem
        .rename(tempPath, input.catalogPath)
        .pipe(Effect.mapError(input.onRenameError));
    }).pipe(
      Effect.ensuring(
        input.fileSystem.remove(tempPath, { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not remove a temporary connection catalog file.", {
              tempPath,
              error,
            }),
          ),
        ),
      ),
    );
  });
