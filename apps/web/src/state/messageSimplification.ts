import { createMessageSimplificationEnvironmentAtoms } from "@starcode/client-runtime/state/message-simplification";

import { connectionAtomRuntime } from "../connection/runtime";

export const messageSimplificationEnvironment =
  createMessageSimplificationEnvironmentAtoms(connectionAtomRuntime);
