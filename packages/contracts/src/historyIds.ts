import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Opaque handle for one provider-native history file.
 *
 * Kept outside `history.ts` so orchestration read models can reference the id
 * without creating a runtime schema cycle (`history.ts` also consumes
 * orchestration runtime-mode schemas).
 */
export const HistorySessionId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[0-9a-f]{32}$/),
).pipe(Schema.brand("HistorySessionId"));
export type HistorySessionId = typeof HistorySessionId.Type;
