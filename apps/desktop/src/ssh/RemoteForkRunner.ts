import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const STARCODE_FORK_REPOSITORY_URL = "https://github.com/michaelvu1207/starcode.git";
export const STARCODE_FORK_ARCHIVE_BASE_URL =
  "https://codeload.github.com/michaelvu1207/starcode/tar.gz";
export const STARCODE_FORK_COMMIT_API_BASE_URL =
  "https://api.github.com/repos/michaelvu1207/starcode/commits";
export const STARCODE_FORK_ARCHIVE_ROOT_PREFIX = "starcode-";
export const STARCODE_FORK_FALLBACK_REF = "hub";

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/iu;
const AppPackageMetadata = Schema.Struct({
  starcodeCommitHash: Schema.optional(Schema.String),
});
const decodeAppPackageMetadata = Schema.decodeUnknownOption(
  Schema.fromJsonString(AppPackageMetadata),
);

function normalizedCommitHash(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return COMMIT_HASH_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function resolveProductionRemoteForkSource(input: {
  readonly commitHashOverride?: string | null;
  readonly appPackageJson?: string | null;
}): {
  readonly repositoryUrl: string;
  readonly archiveBaseUrl: string;
  readonly commitApiBaseUrl: string;
  readonly archiveRootPrefix: string;
  readonly ref: string;
} {
  const override = normalizedCommitHash(input.commitHashOverride);
  const embedded = Option.match(decodeAppPackageMetadata(input.appPackageJson ?? ""), {
    onNone: () => null,
    onSome: (metadata) => normalizedCommitHash(metadata.starcodeCommitHash),
  });
  return {
    repositoryUrl: STARCODE_FORK_REPOSITORY_URL,
    archiveBaseUrl: STARCODE_FORK_ARCHIVE_BASE_URL,
    commitApiBaseUrl: STARCODE_FORK_COMMIT_API_BASE_URL,
    archiveRootPrefix: STARCODE_FORK_ARCHIVE_ROOT_PREFIX,
    ref: override ?? embedded ?? STARCODE_FORK_FALLBACK_REF,
  };
}
