// @effect-diagnostics nodeBuiltinImport:off globalDate:off - tests exercise owner-only catalog files and OAuth expiries.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_SERVER_SETTINGS,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@starcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { deriveProviderInstanceConfigMap } from "../Layers/ProviderInstanceRegistryHydration.ts";
import { makePiModelRuntime, piModelSlug } from "./PiModels.ts";
import {
  discoverPiAccounts,
  deletePiAccount,
  exportTransferablePiAccounts,
  importTransferablePiAccounts,
  makePiCatalogCredentialStore,
  persistCapturedPiAccount,
  selectDefaultPiAccount,
} from "./PiAccountCatalog.ts";

const decodePiSettings = Schema.decodeUnknownSync(PiSettings);

const writeOwnerJson = (path: string, value: unknown): void => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  NodeFS.chmodSync(path, 0o600);
};

const withFixture = async <A>(
  run: (fixture: { readonly stateDir: string; readonly secretsDir: string }) => Promise<A>,
): Promise<A> => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "starcode-pi-catalog-"));
  const stateDir = NodePath.join(root, "state");
  const secretsDir = NodePath.join(stateDir, "secrets");
  try {
    return await run({ stateDir, secretsDir });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
};

const account = (input: {
  readonly id: string;
  readonly label: string;
  readonly provider: "anthropic" | "openai";
  readonly secretRef: string;
  readonly sourceActive?: boolean;
}) => ({
  ...input,
  credentialKind: "oauth",
  status: "ready",
  models: [],
  allowedModels: [],
  source: "ccc",
  sourceActive: input.sourceActive ?? false,
});

const oauthSecret = (providerId: "anthropic" | "openai-codex", marker: string) => ({
  kind: "oauth",
  providerId,
  access: `${marker}-access-secret`,
  refresh: `${marker}-refresh-secret`,
  expires: Date.now() + 60 * 60 * 1000,
  ...(providerId === "openai-codex" ? { extra: { accountId: `${marker}-account` } } : {}),
});

