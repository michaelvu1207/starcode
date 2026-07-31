/**
 * Facts Starcode can prove about a `codex exec` invocation embedded in a
 * Claude Bash tool call.
 *
 * The Bash tool-use id is the UI correlation boundary. It is explicit,
 * survives concurrent commands, and is also the id used by the existing
 * per-subagent transcript partition. A rollout is attached separately only
 * when its own metadata, effective cwd, launch time, and prompt identify one
 * unique candidate.
 */
export interface CodexCliSubagentInvocation {
  readonly description: string;
  /** Exact prompt token when it was present on the command line. Never shown verbatim by default. */
  readonly prompt?: string;
  readonly model?: string;
  /** A simple `cd <path>` shell segment that precedes this invocation. */
  readonly shellCwd?: string;
  /** `-C` / `--cd`, still relative to the parent task's cwd when the CLI received it that way. */
  readonly cwd?: string;
  /** `codex exec resume --last`, linkable only to a rollout already proved in this parent session. */
  readonly resumeLast?: boolean;
  /**
   * A backgrounded shell command can outlive the Bash tool that launched it.
   * Once that wrapper exits Starcode has no authoritative PID/session handle,
   * so its terminal event means "observation ended", not "Codex completed".
   */
  readonly detached: boolean;
}

const OPTIONS_WITH_VALUE = new Set([
  "-C",
  "--cd",
  "-c",
  "--config",
  "-i",
  "--image",
  "-m",
  "--model",
  "-o",
  "--output-last-message",
  "--output-schema",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "--color",
  "--add-dir",
  "--enable",
  "--disable",
]);

interface ParsedShellWord {
  readonly value: string;
  readonly start: number;
  readonly end: number;
  /**
   * False when the shell must expand this word before execution. Such a word
   * can still prove that `codex exec` was launched, but it cannot participate
   * in cwd or prompt correlation.
   */
  readonly literal: boolean;
}

const removeLineContinuations = (command: string): string => command.replace(/\\\r?\n/g, "");

/**
 * Tokenize one shell pipeline member, stopping at the first unquoted control
 * operator. This is intentionally not a shell parser: it only needs enough
 * structure to prove that the executable itself is `codex exec`, without
 * mistaking `echo "codex exec"` or a prompt mentioning Codex for a launch.
 */
function shellWords(command: string, offset: number): ReadonlyArray<ParsedShellWord> {
  const words: ParsedShellWord[] = [];
  let cursor = offset;

  while (cursor < command.length) {
    while (cursor < command.length && /\s/.test(command[cursor] ?? "")) cursor += 1;
    if (cursor >= command.length || /[|;&<>\n()]/.test(command[cursor] ?? "")) break;

    const start = cursor;
    let value = "";
    let quote: "'" | '"' | null = null;
    let literal = true;

    while (cursor < command.length) {
      const char = command[cursor] ?? "";
      if (quote === null && (/\s/.test(char) || /[|;&<>\n()]/.test(char))) break;

      if (char === "\\" && quote !== "'") {
        const next = command[cursor + 1];
        if (next !== undefined) {
          if (quote === '"' && !/[$`"\\]/.test(next)) value += "\\";
          value += next;
          cursor += 2;
          continue;
        }
      }
      if (char === "'" || char === '"') {
        if (quote === char) {
          quote = null;
          cursor += 1;
          continue;
        }
        if (quote === null) {
          quote = char;
          cursor += 1;
          continue;
        }
      }
      if (
        quote !== "'" &&
        (char === "$" ||
          char === "`" ||
          (quote === null && (char === "*" || char === "?" || char === "[")) ||
          (quote === null && value.length === 0 && char === "~"))
      ) {
        literal = false;
      }
      value += char;
      cursor += 1;
    }

    const stoppedAtRedirection = /[<>]/.test(command[cursor] ?? "");
    if (value.length > 0 && !(stoppedAtRedirection && /^\d+$/.test(value))) {
      words.push({ value, start, end: cursor, literal: literal && quote === null });
    }
    if (stoppedAtRedirection) break;
  }

  return words;
}

function basename(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash === -1 ? value : value.slice(slash + 1);
}

function controlOperatorOffsets(command: string): ReadonlyArray<number> {
  const offsets = [0];
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else if (quote === null) quote = char;
      continue;
    }
    if (quote === null && /[|;&\n(]/.test(char)) offsets.push(index + 1);
  }

  return offsets;
}

function findCodexExecWords(
  command: string,
): { readonly words: ReadonlyArray<ParsedShellWord>; readonly offset: number } | null {
  const matches: Array<{
    readonly words: ReadonlyArray<ParsedShellWord>;
    readonly offset: number;
  }> = [];
  for (const offset of controlOperatorOffsets(command)) {
    const words = shellWords(command, offset);
    if (words.length < 2) continue;

    let index = 0;
    if (words[index]?.value === "nohup" || words[index]?.value === "command") index += 1;
    if (words[index]?.value === "env") {
      index += 1;
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]?.value ?? "")) index += 1;
    }
    if (words[index]?.value === "nohup" || words[index]?.value === "command") index += 1;

    if (basename(words[index]?.value ?? "") !== "codex") continue;
    if (words[index + 1]?.value !== "exec") continue;
    matches.push({ words: words.slice(index), offset });
  }
  // One Bash tool-use id is one lifecycle correlation key. A wrapper that
  // starts multiple Codex processes cannot be assigned without inventing
  // identities, so leave the whole launch unavailable.
  return matches.length === 1 ? matches[0]! : null;
}

