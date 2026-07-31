import { describe, expect, it } from "@effect/vitest";

import {
  resolveProductionRemoteForkSource,
  STARCODE_FORK_ARCHIVE_BASE_URL,
  STARCODE_FORK_ARCHIVE_ROOT_PREFIX,
  STARCODE_FORK_COMMIT_API_BASE_URL,
  STARCODE_FORK_FALLBACK_REF,
  STARCODE_FORK_REPOSITORY_URL,
} from "./RemoteForkRunner.ts";

describe("production remote fork runner", () => {
  it("pins onboarding to the exact fork commit embedded in the desktop artifact", () => {
    expect(
      resolveProductionRemoteForkSource({
        appPackageJson: '{"starcodeCommitHash":"A91B92766E0E9EE9A48A16ACE5E43DB87D6099CB"}',
      }),
    ).toEqual({
      repositoryUrl: STARCODE_FORK_REPOSITORY_URL,
      archiveBaseUrl: STARCODE_FORK_ARCHIVE_BASE_URL,
      commitApiBaseUrl: STARCODE_FORK_COMMIT_API_BASE_URL,
      archiveRootPrefix: STARCODE_FORK_ARCHIVE_ROOT_PREFIX,
      ref: "a91b92766e0e9ee9a48a16ace5e43db87d6099cb",
    });
  });

  it("lets an explicit build commit override embedded metadata", () => {
    expect(
      resolveProductionRemoteForkSource({
        commitHashOverride: "0123456789abcdef",
        appPackageJson: '{"starcodeCommitHash":"aaaaaaaaaaaaaaaa"}',
      }),
    ).toEqual({
      repositoryUrl: STARCODE_FORK_REPOSITORY_URL,
      archiveBaseUrl: STARCODE_FORK_ARCHIVE_BASE_URL,
      commitApiBaseUrl: STARCODE_FORK_COMMIT_API_BASE_URL,
      archiveRootPrefix: STARCODE_FORK_ARCHIVE_ROOT_PREFIX,
      ref: "0123456789abcdef",
    });
  });

  it("falls back to the fork hub branch and never to the upstream npm package", () => {
    expect(
      resolveProductionRemoteForkSource({
        appPackageJson: '{"starcodeCommitHash":"not-a-commit"}',
      }),
    ).toEqual({
      repositoryUrl: STARCODE_FORK_REPOSITORY_URL,
      archiveBaseUrl: STARCODE_FORK_ARCHIVE_BASE_URL,
      commitApiBaseUrl: STARCODE_FORK_COMMIT_API_BASE_URL,
      archiveRootPrefix: STARCODE_FORK_ARCHIVE_ROOT_PREFIX,
      ref: STARCODE_FORK_FALLBACK_REF,
    });
  });
});
