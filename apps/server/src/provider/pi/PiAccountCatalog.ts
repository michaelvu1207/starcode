// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off - catalog migration validates owner-only host files and OAuth expiry timestamps; provider profile discovery uses the provider's OAuth endpoint.
import * as NodeCrypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { promisify } from "node:util";

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { ProviderInstanceId } from "@starcode/contracts";

const CATALOG_FILE = "pi-accounts.json";
const CATALOG_SECRET_DIRECTORY = "pi-accounts";
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_SECRET_BYTES = 2 * 1024 * 1024;
const ACCOUNT_ID_PATTERN = /^(?:ccc|starcode)_(anthropic|openai)_[a-zA-Z0-9_-]+$/u;
const SAFE_SECRET_REF_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/u;
const mutationQueues = new Map<string, Promise<void>>();
const execFile = promisify(execFileCallback);
let keychainAccountCache:
  | { readonly expiresAt: number; readonly value: Promise<ReadonlyArray<string>> }
  | undefined;

export type PiCatalogProvider = "anthropic" | "openai";

interface StoredCatalogAccount {
  readonly id: ProviderInstanceId;
  readonly label: string;
  readonly provider: PiCatalogProvider;
  readonly status: string;
  readonly sourceActive: boolean;
  readonly secretRef?: string;
}

export interface CapturedPiAccount {
  readonly id: ProviderInstanceId;
  readonly label: string;
  readonly provider: PiCatalogProvider;
  readonly credential: Credential;
}

interface StoredApiKeySecret {
  readonly kind: "apiKey";
  readonly value: string;
}

interface StoredOAuthSecret {
  readonly kind: "oauth";
  readonly providerId: "anthropic" | "openai-codex";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly extra?: Readonly<Record<string, unknown>>;
}

type StoredSecret = StoredApiKeySecret | StoredOAuthSecret;

/**
 * In-memory account material used by authenticated fleet synchronization.
 * Callers must never persist this value in fleet.json, logs, or projections.
 */
export interface TransferablePiAccount {
  readonly id: ProviderInstanceId;
  readonly label: string;
  readonly provider: PiCatalogProvider;
  readonly credential:
    | { readonly type: "api_key"; readonly key: string }
    | {
        readonly type: "oauth";
        readonly access: string;
        readonly refresh: string;
        readonly expires: number;
        readonly extra?: Readonly<Record<string, unknown>> | undefined;
      };
}

