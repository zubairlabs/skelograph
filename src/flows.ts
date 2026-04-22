import type {
  EntryPoint,
  FileRecord,
  FlowDecisionPoint,
  FlowFailurePath,
  FlowSpec,
  FlowStep,
  SkelImport,
  SkelSymbol,
  SvelteInventory,
  WorkspaceInfo,
} from "./types.js";
import { packageForFile } from "./workspace.js";
import { extractJsCalls, findJsSymbolDefinition } from "./extractors.js";
import {
  extractMethodCalls,
  extractUtoipaAnnotations,
  findAxumRoutes,
  findHandlerDefinition,
  findMethodDefinition,
} from "./rust_extractors.js";

const MAX_FLOW_DEPTH = 4;

interface FlowBuildInput {
  files: FileRecord[];
  fileImports: Record<string, SkelImport[]>;
  fileSymbols: Record<string, SkelSymbol[]>;
  entryPoints: EntryPoint[];
  workspace: WorkspaceInfo;
  svelte?: SvelteInventory;
}

export function buildFlows(input: FlowBuildInput): FlowSpec[] {
  const flows: FlowSpec[] = [];
  const fileByPath = new Map(input.files.map((file) => [file.relativePath, file]));

  for (const entry of input.entryPoints) {
    if (!isFlowableEntry(entry)) continue;
    const entryFile = fileByPath.get(entry.filePath);
    if (!entryFile) continue;
    const spec = buildFlowForEntry(entry, entryFile, input, fileByPath);
    if (spec) flows.push(spec);
  }

  return flows;
}

function isFlowableEntry(entry: EntryPoint): boolean {
  return [
    "sveltekit-server",
    "sveltekit-page-server",
    "sveltekit-form-action",
    "sveltekit-hooks",
    "next-route",
    "next-middleware",
    "express-app",
    "fastify-app",
    "websocket",
    "queue-worker",
    "axum-route",
    "rust-main",
  ].includes(entry.kind);
}

function buildFlowForEntry(
  entry: EntryPoint,
  entryFile: FileRecord,
  input: FlowBuildInput,
  fileByPath: Map<string, FileRecord>,
): FlowSpec {
  const name = flowNameForEntry(entry);
  const title = flowTitleForEntry(entry);

  const trigger = triggerDescription(entry, entryFile);
  const preconditions = collectPreconditions(entryFile, input);
  const steps = traceSteps(entry, entryFile, input, fileByPath);
  const decisionPoints = collectDecisionPoints(steps, fileByPath);
  const utoipaDecisions = collectUtoipaDecisions(entry, entryFile);
  decisionPoints.unshift(...utoipaDecisions);
  const failurePaths = collectFailurePaths(steps, fileByPath, input.workspace);
  const related = collectRelated(entry, steps, input.entryPoints);
  if (input.svelte?.apiCallers && entry.routePath) {
    const callers = input.svelte.apiCallers[entry.routePath]
      ?? input.svelte.apiCallers[entry.routePath.replace(/\/\[[^\]]+\]/g, "/:id")];
    if (callers && callers.length > 0) {
      const uniqueCallers = new Set(callers.map((c) => `${c.routePath} ← ${c.fromFile}:${c.line}`));
      for (const caller of [...uniqueCallers].slice(0, 6)) {
        related.push(`Called by page: \`${caller}\``);
      }
    }
  }

  return {
    name,
    title,
    entry,
    trigger,
    preconditions,
    steps,
    decisionPoints,
    failurePaths,
    related,
  };
}

export function flowNameForEntry(entry: EntryPoint): string {
  if (entry.routePath) {
    const base = entry.routePath.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/gi, "_").toLowerCase();
    const method = entry.httpMethod ? entry.httpMethod.toLowerCase() : "route";
    const slug = base ? `${method}_${base}` : method;
    return entry.packageName ? `${packageSlug(entry.packageName)}__${slug}` : slug;
  }
  const slug = entry.filePath
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase();
  return slug || entry.id;
}

