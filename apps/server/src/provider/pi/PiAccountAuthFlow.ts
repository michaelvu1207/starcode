// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off - OAuth attempts are process-local and secrets never cross RPC.
import * as NodeCrypto from "node:crypto";

import type {
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
  PiAccountAuthError,
  ProviderInstanceId,
  type PiAccountAuthProvider,
  type UsageRateLimitSnapshot,
} from "@starcode/contracts";

import {
  discoverPiAccounts,
  makePiCatalogCredentialStore,
  persistCapturedPiAccount,
  resolvePiCredentialEmail,
} from "./PiAccountCatalog.ts";

type Attempt = {
  readonly provider: PiAccountAuthProvider;
  readonly authorizationUrl: string;
  readonly instructions: string;
  readonly credential: Promise<Credential>;
  result?: Credential;
  error?: Error;
  captured: boolean;
};

const attempts = new Map<string, Attempt>();

function abortedPrompt(prompt: AuthPrompt): Promise<string> {
  if (prompt.type === "select") return Promise.resolve(prompt.options[0]?.id ?? "");
  return new Promise((_, reject) => {
    const abort = () =>
      reject(new Error("Authentication prompt was superseded by the browser callback."));
    if (prompt.signal?.aborted) abort();
    else prompt.signal?.addEventListener("abort", abort, { once: true });
  });
}

function credentialIdentity(credential: Credential): Record<string, unknown> {
  if (credential.type !== "oauth") return {};
  const token = credential.access.split(".")[1];
  if (!token) return {};
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function accountPresentation(provider: PiAccountAuthProvider, credential: Credential) {
  const identity = credentialIdentity(credential);
  const credentialFields = credential as unknown as Record<string, unknown>;
  const credentialExtra =
    typeof credentialFields.extra === "object" && credentialFields.extra !== null
      ? (credentialFields.extra as Record<string, unknown>)
      : {};
  const authentication =
    typeof identity["https://api.openai.com/auth"] === "object" &&
    identity["https://api.openai.com/auth"] !== null
      ? (identity["https://api.openai.com/auth"] as Record<string, unknown>)
      : {};
  const email =
    typeof identity.email === "string"
      ? identity.email
      : typeof credentialFields.email === "string"
        ? credentialFields.email
        : typeof credentialExtra.email === "string"
          ? credentialExtra.email
          : await resolvePiCredentialEmail(provider, credential);
  const accountId =
    typeof authentication.chatgpt_account_id === "string"
      ? authentication.chatgpt_account_id
      : undefined;
  const stableSource =
    accountId ??
    email ??
    (credential.type === "oauth" ? credential.refresh : credential.key) ??
    provider;
  const suffix = NodeCrypto.createHash("sha256").update(stableSource).digest("hex").slice(0, 24);
  return {
    id: ProviderInstanceId.make(`starcode_${provider}_${suffix}`),
    label: email ?? `${provider === "anthropic" ? "Claude" : "OpenAI"} account ${suffix.slice(-6)}`,
  };
}

const percent = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
const isoFromSeconds = (value: unknown): string | null =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;

export async function fetchRateLimits(
  provider: PiAccountAuthProvider,
  credential: Credential,
): Promise<UsageRateLimitSnapshot | null> {
  if (credential.type !== "oauth") return null;
  const observedAt = new Date().toISOString();
  const identity = credentialIdentity(credential);
  if (provider === "anthropic") {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${credential.access}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "starcode/0.0.28",
      },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const window = (key: "five_hour" | "seven_day", label: string, minutes: number) => {
      const value =
        typeof body[key] === "object" && body[key] !== null
          ? (body[key] as Record<string, unknown>)
          : {};
      return {
        key,
        label,
        usedPercent: percent(value.utilization ?? value.percent),
        resetsAt: typeof value.resets_at === "string" ? value.resets_at : null,
        windowMinutes: minutes,
      };
    };
    return {
      status: "allowed",
      planLabel: null,
      windows: [window("five_hour", "5-hour", 300), window("seven_day", "Weekly", 10_080)],
      observedAt,
    };
  }
  const authentication =
    typeof identity["https://api.openai.com/auth"] === "object" &&
    identity["https://api.openai.com/auth"] !== null
      ? (identity["https://api.openai.com/auth"] as Record<string, unknown>)
      : {};
  const accountId =
    typeof authentication.chatgpt_account_id === "string"
      ? authentication.chatgpt_account_id
      : undefined;
  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      Authorization: `Bearer ${credential.access}`,
      ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
    },
  });
  if (!response.ok) return null;
  const body = (await response.json()) as Record<string, unknown>;
  const rate =
    typeof body.rate_limit === "object" && body.rate_limit !== null
      ? (body.rate_limit as Record<string, unknown>)
      : body;
  const parseWindow = (key: "primary_window" | "secondary_window", label: string) => {
    const value =
      typeof rate[key] === "object" && rate[key] !== null
        ? (rate[key] as Record<string, unknown>)
        : {};
    const seconds =
      typeof value.limit_window_seconds === "number" ? value.limit_window_seconds : null;
    return {
      key: key === "primary_window" ? "primary" : "secondary",
      label,
      usedPercent: percent(value.used_percent),
      resetsAt: isoFromSeconds(value.reset_at),
      windowMinutes: seconds === null ? null : Math.max(1, Math.round(seconds / 60)),
    };
  };
  return {
    status: rate.limit_reached === true ? "rejected" : "allowed",
    planLabel: typeof body.plan_type === "string" ? body.plan_type : null,
    windows: [parseWindow("primary_window", "5-hour"), parseWindow("secondary_window", "Weekly")],
    observedAt,
  };
}