function toTransferableCredential(
  credential: Credential,
): TransferablePiAccount["credential"] | undefined {
  if (credential.type === "api_key") {
    const key = nonEmptyString(credential.key);
    return key ? { type: "api_key", key } : undefined;
  }
  const { type: _type, access, refresh, expires, ...extra } = credential;
  return {
    type: "oauth",
    access,
    refresh,
    expires,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

function fromTransferableCredential(credential: TransferablePiAccount["credential"]): Credential {
  return credential.type === "api_key"
    ? { type: "api_key", key: credential.key }
    : {
        ...(credential.extra ?? {}),
        type: "oauth",
        access: credential.access,
        refresh: credential.refresh,
        expires: credential.expires,
      };
}

export interface DiscoveredPiAccount {
  readonly id: ProviderInstanceId;
  readonly label: string;
  readonly provider: PiCatalogProvider;
  readonly status: string;
  readonly sourceActive: boolean;
  readonly agentDir: string;
  readonly hasUsableCredential: boolean;
  readonly credentialSource:
    | "starcode"
    | "claude-code"
    | "claude-manager"
    | "codex"
    | "agent-file"
    | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const providerFromAccountId = (id: string): PiCatalogProvider | undefined => {
  const match = ACCOUNT_ID_PATTERN.exec(id);
  return match?.[1] === "anthropic" || match?.[1] === "openai" ? match[1] : undefined;
};

const providerOAuthCredentialId = (provider: PiCatalogProvider): string =>
  provider === "anthropic" ? "anthropic" : "openai-codex";

const providerCredentialId = (provider: PiCatalogProvider, secret: StoredSecret): string =>
  secret.kind === "apiKey" && provider === "openai"
    ? "openai"
    : providerOAuthCredentialId(provider);

function externalAccountId(provider: PiCatalogProvider, identity: string): ProviderInstanceId {
  const suffix = NodeCrypto.createHash("sha256")
    .update(identity.toLowerCase())
    .digest("hex")
    .slice(0, 24);
  return ProviderInstanceId.make(`starcode_${provider}_${suffix}`);
}

function parseCatalogAccount(value: unknown): StoredCatalogAccount | undefined {
  if (!isRecord(value)) return undefined;
  const rawId = nonEmptyString(value.id);
  const label = nonEmptyString(value.label);
  const provider = value.provider;
  if (
    !rawId ||
    !label ||
    (provider !== "anthropic" && provider !== "openai") ||
    providerFromAccountId(rawId) !== provider
  ) {
    return undefined;
  }
  let id: ProviderInstanceId;
  try {
    id = ProviderInstanceId.make(rawId);
  } catch {
    return undefined;
  }
  const secretRef = nonEmptyString(value.secretRef);
  return {
    id,
    label,
    provider,
    status: nonEmptyString(value.status) ?? "unconfigured",
    sourceActive: value.sourceActive === true,
    ...(secretRef && SAFE_SECRET_REF_PATTERN.test(secretRef) ? { secretRef } : {}),
  };
}

async function readOwnerFile(path: string, maxBytes: number): Promise<string> {
  let file: NodeFSP.FileHandle | undefined;
  try {
    file = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("invalid-file");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("invalid-owner");
    }
    if ((stat.mode & 0o077) !== 0) throw new Error("invalid-mode");
    return await file.readFile("utf8");
  } catch {
    throw new Error("Catalogued Pi account data is unavailable.");
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function readCatalogAccounts(stateDir: string): Promise<ReadonlyArray<StoredCatalogAccount>> {
  try {
    const raw = await readOwnerFile(NodePath.join(stateDir, CATALOG_FILE), MAX_CATALOG_BYTES);
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !Array.isArray(value.accounts)) return [];
    return value.accounts.flatMap((candidate) => {
      const account = parseCatalogAccount(candidate);
      return account ? [account] : [];
    });
  } catch {
    // A missing or malformed historical catalog must not prevent directory
    // fallback or isolate other configured Pi instances.
    return [];
  }
}

function parseStoredSecret(
  value: unknown,
  account: StoredCatalogAccount,
): StoredSecret | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "apiKey") {
    const apiKey = nonEmptyString(value.value);
    return apiKey ? { kind: "apiKey", value: apiKey } : undefined;
  }
  if (value.kind !== "oauth") return undefined;
  const providerId = value.providerId;
  const expectedProviderId = providerOAuthCredentialId(account.provider);
  const access = nonEmptyString(value.access);
  const refresh = nonEmptyString(value.refresh);
  const expires = value.expires;
  if (
    providerId !== expectedProviderId ||
    (providerId !== "anthropic" && providerId !== "openai-codex") ||
    !access ||
    !refresh ||
    typeof expires !== "number" ||
    !Number.isFinite(expires)
  ) {
    return undefined;
  }
  return {
    kind: "oauth",
    providerId,
    access,
    refresh,
    expires,
    ...(isRecord(value.extra) ? { extra: value.extra } : {}),
  };
}

const secretPath = (secretsDir: string, secretRef: string): string =>
  NodePath.join(secretsDir, CATALOG_SECRET_DIRECTORY, `${secretRef}.json`);

async function readStoredSecret(
  account: StoredCatalogAccount,
  secretsDir: string,
): Promise<StoredSecret | undefined> {
  if (!account.secretRef) return undefined;
  try {
    const raw = await readOwnerFile(secretPath(secretsDir, account.secretRef), MAX_SECRET_BYTES);
    return parseStoredSecret(JSON.parse(raw), account);
  } catch {
    return undefined;
  }
}

function storedSecretToCredential(secret: StoredSecret): Credential {
  if (secret.kind === "apiKey") return { type: "api_key", key: secret.value };
  return {
    ...secret.extra,
    type: "oauth",
    access: secret.access,
    refresh: secret.refresh,
    expires: secret.expires,
  };
}

function credentialToStoredSecret(
  credential: Credential,
  account: StoredCatalogAccount,
): StoredSecret | undefined {
  if (credential.type === "api_key") {
    const value = nonEmptyString(credential.key);
    return value ? { kind: "apiKey", value } : undefined;
  }
  const access = nonEmptyString(credential.access);
  const refresh = nonEmptyString(credential.refresh);
  if (!access || !refresh || !Number.isFinite(credential.expires)) return undefined;
  const {
    type: _type,
    access: _access,
    refresh: _refresh,
    expires: _expires,
    ...extra
  } = credential;
  return {
    kind: "oauth",
    providerId: providerOAuthCredentialId(account.provider) as StoredOAuthSecret["providerId"],
    access,
    refresh,
    expires: credential.expires,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

async function writeSecretAtomically(path: string, secret: StoredSecret): Promise<void> {
  const directory = NodePath.dirname(path);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = NodePath.join(
    directory,
    `.${NodePath.basename(path)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  try {
    await NodeFSP.writeFile(temporaryPath, `${JSON.stringify(secret, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await NodeFSP.rename(temporaryPath, path);
    await NodeFSP.chmod(path, 0o600);
  } catch {
    throw new Error("Catalogued Pi account credential could not be persisted.");
  } finally {
    await NodeFSP.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const directory = NodePath.dirname(path);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = NodePath.join(
    directory,
    `.${NodePath.basename(path)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  try {
    await NodeFSP.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await NodeFSP.rename(temporaryPath, path);
    await NodeFSP.chmod(path, 0o600);
  } finally {
    await NodeFSP.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/** Persist a credential returned by Pi's native OAuth flow without exposing it to the client. */
export async function persistCapturedPiAccount(input: {
  readonly stateDir: string;
  readonly secretsDir: string;
  readonly account: CapturedPiAccount;
  /** Fleet refreshes must not change this machine's active-account preference. */
  readonly preserveSourceActive?: boolean;
}): Promise<void> {
  const catalogPath = NodePath.join(input.stateDir, CATALOG_FILE);
  await enqueueCredentialMutation(catalogPath, async () => {
    const existing = await readCatalogAccounts(input.stateDir);
    const secretRef = `oauth-${NodeCrypto.createHash("sha256").update(String(input.account.id)).digest("hex").slice(0, 24)}`;
    const catalogAccount: StoredCatalogAccount = {
      id: input.account.id,
      label: input.account.label,
      provider: input.account.provider,
      status: "ready",
      sourceActive: input.preserveSourceActive
        ? (existing.find((candidate) => candidate.id === input.account.id)?.sourceActive ?? false)
        : true,
      secretRef,
    };
    const stored = credentialToStoredSecret(input.account.credential, catalogAccount);
    if (!stored) throw new Error("Captured Pi account credential was invalid.");
    await writeSecretAtomically(secretPath(input.secretsDir, secretRef), stored);
    const accounts = [
      ...existing.filter((candidate) => candidate.id !== catalogAccount.id),
      catalogAccount,
    ];
    await writeJsonAtomically(catalogPath, { version: 1, accounts });
  });
}

/** Export usable subscription credentials without exposing them to provider snapshots. */
export async function exportTransferablePiAccounts(input: {
  readonly stateDir: string;
  readonly secretsDir: string;
}): Promise<ReadonlyArray<TransferablePiAccount>> {
  const accounts = await resolvedCatalogAccounts(input.stateDir);
  const exported = await Promise.all(
    accounts.map(async (account): Promise<TransferablePiAccount | undefined> => {
      const external = await externalSource(account);
      const externalCredential = await external?.read();
      const stored = account.secretRef
        ? await readStoredSecret(account, input.secretsDir)
        : undefined;
      const credential =
        externalCredential ?? (stored ? storedSecretToCredential(stored) : undefined);
      const transferable = credential ? toTransferableCredential(credential) : undefined;
      return transferable
        ? {
            id: account.id,
            label: account.label,
            provider: account.provider,
            credential: transferable,
          }
        : undefined;
    }),
  );
  return exported.filter((account): account is TransferablePiAccount => account !== undefined);
}

/** Add or refresh fleet-supplied accounts in Starcode's private Pi account store. */
export async function importTransferablePiAccounts(input: {
  readonly stateDir: string;
  readonly secretsDir: string;
  readonly accounts: ReadonlyArray<TransferablePiAccount>;
}): Promise<{ readonly imported: number }> {
  for (const account of input.accounts) {
    await persistCapturedPiAccount({
      stateDir: input.stateDir,
      secretsDir: input.secretsDir,
      account: { ...account, credential: fromTransferableCredential(account.credential) },
      preserveSourceActive: true,
    });
  }
  return { imported: input.accounts.length };
}

/** Remove an account from Starcode without mutating the source CLI login. */
export async function deletePiAccount(input: {
  readonly stateDir: string;
  readonly secretsDir: string;
  readonly instanceId: ProviderInstanceId;
}): Promise<void> {
  const catalogPath = NodePath.join(input.stateDir, CATALOG_FILE);
  await enqueueCredentialMutation(catalogPath, async () => {
    const existing = await readCatalogAccounts(input.stateDir);
    const discovered = await discoverPiAccounts({
      stateDir: input.stateDir,
      secretsDir: input.secretsDir,
    });
    const target = discovered.find((account) => account.id === input.instanceId);
    if (!target) throw new Error("Account not found.");
    const stored = existing.find((account) => account.id === input.instanceId);
    if (stored?.secretRef) {
      await NodeFSP.rm(secretPath(input.secretsDir, stored.secretRef), { force: true });
    }
    const tombstone: StoredCatalogAccount = {
      id: target.id,
      label: target.label,
      provider: target.provider,
      status: "hidden",
      sourceActive: false,
    };
    await writeJsonAtomically(catalogPath, {
      version: 1,
      accounts: [...existing.filter((account) => account.id !== input.instanceId), tombstone],
    });
  });
}

async function enqueueCredentialMutation<A>(path: string, operation: () => Promise<A>): Promise<A> {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationQueues.set(path, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationQueues.get(path) === current) mutationQueues.delete(path);
  }
}

class CatalogCredentialStore implements CredentialStore {
  readonly #account: StoredCatalogAccount;
  readonly #path: string;
  readonly #secretsDir: string;

  constructor(account: StoredCatalogAccount, secretsDir: string) {
    this.#account = account;
    this.#secretsDir = secretsDir;
    this.#path = secretPath(secretsDir, account.secretRef!);
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const secret = await readStoredSecret(this.#account, this.#secretsDir);
    if (!secret || providerId !== providerCredentialId(this.#account.provider, secret)) {
      return undefined;
    }
    return storedSecretToCredential(secret);
  }

  async list(): Promise<ReadonlyArray<CredentialInfo>> {
    const secret = await readStoredSecret(this.#account, this.#secretsDir);
    if (!secret) return [];
    return [
      {
        providerId: providerCredentialId(this.#account.provider, secret),
        type: storedSecretToCredential(secret).type,
      },
    ];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return enqueueCredentialMutation(this.#path, async () => {
      const currentSecret = await readStoredSecret(this.#account, this.#secretsDir);
      if (
        !currentSecret ||
        providerId !== providerCredentialId(this.#account.provider, currentSecret)
      ) {
        throw new Error("Catalogued Pi account provider does not match the requested model.");
      }
      const current = storedSecretToCredential(currentSecret);
      const next = await fn(current);
      if (next === undefined) return current;
      const expectedProviderId =
        next.type === "api_key" && this.#account.provider === "openai"
          ? "openai"
          : providerOAuthCredentialId(this.#account.provider);
      if (providerId !== expectedProviderId) {
        throw new Error("Catalogued Pi account credential type changed providers.");
      }
      const stored = credentialToStoredSecret(next, this.#account);
      if (!stored) throw new Error("Catalogued Pi account credential update was invalid.");
      await writeSecretAtomically(this.#path, stored);
      return next;
    });
  }

  async delete(): Promise<void> {
    // Catalog ownership stays with the native Pi account store. There is no
    // account-management RPC in this compatibility bridge, so a runtime
    // logout must not silently delete the source credential.
    throw new Error("Manage this credential from the Pi account owner.");
  }
}

type ExternalCredentialSource = {
  readonly name: "claude-code" | "claude-manager" | "codex";
  readonly providerId: "anthropic" | "openai-codex";
  readonly read: () => Promise<Credential | undefined>;
  readonly write: (credential: Credential) => Promise<void>;
};

function jwtClaims(token: string | undefined): Record<string, unknown> {
  const payload = token?.split(".")[1];
  if (!payload) return {};
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

const findEmail = (value: unknown, depth = 0): string | undefined => {
  if (depth > 4 || !isRecord(value)) return undefined;
  for (const key of ["email", "email_address", "emailAddress"]) {
    const email = nonEmptyString(value[key]);
    if (email?.includes("@")) return email;
  }
  for (const child of Object.values(value)) {
    const email = findEmail(child, depth + 1);
    if (email) return email;
  }
  return undefined;
};

/** Resolve the user-facing email from a provider credential without exposing the credential. */
export async function resolvePiCredentialEmail(
  provider: PiCatalogProvider,
  credential: Credential,
): Promise<string | undefined> {
  if (credential.type !== "oauth") return undefined;
  const inline = findEmail(credential) ?? findEmail(jwtClaims(credential.access));
  if (inline) return inline;
  if (provider !== "anthropic") return undefined;
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/account/settings", {
      headers: {
        Authorization: `Bearer ${credential.access}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "starcode/0.0.28",
      },
    });
    return response.ok ? findEmail(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}

function credentialMatchesAccount(account: StoredCatalogAccount, credential: Credential): boolean {
  if (credential.type !== "oauth") return true;
  const claims = jwtClaims(credential.access);
  const auth = isRecord(claims["https://api.openai.com/auth"])
    ? claims["https://api.openai.com/auth"]
    : {};
  const identities = [claims.email, auth.chatgpt_account_id, credential.email, credential.accountId]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  return (
    identities.length === 0 ||
    identities.some((identity) => account.label.toLowerCase().includes(identity))
  );
}

async function ownerJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readOwnerFile(path, MAX_SECRET_BYTES));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function claudeCodeKeychainAccounts(): Promise<ReadonlyArray<string>> {
  if (process.platform !== "darwin") return [];
  if (keychainAccountCache && keychainAccountCache.expiresAt > Date.now())
    return keychainAccountCache.value;
  const value = (async () => {
    try {
      const { stdout } = await execFile("security", ["dump-keychain"], {
        maxBuffer: 16 * 1024 * 1024,
      });
      return [
        ...stdout.matchAll(/"acct"<blob>="([^"]+)"[\s\S]{0,900}?"svce"<blob>="claude-code"/gu),
      ]
        .map((match) => match[1]!)
        .filter((candidate, index, all) => all.indexOf(candidate) === index);
    } catch {
      return [];
    }
  })();
  keychainAccountCache = { expiresAt: Date.now() + 5_000, value };
  return value;
}

async function claudeManagerSource(
  account: StoredCatalogAccount,
): Promise<ExternalCredentialSource | undefined> {
  if (account.provider !== "anthropic" || process.platform !== "darwin") return undefined;
  const normalizedLabel = account.label.toLowerCase();
  const keychainAccount = (await claudeCodeKeychainAccounts()).find((candidate) =>
    normalizedLabel.includes(candidate.replace(/^account-\d+-/u, "").toLowerCase()),
  );
  if (!keychainAccount) return undefined;
  const readRaw = async (): Promise<Record<string, unknown> | undefined> => {
    try {
      const { stdout } = await execFile("security", [
        "find-generic-password",
        "-s",
        "claude-code",
        "-a",
        keychainAccount,
        "-w",
      ]);
      const value: unknown = JSON.parse(stdout.trim());
      return isRecord(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    name: "claude-manager",
    providerId: "anthropic",
    read: async () => {
      const root = await readRaw();
      const oauth = root && isRecord(root.claudeAiOauth) ? root.claudeAiOauth : undefined;
      const access = oauth && nonEmptyString(oauth.accessToken);
      const refresh = oauth && nonEmptyString(oauth.refreshToken);
      const expires = oauth?.expiresAt;
      return access && refresh && typeof expires === "number"
        ? { type: "oauth", access, refresh, expires }
        : undefined;
    },
    write: async (credential) => {
      if (credential.type !== "oauth") throw new Error("Claude Code requires OAuth credentials.");
      const root = await readRaw();
      if (!root || !isRecord(root.claudeAiOauth))
        throw new Error("Claude Code login is unavailable.");
      const next = {
        ...root,
        claudeAiOauth: {
          ...root.claudeAiOauth,
          accessToken: credential.access,
          refreshToken: credential.refresh,
          expiresAt: credential.expires,
        },
      };
      await execFile("security", [
        "add-generic-password",
        "-U",
        "-s",
        "claude-code",
        "-a",
        keychainAccount,
        "-w",
        JSON.stringify(next),
      ]);
    },
  };
}

async function nativeClaudeCodeSource(
  account: StoredCatalogAccount,
): Promise<ExternalCredentialSource | undefined> {
  if (account.provider !== "anthropic" || process.platform !== "darwin") return undefined;
  const profile = await ownerJson(NodePath.join(NodeOS.homedir(), ".claude.json"));
  const oauthAccount = profile && isRecord(profile.oauthAccount) ? profile.oauthAccount : undefined;
  const email = oauthAccount && nonEmptyString(oauthAccount.emailAddress);
  if (!email || account.label.toLowerCase() !== email.toLowerCase()) return undefined;
  const keychainAccount = NodeOS.userInfo().username;
  const readRaw = async (): Promise<Record<string, unknown> | undefined> => {
    try {
      const { stdout } = await execFile("security", [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-a",
        keychainAccount,
        "-w",
      ]);
      const value: unknown = JSON.parse(stdout.trim());
      return isRecord(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    name: "claude-code",
    providerId: "anthropic",
    read: async () => {
      const root = await readRaw();
      const oauth = root && isRecord(root.claudeAiOauth) ? root.claudeAiOauth : undefined;
      const access = oauth && nonEmptyString(oauth.accessToken);
      const refresh = oauth && nonEmptyString(oauth.refreshToken);
      const expires = oauth?.expiresAt;
      return access && refresh && typeof expires === "number"
        ? { type: "oauth", access, refresh, expires }
        : undefined;
    },
    write: async (credential) => {
      if (credential.type !== "oauth") throw new Error("Claude Code requires OAuth credentials.");
      const root = await readRaw();
      if (!root || !isRecord(root.claudeAiOauth))
        throw new Error("Claude Code login is unavailable.");
      const next = {
        ...root,
        claudeAiOauth: {
          ...root.claudeAiOauth,
          accessToken: credential.access,
          refreshToken: credential.refresh,
          expiresAt: credential.expires,
        },
      };
      await execFile("security", [
        "add-generic-password",
        "-U",
        "-s",
        "Claude Code-credentials",
        "-a",
        keychainAccount,
        "-w",
        JSON.stringify(next),
      ]);
    },
  };
}

async function codexSource(
  account: StoredCatalogAccount,
): Promise<ExternalCredentialSource | undefined> {
  if (account.provider !== "openai") return undefined;
  const authPath = NodePath.join(NodeOS.homedir(), ".codex", "auth.json");
  const readRaw = () => ownerJson(authPath);
  const readCredential = async (): Promise<Credential | undefined> => {
    const root = await readRaw();
    const tokens = root && isRecord(root.tokens) ? root.tokens : undefined;
    const access = tokens && nonEmptyString(tokens.access_token);
    const refresh = tokens && nonEmptyString(tokens.refresh_token);
    if (!access || !refresh) return undefined;
    const claims = jwtClaims(access);
    const expires = typeof claims.exp === "number" ? claims.exp * 1000 : Date.now() + 60_000;
    const identity =
      tokens && nonEmptyString(tokens.id_token) ? jwtClaims(String(tokens.id_token)) : {};
    const email = nonEmptyString(identity.email);
    const accountId = tokens && nonEmptyString(tokens.account_id);
    return {
      type: "oauth",
      access,
      refresh,
      expires,
      ...(email ? { email } : {}),
      ...(accountId ? { accountId } : {}),
    };
  };
  const credential = await readCredential();
  if (!credential || !credentialMatchesAccount(account, credential)) return undefined;
  return {
    name: "codex",
    providerId: "openai-codex",
    read: readCredential,
    write: async (next) => {
      if (next.type !== "oauth") throw new Error("Codex requires OAuth credentials.");
      const root = await readRaw();
      if (!root || !isRecord(root.tokens)) throw new Error("Codex login is unavailable.");
      await writeJsonAtomically(authPath, {
        ...root,
        tokens: { ...root.tokens, access_token: next.access, refresh_token: next.refresh },
        last_refresh: new Date().toISOString(),
      });
    },
  };
}

async function discoverExternalAccounts(): Promise<ReadonlyArray<StoredCatalogAccount>> {
  const claudeAccounts = (await claudeCodeKeychainAccounts()).map((keychainAccount) => {
    const label = keychainAccount.replace(/^account-\d+-/u, "");
    return {
      id: externalAccountId("anthropic", label),
      label,
      provider: "anthropic" as const,
      status: "ready",
      sourceActive: true,
    };
  });
  const codexRoot = await ownerJson(NodePath.join(NodeOS.homedir(), ".codex", "auth.json"));
  const tokens = codexRoot && isRecord(codexRoot.tokens) ? codexRoot.tokens : undefined;
  const identity =
    tokens && nonEmptyString(tokens.id_token) ? jwtClaims(String(tokens.id_token)) : {};
  const email = nonEmptyString(identity.email);
  const accountId = tokens && nonEmptyString(tokens.account_id);
  const codexAccounts: ReadonlyArray<StoredCatalogAccount> =
    email || accountId
      ? [
          {
            id: externalAccountId("openai", accountId ?? email!),
            label: email ?? `OpenAI ${accountId!.slice(-6)}`,
            provider: "openai",
            status: "ready",
            sourceActive: true,
          },
        ]
      : [];
  return [...claudeAccounts, ...codexAccounts];
}

async function resolvedCatalogAccounts(
  stateDir: string,
): Promise<ReadonlyArray<StoredCatalogAccount>> {
  const stored = await readCatalogAccounts(stateDir);
  if (process.env.NODE_ENV === "test")
    return stored.filter((account) => account.status !== "hidden");
  const external = await discoverExternalAccounts();
  const result = [...stored];
  for (const candidate of external) {
    const matchingIndex = result.findIndex(
      (account) =>
        account.provider === candidate.provider &&
        account.label.toLowerCase() === candidate.label.toLowerCase(),
    );
    if (matchingIndex < 0) result.push(candidate);
  }
  return result.filter((account) => account.status !== "hidden");
}

async function externalSource(
  account: StoredCatalogAccount,
): Promise<ExternalCredentialSource | undefined> {
  if (account.provider === "openai") return codexSource(account);
  return (await nativeClaudeCodeSource(account)) ?? claudeManagerSource(account);
}

class ResolvedCredentialStore implements CredentialStore {
  readonly #external: ExternalCredentialSource | undefined;
  readonly #catalog: CatalogCredentialStore | undefined;

  constructor(
    external: ExternalCredentialSource | undefined,
    catalog: CatalogCredentialStore | undefined,
  ) {
    this.#external = external;
    this.#catalog = catalog;
  }
  async read(providerId: string): Promise<Credential | undefined> {
    if (this.#external?.providerId === providerId)
      return (await this.#external.read()) ?? this.#catalog?.read(providerId);
    return this.#catalog?.read(providerId);
  }
  async list(): Promise<ReadonlyArray<CredentialInfo>> {
    if (this.#external && (await this.#external.read()))
      return [{ providerId: this.#external.providerId, type: "oauth" }];
    return (await this.#catalog?.list()) ?? [];
  }
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (this.#external?.providerId === providerId) {
      const current = await this.#external.read();
      const next = await fn(current);
      if (next) await this.#external.write(next);
      return next ?? current;
    }
    if (!this.#catalog) throw new Error("No credential source is available for this account.");
    return this.#catalog.modify(providerId, fn);
  }
  async delete(): Promise<void> {
    throw new Error("Manage this login from Connections.");
  }
}

async function hasUsableAuthFile(agentDir: string): Promise<boolean> {
  try {
    const raw = await readOwnerFile(NodePath.join(agentDir, "auth.json"), MAX_SECRET_BYTES);
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return false;
    return Object.values(value).some(
      (credential) =>
        isRecord(credential) && (credential.type === "api_key" || credential.type === "oauth"),
    );
  } catch {
    return false;
  }
}

export async function discoverPiAccounts(input: {
  readonly stateDir: string;
  readonly secretsDir: string;
}): Promise<ReadonlyArray<DiscoveredPiAccount>> {
  const piDirectory = NodePath.join(input.stateDir, "pi");
  const catalog = await resolvedCatalogAccounts(input.stateDir);
  let directoryNames: ReadonlyArray<string> = [];
  try {
    directoryNames = (await NodeFSP.readdir(piDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && providerFromAccountId(entry.name) !== undefined)
      .map((entry) => entry.name);
  } catch {
    directoryNames = [];
  }

  const catalogById = new Map(catalog.map((account) => [account.id, account]));
  const ids = [
    ...new Set([...catalog.map((account) => String(account.id)), ...directoryNames]),
  ].sort();
  return Promise.all(
    ids.flatMap((rawId) => {
      const provider = providerFromAccountId(rawId);
      if (!provider) return [];
      const id = ProviderInstanceId.make(rawId);
      const account = catalogById.get(id);
      const agentDir = NodePath.join(piDirectory, rawId);
      return [
        Promise.all([
          account ? readStoredSecret(account, input.secretsDir) : Promise.resolve(undefined),
          hasUsableAuthFile(agentDir),
          account ? externalSource(account) : Promise.resolve(undefined),
        ]).then(async ([storedSecret, usableAuthFile, liveSource]) => ({
          id,
          label:
            (account?.label.startsWith("Claude account ") && storedSecret
              ? await resolvePiCredentialEmail(provider, storedSecretToCredential(storedSecret))
              : undefined) ??
            account?.label ??
            `${provider === "anthropic" ? "Anthropic" : "OpenAI"} ${rawId.slice(-6)}`,
          provider,
          status: account?.status ?? (usableAuthFile ? "ready" : "unconfigured"),
          sourceActive: account?.sourceActive ?? false,
          agentDir,
          hasUsableCredential:
            liveSource !== undefined || storedSecret !== undefined || usableAuthFile,
          credentialSource:
            liveSource?.name ??
            (storedSecret
              ? ("starcode" as const)
              : usableAuthFile
                ? ("agent-file" as const)
                : null),
        })),
      ];
    }),
  );
}

/** Prefer an explicitly active ready account, then OpenAI for Starcode's preferred GPT model. */
export function selectDefaultPiAccount(
  accounts: ReadonlyArray<DiscoveredPiAccount>,
): DiscoveredPiAccount | undefined {
  return [...accounts]
    .filter((account) => account.status === "ready" && account.hasUsableCredential)
    .sort(
      (left, right) =>
        Number(right.sourceActive) - Number(left.sourceActive) ||
        Number(right.provider === "openai") - Number(left.provider === "openai") ||
        String(left.id).localeCompare(String(right.id)),
    )[0];
}

/** Runtime-only vault adapter. Public provider snapshots never receive the secret reference. */
export async function makePiCatalogCredentialStore(input: {
  readonly stateDir: string;
  readonly secretsDir: string;
  readonly accountId: string;
}): Promise<CredentialStore | undefined> {
  const account = (await resolvedCatalogAccounts(input.stateDir)).find(
    (candidate) => candidate.id === input.accountId,
  );
  if (!account) return undefined;
  const secret = account.secretRef ? await readStoredSecret(account, input.secretsDir) : undefined;
  const catalog = secret ? new CatalogCredentialStore(account, input.secretsDir) : undefined;
  const external = await externalSource(account);
  return external || catalog ? new ResolvedCredentialStore(external, catalog) : undefined;
}