function packageSlug(name: string): string {
  return name.replace(/^@/, "").replace(/[^a-z0-9_-]+/gi, "_");
}

function flowTitleForEntry(entry: EntryPoint): string {
  switch (entry.kind) {
    case "sveltekit-server":
      return `${entry.httpMethod ?? "Request"} ${entry.routePath ?? entry.filePath}`;
    case "sveltekit-page-server":
      return `Page load ${entry.routePath ?? entry.filePath}`;
    case "sveltekit-form-action":
      return entry.label;
    case "sveltekit-hooks":
      return "SvelteKit server hooks";
    case "next-route":
      return `${entry.httpMethod ?? "Request"} ${entry.routePath ?? entry.filePath}`;
    case "next-middleware":
      return "Next middleware";
    case "express-app":
      return `Express app (${entry.filePath})`;
    case "fastify-app":
      return `Fastify app (${entry.filePath})`;
    case "websocket":
      return `WebSocket (${entry.filePath})`;
    case "queue-worker":
      return `Queue worker (${entry.filePath})`;
    case "axum-route": {
      const pkg = entry.packageName ? ` [${entry.packageName}]` : "";
      return `${entry.httpMethod ?? "Request"} ${entry.routePath ?? "/"}${pkg}`;
    }
    case "rust-main":
      return `${entry.packageName ?? "binary"} — fn main`;
    default:
      return entry.label;
  }
}

function triggerDescription(entry: EntryPoint, file: FileRecord): string {
  switch (entry.kind) {
    case "sveltekit-server": {
      // Use the entry's specific method — not every method in the file — so
      // POST's flow isn't titled "GET, POST, DELETE".
      const method = entry.httpMethod ?? "GET";
      void file;
      return `${method} ${entry.routePath ?? "/"}`;
    }
    case "sveltekit-page-server":
      return `Page load for ${entry.routePath ?? "/"}`;
    case "sveltekit-form-action":
      return `Form POST to ${entry.routePath ?? "/"} (action \`${entry.label.replace(/^Form action /, "").split(" ")[0]}\`)`;
    case "sveltekit-hooks":
      return "Every request to the SvelteKit server";
    case "next-route": {
      const method = entry.httpMethod ?? "GET";
      void file;
      return `${method} ${entry.routePath ?? "/"}`;
    }
    case "next-middleware":
      return "Every request matching the middleware matcher";
    case "express-app":
      return "Express `app.listen` boot + incoming HTTP requests";
    case "fastify-app":
      return "Fastify `listen` boot + incoming HTTP requests";
    case "websocket":
      return "WebSocket connection";
    case "queue-worker":
      return "Queue message consumption";
    case "axum-route":
      return `${entry.httpMethod ?? "Request"} ${entry.routePath ?? "/"}`;
    case "rust-main":
      return "Process start (`fn main`)";
    default:
      return "Entry invocation";
  }
}

function collectPreconditions(entryFile: FileRecord, input: FlowBuildInput): string[] {
  const preconditions: string[] = [];
  const importList = input.fileImports[entryFile.relativePath] ?? [];

  for (const imported of importList) {
    const resolved = imported.resolvedRelativePath;
    if (!resolved) continue;
    if (/\bhooks\.server\b/.test(resolved)) {
      preconditions.push("Passes through `hooks.server.ts` (auth / session guards apply).");
    }
    if (/\bauth\b/i.test(resolved) && /session|token|jwt/i.test(imported.specifier + resolved)) {
      preconditions.push(`Session / auth check via \`${imported.specifier}\`.`);
    }
    if (/\brate[-_]?limit\b/i.test(imported.specifier + resolved)) {
      preconditions.push(`Rate limiting via \`${imported.specifier}\`.`);
    }
    if (/\bzod\b|\byup\b|\bjoi\b|\bsuperstruct\b/i.test(imported.specifier)) {
      preconditions.push(`Request validation via \`${imported.specifier}\`.`);
    }
  }

  if (preconditions.length === 0) {
    preconditions.push("_TODO: human curation needed — no middleware/auth imports detected at the entry file._");
  }

  return dedupe(preconditions);
}