export async function refreshAllPiAccountUsage(input: {
  readonly stateDir: string;
  readonly secretsDir: string;
}) {
  const accounts = await discoverPiAccounts(input);
  return Promise.all(
    accounts.map(async (account) => {
      const providerId = account.provider === "openai" ? "openai-codex" : "anthropic";
      try {
        const credentials = await makePiCatalogCredentialStore({ ...input, accountId: account.id });
        const authPath = `${account.agentDir}/auth.json`;
        const sources: ReadonlyArray<{
          readonly credentials?: CredentialStore;
          readonly authPath?: string;
        }> = [...(credentials ? [{ credentials }] : []), { authPath }];
        let lastFailure: unknown;
        for (const source of sources) {
          try {
            const runtime = await ModelRuntime.create({
              ...source,
              modelsPath: null,
              allowModelNetwork: false,
            });
            await runtime.getAuth(providerId);
            const credential = source.credentials
              ? await source.credentials.read(providerId)
              : readStoredCredential(providerId, authPath);
            if (!credential) continue;
            const snapshot = await fetchRateLimits(account.provider, credential);
            if (snapshot) return { status: "refreshed" as const, instanceId: account.id, snapshot };
          } catch (cause) {
            lastFailure = cause;
          }
        }
        if (lastFailure !== undefined) throw lastFailure;
        return { status: "unavailable" as const, instanceId: account.id };
      } catch (cause) {
        const rawMessage = cause instanceof Error ? cause.message : "Usage refresh failed.";
        const message = /invalid_grant|refresh token not found|refresh token.*invalid/iu.test(
          rawMessage,
        )
          ? "Starcode's saved authentication expired or was revoked. Sign in again here."
          : /usage limit has been reached/iu.test(rawMessage)
            ? "The subscription usage limit has been reached."
            : rawMessage.split("; stack=", 1)[0]!.slice(0, 240);
        return {
          status: "failed" as const,
          instanceId: account.id,
          message,
        };
      }
    }),
  );
}

export async function startPiAccountAuth(provider: PiAccountAuthProvider) {
  const providerId = provider === "openai" ? "openai-codex" : "anthropic";
  const definition = builtinProviders().find((candidate) => candidate.id === providerId);
  const oauth = definition?.auth.oauth;
  if (!oauth) {
    throw new PiAccountAuthError({
      reason: "unsupported",
      message: `${providerId} OAuth is unavailable.`,
    });
  }

  let resolveLaunch!: (value: { url: string; instructions: string }) => void;
  const launch = new Promise<{ url: string; instructions: string }>((resolve) => {
    resolveLaunch = resolve;
  });
  const interaction: AuthInteraction = {
    prompt: abortedPrompt,
    notify: (event) => {
      if (event.type === "auth_url") {
        resolveLaunch({
          url: event.url,
          instructions: event.instructions ?? "Complete sign-in in your browser.",
        });
      }
    },
  };
  const credential = oauth.login(interaction);
  const launched = await Promise.race([
    launch,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("OAuth did not produce an authorization URL.")), 10_000),
    ),
  ]).catch((cause) => {
    void credential.catch(() => undefined);
    throw new PiAccountAuthError({
      reason: "launch_failed",
      message: cause instanceof Error ? cause.message : "OAuth could not start.",
    });
  });
  const attemptId = NodeCrypto.randomUUID();
  const attempt: Attempt = {
    provider,
    authorizationUrl: launched.url,
    instructions: launched.instructions,
    credential,
    captured: false,
  };
  attempts.set(attemptId, attempt);
  void credential.then(
    (result) => {
      attempt.result = result;
    },
    (cause) => {
      attempt.error = cause instanceof Error ? cause : new Error(String(cause));
    },
  );
  return {
    attemptId,
    provider,
    authorizationUrl: launched.url,
    instructions: launched.instructions,
  };
}

export async function capturePiAccountAuth(input: {
  readonly attemptId: string;
  readonly stateDir: string;
  readonly secretsDir: string;
}) {
  const attempt = attempts.get(input.attemptId);
  if (!attempt)
    throw new PiAccountAuthError({
      reason: "not_found",
      message: "This sign-in attempt expired. Start again.",
    });
  if (attempt.error)
    throw new PiAccountAuthError({ reason: "capture_failed", message: attempt.error.message });
  if (!attempt.result)
    return {
      status: "pending" as const,
      provider: attempt.provider,
      instanceId: null,
      label: null,
    };
  if (attempt.captured)
    throw new PiAccountAuthError({
      reason: "not_found",
      message: "This authentication was already captured.",
    });
  const presentation = await accountPresentation(attempt.provider, attempt.result);
  const rateLimits = await fetchRateLimits(attempt.provider, attempt.result).catch(() => null);
  await persistCapturedPiAccount({
    stateDir: input.stateDir,
    secretsDir: input.secretsDir,
    account: { ...presentation, provider: attempt.provider, credential: attempt.result },
  }).catch((cause) => {
    throw new PiAccountAuthError({
      reason: "capture_failed",
      message: cause instanceof Error ? cause.message : "Credential capture failed.",
    });
  });
  attempt.captured = true;
  attempts.delete(input.attemptId);
  return {
    status: "captured" as const,
    provider: attempt.provider,
    instanceId: presentation.id,
    label: presentation.label,
    rateLimits,
  };
}