function precedingShellCwd(
  command: string,
  invocationOffset: number,
): { readonly cwd?: string; readonly unresolved: boolean } {
  let cwd: string | undefined;
  let unresolved = false;
  for (const offset of controlOperatorOffsets(command)) {
    if (offset >= invocationOffset) break;
    const words = shellWords(command, offset);
    if (words[0]?.value !== "cd") continue;
    const candidate = words[1]?.value === "--" ? words[2] : words[1];
    if (!candidate) continue;
    if (!candidate.literal) {
      cwd = undefined;
      unresolved = true;
      continue;
    }
    cwd = candidate.value;
    unresolved = false;
  }
  return { ...(cwd ? { cwd } : {}), unresolved };
}

function promptAndModel(words: ReadonlyArray<ParsedShellWord>): {
  readonly prompt?: string;
  readonly descriptionPrompt?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly resumeLast?: boolean;
  readonly unresolvedCwd: boolean;
} {
  let model: string | undefined;
  let cwd: string | undefined;
  let unresolvedCwd = false;
  const positionals: ParsedShellWord[] = [];
  let resumeLast = false;
  let afterOptions = false;

  for (let index = 2; index < words.length; index += 1) {
    const word = words[index];
    const value = word?.value ?? "";
    if (!afterOptions && value === "--") {
      afterOptions = true;
      continue;
    }
    const equals = value.indexOf("=");
    const optionName = equals === -1 ? value : value.slice(0, equals);
    if (!afterOptions && optionName === "--last") resumeLast = true;
    if (!afterOptions && (optionName === "-m" || optionName === "--model")) {
      const candidate =
        equals === -1
          ? words[index + 1]
          : { value: value.slice(equals + 1), literal: word?.literal ?? false };
      if (candidate?.literal && candidate.value.trim()) model = candidate.value.trim();
    }
    if (!afterOptions && (optionName === "-C" || optionName === "--cd")) {
      const candidate =
        equals === -1
          ? words[index + 1]
          : { value: value.slice(equals + 1), literal: word?.literal ?? false };
      if (candidate?.literal && candidate.value.trim()) cwd = candidate.value.trim();
      else unresolvedCwd = true;
    }
    if (!afterOptions && value.startsWith("-")) {
      if (equals === -1 && OPTIONS_WITH_VALUE.has(optionName)) index += 1;
      continue;
    }
    if (word) positionals.push(word);
  }

  // `codex exec resume <id> [prompt]`: neither the verb nor session id is a
  // useful row label. For ordinary exec, the last positional is the prompt.
  const isResume = positionals[0]?.value === "resume";
  const promptWord = isResume
    ? resumeLast
      ? positionals[1]
      : positionals.length > 2
        ? positionals.at(-1)
        : undefined
    : positionals.at(-1);
  const descriptionPrompt =
    promptWord?.literal && promptWord.value !== "-" ? promptWord.value : undefined;
  const prompt = descriptionPrompt;
  return {
    ...(prompt ? { prompt } : {}),
    ...(descriptionPrompt ? { descriptionPrompt } : {}),
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
    ...(isResume && resumeLast ? { resumeLast: true } : {}),
    unresolvedCwd,
  };
}

function conciseDescription(prompt: string | undefined): string {
  if (!prompt) return "Codex CLI subagent";
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length === 0 || normalized === "-") return "Codex CLI subagent";
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function hasDetachedOperator(command: string, invocationStart: number): boolean {
  let quote: "'" | '"' | null = null;
  for (let index = invocationStart; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else if (quote === null) quote = char;
      continue;
    }
    if (quote === null && (char === "\n" || char === ";")) return false;
    if (quote === null && char === "|" && command[index + 1] === "|") return false;
    if (quote !== null || char !== "&") continue;
    const previous = command[index - 1];
    const next = command[index + 1];
    // Exclude `&&` and redirection such as `2>&1`; a remaining ampersand is a
    // background-list operator.
    if (previous !== "&" && next !== "&" && previous !== ">") return true;
  }
  return false;
}

export function detectCodexCliSubagent(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): CodexCliSubagentInvocation | null {
  if (!/bash|shell|command|terminal/i.test(toolName)) return null;
  const commandValue = input.command ?? input.cmd;
  if (typeof commandValue !== "string" || commandValue.trim().length === 0) return null;

  const command = removeLineContinuations(commandValue);
  const match = findCodexExecWords(command);
  if (!match) return null;
  if (
    match.words
      .slice(2)
      .some(({ value }) => value === "-h" || value === "--help" || value === "--version")
  ) {
    return null;
  }
  const facts = promptAndModel(match.words);
  const shellCwd = precedingShellCwd(command, match.offset);
  const promptIsLinkable = !shellCwd.unresolved && !facts.unresolvedCwd;
  return {
    description: facts.resumeLast
      ? "Resume Codex CLI subagent"
      : conciseDescription(facts.descriptionPrompt),
    ...(facts.prompt && promptIsLinkable ? { prompt: facts.prompt } : {}),
    ...(facts.model ? { model: facts.model } : {}),
    ...(shellCwd.cwd ? { shellCwd: shellCwd.cwd } : {}),
    ...(facts.cwd ? { cwd: facts.cwd } : {}),
    ...(facts.resumeLast ? { resumeLast: true } : {}),
    detached: hasDetachedOperator(command, match.words[0]?.start ?? 0),
  };
}