function traceSteps(
  entry: EntryPoint,
  entryFile: FileRecord,
  input: FlowBuildInput,
  fileByPath: Map<string, FileRecord>,
): FlowStep[] {
  const steps: FlowStep[] = [];
  const visited = new Set<string>();
  visited.add(entryFile.relativePath);

  steps.push(buildEntryStep(entry, entryFile, input.fileSymbols[entryFile.relativePath]));

  if ((entry.kind === "sveltekit-server" || entry.kind === "next-route") && entry.httpMethod) {
    const body = scopeJsExport(entryFile.content, entry.httpMethod);
    if (body) {
      const calls = extractJsCalls(body.content);
      for (const name of calls.slice(0, 10)) {
        const def = findJsSymbolDefinition(name, entryFile.packageName, input.files, {
          skipFile: entryFile.relativePath,
        });
        if (!def) continue;
        if (visited.has(def.filePath)) continue;
        visited.add(def.filePath);
        const targetFile = fileByPath.get(def.filePath);
        const syms = input.fileSymbols[def.filePath] ?? [];
        const head = syms.find((s) => s.name === name);
        steps.push({
          filePath: def.filePath,
          symbol: name,
          description: (head?.doc ?? `\`${name}\``) + ` — \`${def.filePath}:${def.line}\``,
          packageName: targetFile?.packageName,
        });
        if (steps.length >= 8) break;
      }
    }
  }

  if (entry.kind === "axum-route") {
    const handler = extractAxumHandlerName(entry, entryFile);
    if (handler) {
      const loc = findHandlerDefinition(handler, entryFile, input.files);
      let handlerFilePath = entryFile.relativePath;
      if (loc) {
        const handlerFile = fileByPath.get(loc.filePath);
        if (handlerFile) {
          handlerFilePath = loc.filePath;
          const handlerSymbols = input.fileSymbols[loc.filePath] ?? [];
          const headSymbol = handlerSymbols.find((s) => s.name === handler) ?? handlerSymbols[0];
          const locationSuffix = ` — \`${loc.filePath}:${loc.line}\``;
          steps.push({
            filePath: loc.filePath,
            symbol: handler,
            description: (headSymbol?.doc ?? `handler \`${handler}\``) + locationSuffix,
            packageName: handlerFile.packageName,
          });
          if (loc.filePath !== entryFile.relativePath) visited.add(loc.filePath);
        }
      } else {
        steps.push({
          filePath: entryFile.relativePath,
          symbol: handler,
          description: `handler \`${handler}\` — definition not found in \`${entry.packageName ?? "this package"}\` (may be re-exported from another crate; check MAP.json).`,
          packageName: entryFile.packageName,
        });
      }

      // 1-hop method resolution within the handler body.
      const handlerFile = fileByPath.get(handlerFilePath);
      if (handlerFile) {
        const scoped = scopeHandlerBody(handlerFile.content, handler);
        if (scoped) {
          // Build a preferred-crate set from the entry file's `use` statements.
          const preferredCrates = new Set<string>();
          if (handlerFile.packageName) preferredCrates.add(handlerFile.packageName);
          for (const imp of input.fileImports[handlerFilePath] ?? []) {
            if (imp.targetPackage) preferredCrates.add(imp.targetPackage);
          }
          const crateFilter = (f: FileRecord) => !f.packageName || preferredCrates.has(f.packageName);
          const preferredFiles = input.files.filter(crateFilter);

          const calls = extractMethodCalls(scoped);
          for (const methodName of calls.slice(0, 8)) {
            const def = findMethodDefinition(methodName, handlerFile.packageName, preferredFiles, {
              skipFile: handlerFilePath,
              preferImplQualified: true,
            });
            if (!def) continue;
            if (def.filePath === handlerFilePath) continue;
            if (visited.has(def.filePath)) continue;
            visited.add(def.filePath);
            const targetFile = fileByPath.get(def.filePath);
            const resolvedName = def.qualified ?? methodName;
            const syms = input.fileSymbols[def.filePath] ?? [];
            const head = syms.find((s) => s.name === resolvedName || s.name.endsWith(`::${methodName}`));
            steps.push({
              filePath: def.filePath,
              symbol: resolvedName,
              description: (head?.doc ?? `\`${resolvedName}\``) + ` — \`${def.filePath}:${def.line}\``,
              packageName: targetFile?.packageName,
            });
            if (steps.length >= 8) break;
          }
        }
      }
    }
  }

  const queue: Array<{ path: string; depth: number; via?: string }> = [];
  for (const imported of input.fileImports[entryFile.relativePath] ?? []) {
    if (imported.resolvedRelativePath) {
      queue.push({ path: imported.resolvedRelativePath, depth: 1, via: imported.specifier });
    }
  }

  while (queue.length > 0 && steps.length < 8) {
    const { path, depth, via } = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const file = fileByPath.get(path);
    if (!file) continue;
    if (depth > MAX_FLOW_DEPTH) continue;
    if (!isInterestingStepFile(file)) continue;

    steps.push(buildStep(file, input.fileSymbols[path], via));

    for (const imported of input.fileImports[path] ?? []) {
      if (!imported.resolvedRelativePath) continue;
      if (visited.has(imported.resolvedRelativePath)) continue;
      if (imported.targetPackage && imported.targetPackage === file.packageName && depth >= 2) continue;
      queue.push({ path: imported.resolvedRelativePath, depth: depth + 1, via: imported.specifier });
    }
  }

  return steps;
}

