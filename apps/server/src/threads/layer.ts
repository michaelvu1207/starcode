/**
 * Local thread composition root.
 *
 * Same reason `peers/layer.ts` exists: `server.ts` is one of the repo's hottest
 * files, so it carries one `Layer.provide` for this area and a later service
 * added here costs no diff there.
 *
 * @module ThreadsLayer
 */
import * as Layer from "effect/Layer";

import * as LocalThreadWriter from "./LocalThreadWriter.ts";

export const ThreadServicesLive = Layer.mergeAll(LocalThreadWriter.layer);
