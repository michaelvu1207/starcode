// @effect-diagnostics globalDateInEffect:off - Pi message timestamps are epoch milliseconds.
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { TextGenerationError, type PiSettings } from "@starcode/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@starcode/shared/git";
import { extractJsonObject } from "@starcode/shared/schemaJson";
import * as Effect from "effect/Effect";

import { resolvePiModel } from "../provider/pi/PiModels.ts";
import {
  assertPiContextSupported,
  canonicalizePiProviderOptions,
  piContextTokens,
  readPiContext,
  readPiEffort,
} from "../provider/pi/PiProviderOptions.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildMessageSummaryPrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizeMessageSummary,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import type * as TextGeneration from "./TextGeneration.ts";

function assistantText(message: Awaited<ReturnType<ModelRuntime["completeSimple"]>>): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

function decodeRecord(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(extractJsonObject(raw));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pi returned a non-object JSON value.");
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Pi response is missing '${key}'.`);
  return value;
}

export function makePiTextGeneration(input: {
  readonly modelRegistry: ModelRegistry;
  readonly modelRuntime: ModelRuntime;
  readonly config: PiSettings;
}): TextGeneration.TextGeneration["Service"] {
  const runJson = (
    operation: string,
    prompt: string,
    modelSlug: string | undefined,
    providerOptions: Parameters<
      TextGeneration.TextGeneration["Service"]["generateThreadTitle"]
    >[0]["modelSelection"]["options"],
  ) =>
    Effect.tryPromise({
      try: async () => {
        const baseModel = resolvePiModel(
          input.modelRegistry,
          modelSlug,
          input.config.enabledModels,
        );
        if (!baseModel) throw new Error("No authenticated Pi model is available.");
        const canonicalOptions = canonicalizePiProviderOptions(providerOptions);
        const context = readPiContext(canonicalOptions);
        if (context !== undefined) assertPiContextSupported(baseModel, context);
        const model =
          context === undefined
            ? baseModel
            : ({ ...baseModel, contextWindow: piContextTokens(context) } as typeof baseModel);
        const effort = readPiEffort(canonicalOptions);
        const streamOptions =
          effort && effort !== "off"
            ? { reasoning: effort as "minimal" | "low" | "medium" | "high" | "xhigh" }
            : undefined;
        const response = await input.modelRuntime.completeSimple(
          model,
          { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
          streamOptions,
        );
        if (response.stopReason === "error") {
          throw new Error(response.errorMessage ?? "Pi text generation failed.");
        }
        return decodeRecord(assistantText(response));
      },
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

  const modelInfo = (
    selection: Parameters<
      TextGeneration.TextGeneration["Service"]["generateThreadTitle"]
    >[0]["modelSelection"],
  ) => ({
    model: selection.model,
    options: selection.options,
  });

  return {
    generateCommitMessage: (request) => {
      const built = buildCommitMessagePrompt({
        branch: request.branch,
        stagedSummary: request.stagedSummary,
        stagedPatch: request.stagedPatch,
        includeBranch: request.includeBranch === true,
      });
      const selected = modelInfo(request.modelSelection);
      return runJson("generateCommitMessage", built.prompt, selected.model, selected.options).pipe(
        Effect.map((value) => ({
          subject: sanitizeCommitSubject(requireString(value, "subject")),
          body: requireString(value, "body").trim(),
          ...(request.includeBranch
            ? { branch: sanitizeFeatureBranchName(requireString(value, "branch")) }
            : {}),
        })),
      );
    },
    generatePrContent: (request) => {
      const built = buildPrContentPrompt(request);
      const selected = modelInfo(request.modelSelection);
      return runJson("generatePrContent", built.prompt, selected.model, selected.options).pipe(
        Effect.map((value) => ({
          title: sanitizePrTitle(requireString(value, "title")),
          body: requireString(value, "body").trim(),
        })),
      );
    },
    generateBranchName: (request) => {
      const built = buildBranchNamePrompt(request);
      const selected = modelInfo(request.modelSelection);
      return runJson("generateBranchName", built.prompt, selected.model, selected.options).pipe(
        Effect.map((value) => ({ branch: sanitizeBranchFragment(requireString(value, "branch")) })),
      );
    },
    generateThreadTitle: (request) => {
      const built = buildThreadTitlePrompt(request);
      const selected = modelInfo(request.modelSelection);
      return runJson("generateThreadTitle", built.prompt, selected.model, selected.options).pipe(
        Effect.map((value) => ({ title: sanitizeThreadTitle(requireString(value, "title")) })),
      );
    },
    generateMessageSummary: (request) => {
      const built = buildMessageSummaryPrompt(request);
      const selected = modelInfo(request.modelSelection);
      return runJson("generateMessageSummary", built.prompt, selected.model, selected.options).pipe(
        Effect.flatMap((value) => {
          const summary = sanitizeMessageSummary(requireString(value, "summary"));
          return summary.length > 0
            ? Effect.succeed({ summary })
            : Effect.fail(
                new TextGenerationError({
                  operation: "generateMessageSummary",
                  detail: "Pi returned an empty message summary.",
                }),
              );
        }),
      );
    },
  };
}