function isInterestingStepFile(file: FileRecord): boolean {
  if (!file.relativePath.includes("/src/")) return file.relativePath.includes("src/") || true;
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file.relativePath)) return false;
  return true;
}

function buildStep(file: FileRecord, symbols: SkelSymbol[] | undefined, via?: string): FlowStep {
  const publicSymbols = (symbols ?? []).filter((s) => s.visibility === "public" && !/^[A-Z]{2,8}$/.test(s.name));
  const headSymbol = publicSymbols[0] ?? (symbols ?? []).find((s) => s.visibility === "public");
  const description = headSymbol?.doc ?? summarizeFromName(headSymbol?.name) ?? descriptionFromVia(via);

  return {
    filePath: file.relativePath,
    symbol: headSymbol?.name,
    description,
    packageName: file.packageName,
  };
}

function buildEntryStep(entry: EntryPoint, file: FileRecord, symbols: SkelSymbol[] | undefined): FlowStep {
  // Prefer the symbol that matches this entry's specific HTTP method — critical
  // for multi-method files where GET/POST/DELETE all live in one +server.ts.
  const preferred = entry.httpMethod
    ? (symbols ?? []).find((s) => s.visibility === "public" && s.name === entry.httpMethod)
    : undefined;
  const anyMethodHandler = (symbols ?? []).find((s) => s.visibility === "public" && /^[A-Z]{2,8}$/.test(s.name));
  const methodHandler = preferred ?? anyMethodHandler;
  const description = entry.routePath
    ? `entry point for ${entry.httpMethod ?? "request"} ${entry.routePath}`
    : `entry point (${entry.kind})`;
  return {
    filePath: file.relativePath,
    symbol: methodHandler?.name ?? entry.httpMethod,
    description,
    packageName: file.packageName,
  };
}

function descriptionFromVia(via?: string): string | undefined {
  if (!via) return undefined;
  return `imported via \`${via}\``;
}

function summarizeFromName(name?: string): string | undefined {
  if (!name) return undefined;
  if (/^[A-Z]{2,8}$/.test(name)) return undefined;
  if (name.length < 4) return undefined;
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").toLowerCase().trim();
  return words === name.toLowerCase() ? undefined : words;
}

