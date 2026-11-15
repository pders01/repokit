import type {
  AnnotationAuthor,
  AnnotationCategory,
  AnnotationCreate,
  AnnotationState,
  AnnotationUpdate,
  AnnotationWhitespace,
} from "./contracts.js";
import type { AnnotationService as ServerAnnotationService } from "./service.js";

const MAX_STDIN_BYTES = 1 * 1024 * 1024;
// Accept every bounded 16 MiB service export, plus framing/formatting whitespace.
const MAX_IMPORT_BYTES = 17 * 1024 * 1024;
const COMMANDS = ["list", "create", "update", "delete", "export", "import"] as const;
type AnnotationCommand = (typeof COMMANDS)[number];

type AnnotationService = Pick<ServerAnnotationService, "list" | "create" | "update" | "delete" | "export" | "import">;
type AnnotationServiceConstructor = new (configuredBase?: string) => AnnotationService;

export interface AnnotationCliOptions {
  cwd: string;
  dataDir?: string;
  command?: AnnotationCommand;
  help: boolean;
  ref?: string;
  path?: string;
  includeResolved?: boolean;
  id?: string;
  expectedRevision?: number;
  authorKind?: AnnotationAuthor["kind"];
  authorName?: string;
  sessionId?: string;
  model?: string;
}

export function parseAnnotationArgs(args: string[], defaultCwd = process.cwd()): AnnotationCliOptions {
  let cwd = defaultCwd;
  let dataDir: string | undefined;
  let command: AnnotationCommand | undefined;
  let help = false;
  const options: Omit<AnnotationCliOptions, "cwd" | "dataDir" | "command" | "help"> = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) throw new Error("Missing argument");
    if (argument === "--") throw new Error("Unexpected --; arguments are not shell commands");
    if (!argument.startsWith("-")) {
      if (command) throw new Error(`Unexpected argument: ${argument}`);
      if (!COMMANDS.includes(argument as AnnotationCommand)) {
        throw new Error(`Unknown command: ${argument}`);
      }
      command = argument as AnnotationCommand;
      continue;
    }

    const [name, inlineValue] = splitOption(argument);
    if (name === "-h" || name === "--help") {
      if (inlineValue !== undefined) throw new Error(`${name} does not accept a value`);
      help = true;
      continue;
    }
    const takesValue = new Set([
      "--cwd", "--data-dir", "--ref", "--path", "--id", "--expected-revision", "--expectedRevision",
      "--author-kind", "--author-name", "--session-id", "--model",
    ]).has(name);
    const value = takesValue ? optionValue(args, index, inlineValue, name) : undefined;
    if (takesValue && inlineValue === undefined) index += 1;

    switch (name) {
      case "--cwd":
        cwd = value!;
        break;
      case "--data-dir":
        dataDir = value!;
        break;
      case "--ref":
        requireCommand(command, "--ref");
        requireCommandIs(command, "list", "--ref");
        options.ref = value!;
        break;
      case "--path":
        requireCommand(command, "--path");
        requireCommandIs(command, "list", "--path");
        options.path = value!;
        break;
      case "--include-resolved":
      case "--includeResolved":
        if (inlineValue !== undefined) throw new Error(`${name} does not accept a value`);
        requireCommand(command, name);
        requireCommandIs(command, "list", name);
        options.includeResolved = true;
        break;
      case "--id":
        requireCommand(command, "--id");
        requireCommandIsOneOf(command, ["update", "delete"], "--id");
        options.id = value!;
        break;
      case "--expected-revision":
      case "--expectedRevision":
        requireCommand(command, name);
        requireCommandIsOneOf(command, ["update", "delete"], name);
        options.expectedRevision = parseRevision(value!);
        break;
      case "--author-kind":
        requireCommand(command, "--author-kind");
        requireCommandIs(command, "create", "--author-kind");
        if (value !== "human" && value !== "agent") throw new Error("--author-kind must be human or agent");
        options.authorKind = value;
        break;
      case "--author-name":
        requireCommand(command, "--author-name");
        requireCommandIs(command, "create", "--author-name");
        options.authorName = value!;
        break;
      case "--session-id":
        requireCommand(command, "--session-id");
        requireCommandIs(command, "create", "--session-id");
        options.sessionId = value!;
        break;
      case "--model":
        requireCommand(command, "--model");
        requireCommandIs(command, "create", "--model");
        options.model = value!;
        break;
      default:
        throw new Error(`Unknown option: ${name}`);
    }
  }

  return { cwd, ...(dataDir === undefined ? {} : { dataDir }), ...(command ? { command } : {}), help, ...options };
}

