import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";

const FAUX_API = "starcode-fleet-faux";
const FAUX_MODEL = "fleet-gate";
const FAUX_PROVIDER = "starcode-faux";
const RESPONSE_CAPACITY = 512;

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const baseDir = argumentValue("--base-dir");
const captureSocket = process.env.STARCODE_FLEET_MCP_CAPTURE_SOCKET;
const bootstrapCapturePath =
  baseDir === undefined ? undefined : NodePath.join(baseDir, "fleet-bootstrap.txt");
const holdFirstTurnMarker =
  baseDir === undefined ? undefined : NodePath.join(baseDir, "hold-first-provider-turn");
const shouldHoldFirstTurn =
  baseDir !== undefined &&
  NodePath.basename(baseDir) === "alpha" &&
  holdFirstTurnMarker !== undefined &&
  !NodeFS.existsSync(holdFirstTurnMarker);

if (shouldHoldFirstTurn) {
  NodeFS.closeSync(NodeFS.openSync(holdFirstTurnMarker, "wx", 0o600));
}

let capturedBootstrap = false;
const captureBootstrap = (systemPrompt) => {
  if (
    capturedBootstrap ||
    bootstrapCapturePath === undefined ||
    typeof systemPrompt !== "string" ||
    systemPrompt.length === 0
  ) {
    return;
  }
  capturedBootstrap = true;
  NodeFS.writeFileSync(bootstrapCapturePath, systemPrompt, { encoding: "utf8", mode: 0o600 });
};

let capturedMcpCredential = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (!capturedMcpCredential && captureSocket) {
    const endpoint =
      input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    const overrides = new Headers(init?.headers);
    overrides.forEach((value, name) => headers.set(name, value));
    const authorization = headers.get("authorization");
    if (endpoint.endsWith("/mcp") && authorization?.startsWith("Bearer ")) {
      capturedMcpCredential = true;
      const capture = NodeNet.createConnection(captureSocket);
      capture.once("connect", () => {
        capture.end(
          `${JSON.stringify({ endpoint, token: authorization.slice("Bearer ".length) })}\n`,
        );
      });
      // A failed test-only capture must not kill the Pi session or print the
      // credential through an uncaught socket error.
      capture.once("error", () => undefined);
    }
  }
  return originalFetch(input, init);
};

const faux = registerFauxProvider({
  api: FAUX_API,
  provider: FAUX_PROVIDER,
  tokensPerSecond: 0,
  models: [
    {
      id: FAUX_MODEL,
      name: "Starcode Fleet Gate",
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 16_384,
    },
  ],
});

const deterministicResponse = (context, _options, state) => {
  captureBootstrap(context.systemPrompt);
  if (shouldHoldFirstTurn && state.callCount === 1) {
    // Alpha's first turn remains active until its server is stopped. The marker
    // survives in the node home, so the restarted process completes Pi's
    // persisted turn and exercises native recovery rather than a fake protocol.
    return new Promise(() => undefined);
  }
  return fauxAssistantMessage("Native Pi fleet gate response.");
};

faux.setResponses(Array.from({ length: RESPONSE_CAPACITY }, () => deterministicResponse));