function collectDecisionPoints(steps: FlowStep[], fileByPath: Map<string, FileRecord>): FlowDecisionPoint[] {
  const decisions: FlowDecisionPoint[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const file = fileByPath.get(step.filePath);
    if (!file) continue;

    if (file.relativePath.endsWith(".rs")) {
      // For Rust, decision points MUST be scoped to a specific function — an
      // unscoped scan picks up every other handler in the same file.
      const scopeTarget = step.symbol?.split("::").pop();
      if (!scopeTarget || /^[A-Z]{2,8}$/.test(scopeTarget)) continue;
      const scoped = scopeContentToFunction(file.content, scopeTarget);
      if (!scoped) continue;
      const found = extractDecisionPoints(scoped.content, file.relativePath).map((d) => ({
        ...d,
        line: d.line ? d.line + scoped.startLine : d.line,
      }));
      for (const d of found) {
        const key = `${d.filePath}:${d.line}:${d.description}`;
        if (seen.has(key)) continue;
        seen.add(key);
        decisions.push(d);
      }
      continue;
    }

    // JS/TS: for a `+server.ts`-style handler file, scope to the specific
    // HTTP method export so GET's flow doesn't see POST's decision points.
    const jsScopeTarget = step.symbol?.split(".").pop();
    const looksLikeHandler = jsScopeTarget && /^[A-Z]{2,8}$/.test(jsScopeTarget);
    if (looksLikeHandler) {
      const scoped = scopeJsExport(file.content, jsScopeTarget!);
      if (scoped) {
        const found = extractDecisionPoints(scoped.content, file.relativePath).map((d) => ({
          ...d,
          line: d.line ? d.line + scoped.startLine : d.line,
        }));
        for (const d of found) {
          const key = `${d.filePath}:${d.line}:${d.description}`;
          if (seen.has(key)) continue;
          seen.add(key);
          decisions.push(d);
        }
        continue;
      }
    }

    const found = extractDecisionPoints(file.content, file.relativePath);
    for (const d of found) {
      const key = `${d.filePath}:${d.line}:${d.description}`;
      if (seen.has(key)) continue;
      seen.add(key);
      decisions.push(d);
    }
  }
  if (decisions.length === 0) {
    decisions.push({ description: "_TODO: human curation needed — no response-branching conditionals detected automatically._" });
  }
  return decisions.slice(0, 8);
}

function collectUtoipaDecisions(entry: EntryPoint, entryFile: FileRecord): FlowDecisionPoint[] {
  if (entry.kind !== "axum-route" || !entryFile.relativePath.endsWith(".rs")) return [];
  const annotations = extractUtoipaAnnotations(entryFile);
  const handlerName = extractAxumHandlerName(entry, entryFile);
  if (!handlerName) return [];
  const annotation = annotations.find((a) => a.handlerName === handlerName);
  if (!annotation) return [];
  const decisions: FlowDecisionPoint[] = [];
  for (const resp of annotation.responses) {
    const detail = resp.description ? ` — ${resp.description}` : "";
    const body = resp.body ? ` (body: \`${resp.body}\`)` : "";
    decisions.push({
      description: `\`#[utoipa::path]\` declares HTTP ${resp.status}${detail}${body}`,
      line: annotation.line,
      filePath: entryFile.relativePath,
    });
  }
  if (annotation.requestBody) {
    decisions.push({
      description: `Request body type: \`${annotation.requestBody}\``,
      line: annotation.line,
      filePath: entryFile.relativePath,
    });
  }
  return decisions;
}

function scopeHandlerBody(content: string, handlerName: string): string | undefined {
  const bare = handlerName.split("::").pop() ?? handlerName;
  return scopeContentToFunction(content, bare)?.content;
}