export async function main(args = process.argv.slice(2), usage = "source-annotations"): Promise<void> {
  const options = parseAnnotationArgs(args);
  if (options.help) {
    printHelp(usage);
    return;
  }
  if (!options.command) throw new Error("A command is required (use --help for usage)");

  const service = await loadAnnotationService(options.dataDir);
  const cwd = options.cwd;
  switch (options.command) {
    case "list": {
      const result = await service.list(cwd, {
        ref: options.ref ?? "HEAD",
        ...(options.path === undefined ? {} : { path: options.path }),
        ...(options.includeResolved ? { includeResolved: true } : {}),
      });
      writeJson(result);
      return;
    }
    case "create": {
      const input = await readJsonInput();
      const { author: suppliedAuthor, ...annotationInput } = objectInput(input, "create");
      const author = annotationAuthor(suppliedAuthor, options);
      const result = await service.create(cwd, annotationInput as unknown as AnnotationCreate, author);
      writeJson(result);
      return;
    }
    case "update": {
      const input = objectInput(await readJsonInput(), "update");
      const update = {
        ...input,
        ...(options.id === undefined ? {} : { id: options.id }),
        ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
      } as Partial<AnnotationUpdate>;
      if (typeof update.id !== "string" || !update.id) throw new Error("update requires id");
      if (!Number.isSafeInteger(update.expectedRevision)) throw new Error("update requires expectedRevision");
      writeJson(await service.update(cwd, update as AnnotationUpdate));
      return;
    }
    case "delete": {
      const input = objectInput(await readJsonInput(), "delete");
      if (Object.keys(input).some((key) => key !== "id" && key !== "expectedRevision")) {
        throw new Error("Unknown annotation delete field");
      }
      const id = options.id ?? input.id;
      const expectedRevision = options.expectedRevision ?? input.expectedRevision;
      if (typeof id !== "string" || !id) throw new Error("delete requires id");
      if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision)) {
        throw new Error("delete requires expectedRevision");
      }
      const result = await service.delete(cwd, id, expectedRevision);
      writeJson(result === undefined ? { deleted: true } : result);
      return;
    }
    case "export":
      writeJson(await service.export(cwd));
      return;
    case "import":
      writeJson(await service.import(cwd, await readJsonInput(MAX_IMPORT_BYTES)));
      return;
  }
}

async function loadAnnotationService(configuredBase?: string): Promise<AnnotationService> {
  // Keep --help independent of service loading and private-store initialization.
  try {
    const loaded = await import("./service.js") as {
      AnnotationService?: AnnotationServiceConstructor;
    };
    if (!loaded.AnnotationService) throw new Error("annotation service has no AnnotationService export");
    return new loaded.AnnotationService(configuredBase);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Annotation service is unavailable: ${detail}`);
  }
}

async function readJsonInput(maximumBytes = MAX_STDIN_BYTES): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = chunk instanceof Uint8Array
      ? chunk
      : new TextEncoder().encode(String(chunk));
    size += bytes.byteLength;
    if (size > maximumBytes) {
      throw new Error(`stdin exceeds the ${maximumBytes} byte limit`);
    }
    chunks.push(bytes);
  }
  if (size === 0) throw new Error("JSON input is required on stdin");
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    throw new Error("stdin is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("stdin is not valid JSON");
  }
}

function objectInput(input: unknown, command: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${command} input must be a JSON object`);
  }
  return input as Record<string, unknown>;
}