describe("Pi account catalog bridge", () => {
  it("exports and imports usable accounts without placing secrets in discovery metadata", () =>
    withFixture(async (source) => {
      const id = ProviderInstanceId.make("starcode_openai_eeeeeeeeeeeeeeeeeeeeeeee");
      await persistCapturedPiAccount({
        ...source,
        account: {
          id,
          label: "fleet@example.com",
          provider: "openai",
          credential: {
            type: "oauth",
            access: "fleet-access-secret",
            refresh: "fleet-refresh-secret",
            expires: Date.now() + 60_000,
          },
        },
      });
      const exported = await exportTransferablePiAccounts(source);
      expect(exported).toHaveLength(1);

      await withFixture(async (target) => {
        expect(await importTransferablePiAccounts({ ...target, accounts: exported })).toEqual({
          imported: 1,
        });
        const discovered = await discoverPiAccounts(target);
        expect(discovered).toMatchObject([{ id, label: "fleet@example.com", sourceActive: false }]);
        expect(JSON.stringify(discovered)).not.toContain("fleet-access-secret");
        const store = await makePiCatalogCredentialStore({ ...target, accountId: id });
        expect(await store?.read("openai-codex")).toMatchObject({
          access: "fleet-access-secret",
          refresh: "fleet-refresh-secret",
        });
      });
    }));

  it("preserves a destination's active-account preference during fleet refresh", () =>
    withFixture(async (target) => {
      const id = ProviderInstanceId.make("starcode_openai_ffffffffffffffffffffffff");
      const account = {
        id,
        label: "active@example.com",
        provider: "openai" as const,
        credential: {
          type: "oauth" as const,
          access: "first-access-secret",
          refresh: "first-refresh-secret",
          expires: Date.now() + 60_000,
        },
      };
      await persistCapturedPiAccount({ ...target, account });
      await importTransferablePiAccounts({
        ...target,
        accounts: [
          {
            ...account,
            credential: {
              ...account.credential,
              access: "refreshed-access-secret",
            },
          },
        ],
      });

      expect(await discoverPiAccounts(target)).toMatchObject([{ id, sourceActive: true }]);
    }));

  it("persists a native Starcode OAuth capture as an isolated Pi account", () =>
    withFixture(async ({ stateDir, secretsDir }) => {
      const id = ProviderInstanceId.make("starcode_openai_aaaaaaaaaaaaaaaaaaaaaaaa");
      await persistCapturedPiAccount({
        stateDir,
        secretsDir,
        account: {
          id,
          label: "native@example.com",
          provider: "openai",
          credential: {
            type: "oauth",
            access: "native-access-secret",
            refresh: "native-refresh-secret",
            expires: Date.now() + 60_000,
          },
        },
      });
      const [discovered] = await discoverPiAccounts({ stateDir, secretsDir });
      expect(discovered).toMatchObject({
        id,
        label: "native@example.com",
        hasUsableCredential: true,
      });
      const store = await makePiCatalogCredentialStore({ stateDir, secretsDir, accountId: id });
      expect(await store?.read("openai-codex")).toMatchObject({ access: "native-access-secret" });
    }));
  it("removes a saved account and suppresses it from discovery", () =>
    withFixture(async ({ stateDir, secretsDir }) => {
      const id = ProviderInstanceId.make("starcode_anthropic_bbbbbbbbbbbbbbbbbbbbbbbb");
      await persistCapturedPiAccount({
        stateDir,
        secretsDir,
        account: {
          id,
          label: "remove@example.com",
          provider: "anthropic",
          credential: {
            type: "oauth",
            access: "remove-access-secret",
            refresh: "remove-refresh-secret",
            expires: Date.now() + 60_000,
          },
        },
      });
      await deletePiAccount({ stateDir, secretsDir, instanceId: id });
      expect(await discoverPiAccounts({ stateDir, secretsDir })).toEqual([]);
      expect(
        await makePiCatalogCredentialStore({ stateDir, secretsDir, accountId: id }),
      ).toBeUndefined();
    }));
  it("hydrates every ready ccc account and routes the legacy pi instance to an active default", () =>
    withFixture(async ({ stateDir, secretsDir }) => {
      const records = [
        account({
          id: "ccc_anthropic_aaaaaaaaaaaaaaaaaaaaaaaa",
          label: "Anthropic Personal",
          provider: "anthropic",
          secretRef: "anthropic-personal",
        }),
        account({
          id: "ccc_anthropic_bbbbbbbbbbbbbbbbbbbbbbbb",
          label: "Anthropic Active",
          provider: "anthropic",
          secretRef: "anthropic-active",
          sourceActive: true,
        }),
        account({
          id: "ccc_openai_cccccccccccccccccccccccc",
          label: "OpenAI Personal",
          provider: "openai",
          secretRef: "openai-personal",
        }),
        account({
          id: "ccc_openai_dddddddddddddddddddddddd",
          label: "OpenAI Active",
          provider: "openai",
          secretRef: "openai-active",
          sourceActive: true,
        }),
      ];
      writeOwnerJson(NodePath.join(stateDir, "pi-accounts.json"), {
        version: 1,
        accounts: records,
      });
      for (const record of records) {
        writeOwnerJson(
          NodePath.join(secretsDir, "pi-accounts", `${record.secretRef}.json`),
          oauthSecret(record.provider === "anthropic" ? "anthropic" : "openai-codex", record.id),
        );
      }

      const discovered = await discoverPiAccounts({ stateDir, secretsDir });
      expect(discovered).toHaveLength(4);
      expect(discovered.every((entry) => entry.hasUsableCredential)).toBe(true);
      expect(selectDefaultPiAccount(discovered)?.id).toBe("ccc_openai_dddddddddddddddddddddddd");

      const config = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS, discovered);
      expect(Object.keys(config)).toEqual([
        "ccc_anthropic_aaaaaaaaaaaaaaaaaaaaaaaa",
        "ccc_anthropic_bbbbbbbbbbbbbbbbbbbbbbbb",
        "ccc_openai_cccccccccccccccccccccccc",
        "ccc_openai_dddddddddddddddddddddddd",
        "pi",
      ]);
      expect(config[ProviderInstanceId.make("pi")]?.config).toMatchObject({
        catalogAccountId: "ccc_openai_dddddddddddddddddddddddd",
      });
      expect(
        config[ProviderInstanceId.make("ccc_anthropic_bbbbbbbbbbbbbbbbbbbbbbbb")]?.displayName,
      ).toBe("Anthropic Active");
      expect(JSON.stringify({ discovered, config })).not.toContain("access-secret");
      expect(JSON.stringify({ discovered, config })).not.toContain("refresh-secret");
    }));

  it("retains the hidden credential route when visible provider settings are saved", () =>
    withFixture(async ({ stateDir, secretsDir }) => {
      const id = "ccc_openai_aaaaaaaaaaaaaaaaaaaaaaaa";
      writeOwnerJson(NodePath.join(stateDir, "pi-accounts.json"), {
        version: 1,
        accounts: [
          account({
            id,
            label: "OpenAI",
            provider: "openai",
            secretRef: "openai",
            sourceActive: true,
          }),
        ],
      });
      writeOwnerJson(
        NodePath.join(secretsDir, "pi-accounts", "openai.json"),
        oauthSecret("openai-codex", "openai"),
      );

      const discovered = await discoverPiAccounts({ stateDir, secretsDir });
      const config = deriveProviderInstanceConfigMap(
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make(id)]: {
              driver: ProviderDriverKind.make("pi"),
              displayName: "Renamed OpenAI",
              enabled: false,
              config: { agentDir: "", catalogAccountId: "" },
            },
          },
        },
        discovered,
      );

      expect(config[ProviderInstanceId.make(id)]).toMatchObject({
        displayName: "Renamed OpenAI",
        enabled: false,
        config: {
          agentDir: NodePath.join(stateDir, "pi", id),
          catalogAccountId: id,
        },
      });
    }));

  it("isolates missing and malformed accounts while retaining the usable roster", () =>
    withFixture(async ({ stateDir, secretsDir }) => {
      const validId = "ccc_anthropic_aaaaaaaaaaaaaaaaaaaaaaaa";
      const malformedId = "ccc_openai_bbbbbbbbbbbbbbbbbbbbbbbb";
      const missingId = "ccc_openai_cccccccccccccccccccccccc";
      writeOwnerJson(NodePath.join(stateDir, "pi-accounts.json"), {
        version: 1,
        accounts: [
          account({
            id: validId,
            label: "Usable",
            provider: "anthropic",
            secretRef: "valid",
            sourceActive: true,
          }),
          account({
            id: malformedId,
            label: "Malformed",
            provider: "openai",
            secretRef: "malformed",
          }),
          account({
            id: missingId,
            label: "Missing",
            provider: "openai",
            secretRef: "missing",
          }),
          { id: "not a provider slug", label: "Ignored", provider: "anthropic" },
        ],
      });
      writeOwnerJson(
        NodePath.join(secretsDir, "pi-accounts", "valid.json"),
        oauthSecret("anthropic", "valid"),
      );
      writeOwnerJson(NodePath.join(secretsDir, "pi-accounts", "malformed.json"), {
        kind: "oauth",
        providerId: "openai-codex",
        access: "must-not-appear",
      });

      const discovered = await discoverPiAccounts({ stateDir, secretsDir });
      expect(discovered.map((entry) => [entry.id, entry.hasUsableCredential])).toEqual([
        [validId, true],
        [malformedId, false],
        [missingId, false],
      ]);
      expect(selectDefaultPiAccount(discovered)?.id).toBe(validId);
      expect(
        await makePiCatalogCredentialStore({ stateDir, secretsDir, accountId: malformedId }),
      ).toBeUndefined();
      expect(JSON.stringify(discovered)).not.toContain("must-not-appear");
    }));

  it("keeps heterogeneous account model inventories separate and launches the default alias", () =>
    withFixture(async ({ stateDir, secretsDir }) => {
      const anthropicId = "ccc_anthropic_aaaaaaaaaaaaaaaaaaaaaaaa";
      const openaiId = "ccc_openai_bbbbbbbbbbbbbbbbbbbbbbbb";
      writeOwnerJson(NodePath.join(stateDir, "pi-accounts.json"), {
        version: 1,
        accounts: [
          account({
            id: anthropicId,
            label: "Anthropic",
            provider: "anthropic",
            secretRef: "anthropic",
          }),
          account({
            id: openaiId,
            label: "OpenAI",
            provider: "openai",
            secretRef: "openai",
            sourceActive: true,
          }),
        ],
      });
      writeOwnerJson(
        NodePath.join(secretsDir, "pi-accounts", "anthropic.json"),
        oauthSecret("anthropic", "anthropic"),
      );
      writeOwnerJson(
        NodePath.join(secretsDir, "pi-accounts", "openai.json"),
        oauthSecret("openai-codex", "openai"),
      );
      const discovered = await discoverPiAccounts({ stateDir, secretsDir });
      const configMap = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS, discovered);

      const anthropic = await makePiModelRuntime({
        stateDir,
        secretsDir,
        instanceId: anthropicId,
        config: decodePiSettings(configMap[ProviderInstanceId.make(anthropicId)]?.config),
        environment: {},
      });
      const openai = await makePiModelRuntime({
        stateDir,
        secretsDir,
        instanceId: openaiId,
        config: decodePiSettings(configMap[ProviderInstanceId.make(openaiId)]?.config),
        environment: {},
      });
      const defaultAlias = await makePiModelRuntime({
        stateDir,
        secretsDir,
        instanceId: "pi",
        config: decodePiSettings(configMap[ProviderInstanceId.make("pi")]?.config),
        environment: {},
      });

      expect(anthropic.modelRegistry.getAvailable().map(piModelSlug)).toContain(
        "anthropic/claude-opus-5",
      );
      expect(anthropic.modelRegistry.getAvailable().map(piModelSlug)).not.toContain(
        "openai-codex/gpt-5.6-sol",
      );
      expect(openai.modelRegistry.getAvailable().map(piModelSlug)).toContain(
        "openai-codex/gpt-5.6-sol",
      );
      expect(defaultAlias.modelRegistry.getAvailable().map(piModelSlug)).toContain(
        "openai-codex/gpt-5.6-sol",
      );
      expect(NodeFS.existsSync(NodePath.join(stateDir, "pi", "pi", "auth.json"))).toBe(false);
    }));

  it("maps OpenAI API-key catalog credentials to Pi's openai provider", () =>
    withFixture(async ({ stateDir, secretsDir }) => {
      const id = "ccc_openai_aaaaaaaaaaaaaaaaaaaaaaaa";
      writeOwnerJson(NodePath.join(stateDir, "pi-accounts.json"), {
        version: 1,
        accounts: [account({ id, label: "OpenAI API", provider: "openai", secretRef: "api" })],
      });
      writeOwnerJson(NodePath.join(secretsDir, "pi-accounts", "api.json"), {
        kind: "apiKey",
        value: "openai-api-key-secret",
      });

      const store = await makePiCatalogCredentialStore({ stateDir, secretsDir, accountId: id });
      expect(await store?.list()).toEqual([{ providerId: "openai", type: "api_key" }]);
      expect(await store?.read("openai")).toMatchObject({ type: "api_key" });
      expect(await store?.read("openai-codex")).toBeUndefined();

      const discovered = await discoverPiAccounts({ stateDir, secretsDir });
      const configMap = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS, discovered);
      const runtime = await makePiModelRuntime({
        stateDir,
        secretsDir,
        instanceId: id,
        config: decodePiSettings(configMap[ProviderInstanceId.make(id)]?.config),
        environment: {},
      });
      expect(
        runtime.modelRegistry.getAvailable().some((entry) => entry.provider === "openai"),
      ).toBe(true);
      expect(
        runtime.modelRegistry.getAvailable().some((entry) => entry.provider === "openai-codex"),
      ).toBe(false);
    }));

  it("routes a directory-only default alias through the selected account auth file", () =>
    withFixture(async ({ stateDir, secretsDir }) => {
      const id = "ccc_openai_aaaaaaaaaaaaaaaaaaaaaaaa";
      writeOwnerJson(NodePath.join(stateDir, "pi", id, "auth.json"), {
        "openai-codex": {
          type: "oauth",
          access: "directory-access",
          refresh: "directory-refresh",
          expires: Date.now() + 60 * 60 * 1000,
          accountId: "directory-account",
        },
      });

      const discovered = await discoverPiAccounts({ stateDir, secretsDir });
      expect(discovered).toMatchObject([{ id, hasUsableCredential: true, status: "ready" }]);
      const configMap = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS, discovered);
      expect(configMap[ProviderInstanceId.make("pi")]?.config).toMatchObject({
        agentDir: NodePath.join(stateDir, "pi", id),
        catalogAccountId: id,
      });
      const alias = await makePiModelRuntime({
        stateDir,
        secretsDir,
        instanceId: "pi",
        config: decodePiSettings(configMap[ProviderInstanceId.make("pi")]?.config),
        environment: {},
      });
      expect(alias.modelRegistry.getAvailable().map(piModelSlug)).toContain(
        "openai-codex/gpt-5.6-sol",
      );
    }));

  it("retains catalog identity when a discovered account has an explicit session directory", () =>
    withFixture(async ({ stateDir, secretsDir }) => {
      const id = "ccc_anthropic_aaaaaaaaaaaaaaaaaaaaaaaa";
      writeOwnerJson(NodePath.join(stateDir, "pi-accounts.json"), {
        version: 1,
        accounts: [account({ id, label: "Anthropic", provider: "anthropic", secretRef: "a" })],
      });
      writeOwnerJson(
        NodePath.join(secretsDir, "pi-accounts", "a.json"),
        oauthSecret("anthropic", "a"),
      );
      const [discovered] = await discoverPiAccounts({ stateDir, secretsDir });
      const customAgentDir = NodePath.join(stateDir, "custom-sessions");
      const configMap = deriveProviderInstanceConfigMap(
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make(id)]: {
              driver: ProviderDriverKind.make("pi"),
              config: { agentDir: customAgentDir },
            },
          },
        },
        discovered ? [discovered] : [],
      );
      expect(configMap[ProviderInstanceId.make(id)]).toMatchObject({
        displayName: "Anthropic",
        config: { agentDir: customAgentDir, catalogAccountId: id },
      });
    }));

  it("persists OAuth refreshes in place and reloads them after restart", () =>
    withFixture(async ({ stateDir, secretsDir }) => {
      const id = "ccc_openai_aaaaaaaaaaaaaaaaaaaaaaaa";
      writeOwnerJson(NodePath.join(stateDir, "pi-accounts.json"), {
        version: 1,
        accounts: [
          account({ id, label: "OpenAI", provider: "openai", secretRef: "oauth-restart" }),
        ],
      });
      writeOwnerJson(
        NodePath.join(secretsDir, "pi-accounts", "oauth-restart.json"),
        oauthSecret("openai-codex", "before"),
      );

      const first = await makePiCatalogCredentialStore({ stateDir, secretsDir, accountId: id });
      await first!.modify("openai-codex", async (current) => ({
        ...current!,
        type: "oauth",
        access: "after-access-secret",
        refresh: "after-refresh-secret",
        expires: Date.now() + 2 * 60 * 60 * 1000,
      }));

      const restarted = await makePiCatalogCredentialStore({
        stateDir,
        secretsDir,
        accountId: id,
      });
      expect(await restarted!.read("openai-codex")).toMatchObject({
        type: "oauth",
        access: "after-access-secret",
        refresh: "after-refresh-secret",
      });
      expect(NodeFS.existsSync(NodePath.join(stateDir, "pi", id, "auth.json"))).toBe(false);
    }));
});