function scopeJsExport(content: string, symbol: string): { content: string; startLine: number } | undefined {
  const lines = content.split(/\r?\n/);
  const patterns = [
    new RegExp(`^\\s*export\\s+(?:async\\s+)?function\\s+${symbol}\\b`),
    new RegExp(`^\\s*export\\s+(?:async\\s+)?const\\s+${symbol}\\b`),
    new RegExp(`^\\s*export\\s+const\\s+${symbol}\\s*:`),
    new RegExp(`^\\s*(?:async\\s+)?function\\s+${symbol}\\b`),
  ];
  for (let i = 0; i < lines.length; i += 1) {
    if (!patterns.some((p) => p.test(lines[i] ?? ""))) continue;
    let braceDepth = 0;
    let parenDepth = 0;
    let started = false;
    const body: string[] = [];
    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j] ?? "";
      body.push(line);
      let inString: '"' | "'" | "`" | undefined;
      for (let k = 0; k < line.length; k += 1) {
        const ch = line[k];
        if (inString) {
          if (ch === "\\") {
            k += 1;
            continue;
          }
          if (ch === inString) inString = undefined;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          inString = ch as '"' | "'" | "`";
          continue;
        }
        if (ch === "(") parenDepth += 1;
        else if (ch === ")") parenDepth -= 1;
        else if (ch === "{" && parenDepth === 0) {
          braceDepth += 1;
          started = true;
        } else if (ch === "}" && parenDepth === 0) {
          braceDepth -= 1;
          if (started && braceDepth === 0) {
            return { content: body.join("\n"), startLine: i };
          }
        }
      }
    }
    return { content: body.join("\n"), startLine: i };
  }
  return undefined;
}

function scopeContentToFunction(content: string, symbol: string): { content: string; startLine: number } | undefined {
  const lines = content.split(/\r?\n/);
  const startPattern = new RegExp(`\\b(?:async\\s+)?fn\\s+${symbol}\\b`);
  for (let i = 0; i < lines.length; i += 1) {
    if (!startPattern.test(lines[i] ?? "")) continue;
    let depth = 0;
    let started = false;
    const body: string[] = [];
    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j] ?? "";
      body.push(line);
      for (const ch of line) {
        if (ch === "{") {
          depth += 1;
          started = true;
        } else if (ch === "}") {
          depth -= 1;
          if (started && depth === 0) {
            return { content: body.join("\n"), startLine: i };
          }
        }
      }
    }
    return { content: body.join("\n"), startLine: i };
  }
  return undefined;
}

function extractDecisionPoints(content: string, filePath: string): FlowDecisionPoint[] {
  if (filePath.endsWith(".rs")) return extractRustDecisionPoints(content, filePath);
  return extractJsDecisionPoints(content, filePath);
}