function annotationAuthor(input: unknown, options: AnnotationCliOptions): AnnotationAuthor {
  const supplied = input === undefined ? {} : input;
  if (typeof supplied !== "object" || supplied === null || Array.isArray(supplied)) {
    throw new Error("author must be a JSON object");
  }
  const candidate = supplied as Record<string, unknown>;
  const kind = options.authorKind ?? candidate.kind ?? "agent";
  const name = options.authorName ?? candidate.name ?? "local-agent";
  if (kind !== "human" && kind !== "agent") throw new Error("author.kind must be human or agent");
  if (typeof name !== "string" || !name) throw new Error("author.name must be a non-empty string");
  const sessionId = options.sessionId ?? candidate.sessionId;
  const model = options.model ?? candidate.model;
  if (sessionId !== undefined && typeof sessionId !== "string") throw new Error("author.sessionId must be a string");
  if (model !== undefined && typeof model !== "string") throw new Error("author.model must be a string");
  return {
    kind,
    name,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(model === undefined ? {} : { model }),
  };
}

function splitOption(argument: string): [string, string | undefined] {
  const separator = argument.indexOf("=");
  return separator < 0
    ? [argument, undefined]
    : [argument.slice(0, separator), argument.slice(separator + 1)];
}

function optionValue(args: string[], index: number, inlineValue: string | undefined, option: string): string {
  if (inlineValue !== undefined) {
    if (!inlineValue) throw new Error(`${option} requires a value`);
    return inlineValue;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value`);
  return value;
}

function parseRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("expected revision must be a positive integer");
  return revision;
}

function requireCommand(command: AnnotationCommand | undefined, option: string): void {
  if (!command) throw new Error(`${option} requires a command`);
}

function requireCommandIs(command: AnnotationCommand | undefined, expected: AnnotationCommand, option: string): void {
  if (command !== expected) throw new Error(`${option} is not valid for ${command ?? "this command"}`);
}

function requireCommandIsOneOf(command: AnnotationCommand | undefined, expected: AnnotationCommand[], option: string): void {
  if (!command || !expected.includes(command)) throw new Error(`${option} is not valid for ${command ?? "this command"}`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function printHelp(usage: string): void {
  process.stdout.write(`Usage: ${usage} [global options] <command> [options]\n\nCommands:\n  list       List annotations and derived placements\n  create     Create an annotation from JSON stdin\n  update     Update an annotation from JSON stdin\n  delete     Delete an annotation after an optimistic revision check\n  export     Write a portable export document to stdout\n  import     Import a portable export document from JSON stdin\n\nGlobal options:\n  --cwd <path>       Repository/worktree (default: current directory)\n  --data-dir <path>  Private annotation store (otherwise PI_WEBUI_ANNOTATIONS_DIR)\n  -h, --help         Show this help\n\nList options:\n  --ref <ref>        Git ref, HEAD by default; WORKTREE is ephemeral\n  --path <path>      Restrict results to a repository-relative path\n  --include-resolved Include resolved annotations\n\nCreate author options:\n  --author-kind <kind>  human or agent (default: agent)\n  --author-name <name>  Attribution (default: local-agent)\n  --session-id <id>     Optional self-reported session label\n  --model <model>       Optional self-reported model label\n\nUpdate/delete options:\n  --id <id>                 Override id from stdin\n  --expected-revision <n>  Override expectedRevision from stdin\n\nMutation input is one JSON object on stdin. Export stdout can be redirected to a file;\nimport reads that file with shell redirection. Output is machine-readable JSON only.\n`);
}

/** Entrypoint shared by the Node bin and host wrappers; importing has no effects. */
export async function runAnnotationCli(args = process.argv.slice(2), usage = "source-annotations"): Promise<void> {
  try {
    await main(args, usage);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

export type { AnnotationCategory, AnnotationState, AnnotationWhitespace };