function extractJsDecisionPoints(content: string, filePath: string): FlowDecisionPoint[] {
  const lines = content.split(/\r?\n/);
  const decisions: FlowDecisionPoint[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    // SvelteKit `error(STATUS, msg)` and `redirect(STATUS, url)` from @sveltejs/kit.
    const skError = /\b(?:throw\s+)?error\s*\(\s*(\d{3})(?:\s*,\s*['"`]([^'"`]*)['"`])?/.exec(line);
    if (skError) {
      const status = skError[1];
      const message = skError[2];
      const conditionLine = findEnclosingCondition(lines, i);
      const kernel = message ? `\`error(${status}, "${message}")\`` : `\`error(${status})\``;
      const description = conditionLine
        ? `\`${conditionLine.trim()}\` → ${kernel} (HTTP ${status})`
        : `${kernel} (HTTP ${status})`;
      decisions.push({ description, line: i + 1, filePath });
      continue;
    }
    const skRedirect = /\b(?:throw\s+)?redirect\s*\(\s*(\d{3})(?:\s*,\s*['"`]([^'"`]*)['"`])?/.exec(line);
    if (skRedirect) {
      const status = skRedirect[1];
      const target = skRedirect[2];
      const conditionLine = findEnclosingCondition(lines, i);
      const kernel = target ? `redirect to \`${target}\`` : `redirect(${status})`;
      const description = conditionLine
        ? `\`${conditionLine.trim()}\` → ${kernel} (HTTP ${status})`
        : `${kernel} (HTTP ${status})`;
      decisions.push({ description, line: i + 1, filePath });
      continue;
    }

    // Generic Response / status-code patterns.
    const statusMatch = /\b(?:new\s+Response\s*\([^)]*,\s*\{[^}]*status\s*:\s*(\d{3})|status\s*:\s*(\d{3})|res\.status\s*\(\s*(\d{3})\s*\)|reply\.code\s*\(\s*(\d{3})\s*\))/.exec(line);
    const status = statusMatch?.[1] ?? statusMatch?.[2] ?? statusMatch?.[3] ?? statusMatch?.[4];
    if (!status) continue;
    const conditionLine = findEnclosingCondition(lines, i);
    const description = conditionLine
      ? `\`${conditionLine.trim()}\` → HTTP ${status}`
      : `HTTP ${status}`;
    decisions.push({ description, line: i + 1, filePath });
  }
  return decisions;
}

const RUST_STATUS_NAMES: Record<string, number> = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  MOVED_PERMANENTLY: 301,
  FOUND: 302,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
};

const RUST_ERROR_VARIANT_MAP: Record<string, number> = {
  BadRequest: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  Conflict: 409,
  Validation: 422,
  ValidationFailed: 422,
  Unprocessable: 422,
  UnprocessableEntity: 422,
  TooManyRequests: 429,
  RateLimited: 429,
  Internal: 500,
  InternalServerError: 500,
  Unavailable: 503,
};

function extractRustDecisionPoints(content: string, filePath: string): FlowDecisionPoint[] {
  const lines = content.split(/\r?\n/);
  const decisions: FlowDecisionPoint[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    let status: string | undefined;
    let variantDescription: string | undefined;

    const statusCodeMatch = /\bStatusCode::([A-Z_]+)/.exec(line);
    if (statusCodeMatch && RUST_STATUS_NAMES[statusCodeMatch[1]]) {
      status = String(RUST_STATUS_NAMES[statusCodeMatch[1]]);
    }
    const apiErrorMatch = /\bApiHttpError::(bad_request|unauthorized|forbidden|not_found|conflict|unprocessable|unprocessable_entity|too_many|too_many_requests|internal)/.exec(line);
    if (!status && apiErrorMatch) {
      const map: Record<string, number> = {
        bad_request: 400,
        unauthorized: 401,
        forbidden: 403,
        not_found: 404,
        conflict: 409,
        unprocessable: 422,
        unprocessable_entity: 422,
        too_many: 429,
        too_many_requests: 429,
        internal: 500,
      };
      status = String(map[apiErrorMatch[1]]);
    }
    const appErrorMatch = /\b(?:AppError|ApiError|ServiceError|DomainError)::([A-Z][A-Za-z]+)/.exec(line);
    if (!status && appErrorMatch && RUST_ERROR_VARIANT_MAP[appErrorMatch[1]]) {
      status = String(RUST_ERROR_VARIANT_MAP[appErrorMatch[1]]);
      variantDescription = `${appErrorMatch[0]}`;
    }
    const errorCallMatch = /\berror\s*\(\s*(\d{3})/.exec(line);
    if (!status && errorCallMatch) status = errorCallMatch[1];

    if (!status) continue;

    const conditionLine = findRustEnclosingCondition(lines, i);
    const prefix = variantDescription ? `${variantDescription} — ` : "";
    const description = conditionLine
      ? `${prefix}\`${conditionLine.trim()}\` → HTTP ${status}`
      : `${prefix || ""}HTTP ${status}`;
    decisions.push({ description, line: i + 1, filePath });
  }
  return decisions;
}

function findRustEnclosingCondition(lines: string[], index: number): string | undefined {
  for (let cursor = index; cursor >= Math.max(0, index - 6); cursor -= 1) {
    const line = lines[cursor] ?? "";
    const match = /\b(if|match|return)\b\s*([^{;]*)/.exec(line);
    if (match) return match[0].replace(/\s+\{?\s*$/, "");
  }
  return undefined;
}

function extractAxumHandlerName(entry: EntryPoint, file: FileRecord): string | undefined {
  if (entry.kind !== "axum-route" || !entry.routePath || !entry.httpMethod) return undefined;
  const hits = findAxumRoutes(file.content);
  const hit = hits.find((h) => h.path === entry.routePath && h.method === entry.httpMethod);
  if (!hit) return undefined;
  return hit.handler.split("::").pop();
}

function findEnclosingCondition(lines: string[], index: number): string | undefined {
  for (let cursor = index; cursor >= Math.max(0, index - 6); cursor -= 1) {
    const line = lines[cursor] ?? "";
    const match = /\b(if|else if|unless)\s*\(([^)]+)\)/.exec(line);
    if (match) return match[0];
  }
  return undefined;
}

function collectFailurePaths(
  steps: FlowStep[],
  fileByPath: Map<string, FileRecord>,
  workspace: WorkspaceInfo,
): FlowFailurePath[] {
  const failures: FlowFailurePath[] = [];
  for (const step of steps) {
    const file = fileByPath.get(step.filePath);
    if (!file) continue;
    const scoped = step.symbol && file.relativePath.endsWith(".rs")
      ? scopeContentToFunction(file.content, step.symbol)
      : undefined;
    const content = scoped?.content ?? file.content;

    if (file.relativePath.endsWith(".rs")) {
      const questionMark = /^[^\/\n]*?\?\s*;/m.test(content);
      if (questionMark) {
        failures.push({
          description: `\`${file.relativePath}\` uses \`?\` operator — errors propagate to the caller.`,
          filePath: file.relativePath,
        });
      }
      const anyhowBail = /\banyhow::bail!|\bbail!\s*\(/.exec(content);
      if (anyhowBail) {
        failures.push({
          description: `\`${file.relativePath}\` calls \`bail!\` / \`anyhow::bail!\` — returns early with an error.`,
          filePath: file.relativePath,
        });
      }
      const apiError = /\bApiHttpError::[a-z_]+\s*\(/.exec(content);
      if (apiError) {
        failures.push({
          description: `\`${file.relativePath}\` returns \`ApiHttpError\` variants on failure.`,
          filePath: file.relativePath,
        });
      }
      const panicMatch = /\bpanic!\s*\(|\b\.unwrap\s*\(\s*\)/.exec(content);
      if (panicMatch && !apiError) {
        failures.push({
          description: `\`${file.relativePath}\` contains \`${panicMatch[0]}\` — unrecoverable if hit.`,
          filePath: file.relativePath,
        });
      }
      continue;
    }

    if (/\btry\s*\{/.test(content) && /\bcatch\b/.test(content)) {
      failures.push({
        description: `\`${file.relativePath}\` wraps logic in try/catch; failures are caught locally.`,
        filePath: file.relativePath,
      });
    }
    const throwMatch = /\bthrow\s+(?:new\s+)?([A-Za-z_][\w]*(?:Error)?)\s*\(/.exec(content);
    if (throwMatch) {
      failures.push({
        description: `\`${file.relativePath}\` may throw \`${throwMatch[1]}\`.`,
        filePath: file.relativePath,
      });
    }
  }
  if (failures.length === 0) {
    failures.push({ description: "_TODO: human curation needed — no explicit try/catch or throw boundaries found in this trace._" });
  }
  void workspace;
  return dedupe(failures.map((f) => f.description)).slice(0, 6).map((description) => ({ description }));
}

function collectRelated(entry: EntryPoint, steps: FlowStep[], allEntries: EntryPoint[]): string[] {
  const stepFiles = new Set(steps.map((step) => step.filePath));
  const related: string[] = [];
  for (const other of allEntries) {
    if (other.id === entry.id) continue;
    if (stepFiles.has(other.filePath)) {
      related.push(`FLOWS/${flowNameForEntry(other)}.md`);
    }
  }
  return dedupe(related).slice(0, 5);
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
