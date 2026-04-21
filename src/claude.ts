import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface ClaudeInstallOptions {
  root: string;
  dryRun?: boolean;
}

export interface ClaudeInstallResult {
  root: string;
  claudeMdPath: string;
  commandPath: string;
  changed: string[];
  dryRun: boolean;
}

const CLAUDE_MARKER_START = "<!-- skelograph:start -->";
const CLAUDE_MARKER_END = "<!-- skelograph:end -->";

const CLAUDE_SECTION = [
  CLAUDE_MARKER_START,
  "",
  "## skelograph",
  "",
  "This project can use `skelograph` as a lightweight graph brain for codebase navigation.",
  "",
  'Before answering architecture, dependency, refactor, onboarding, or "where is this?" questions:',
  "",
  "1. If `skelograph-out/GRAPH_REPORT.md` exists, read it first.",
  "2. If deeper detail is needed, inspect `skelograph-out/graph.json` before searching raw files.",
  "3. If the graph is missing or stale, ask before rebuilding unless the user explicitly requested analysis.",
  "4. When rebuilding is appropriate, run `skelograph .` from the project root.",
  "5. Treat `AMBIGUOUS` edges as hints, not facts.",
  "",
  "Useful files:",
  "",
  "- `skelograph-out/GRAPH_REPORT.md` gives the human-readable summary.",
  "- `skelograph-out/graph.json` gives the machine-readable node and edge map.",
  "",
  CLAUDE_MARKER_END,
].join("\n");

const COMMAND_TEXT = `---
description: Build or refresh the skelograph graph brain for this project
argument-hint: [path]
---

Build or refresh the project skeleton graph, then use it to orient yourself before reading raw files.

Use the path from arguments if provided; otherwise use the current project root.

Steps:

1. Run \`skelograph $ARGUMENTS\` if arguments were provided, otherwise run \`skelograph .\`.
2. Read \`skelograph-out/GRAPH_REPORT.md\`.
3. If more precision is needed, inspect \`skelograph-out/graph.json\`.
4. Summarize the main directories, largest files, symbols, and import relationships you found.
5. Call out any \`AMBIGUOUS\` edges as hypotheses rather than facts.
`;

export async function installClaude(options: ClaudeInstallOptions): Promise<ClaudeInstallResult> {
  const root = resolve(options.root);
  const claudeMdPath = join(root, "CLAUDE.md");
  const commandPath = join(root, ".claude", "commands", "skelograph.md");
  const changed: string[] = [];

  const existingClaudeMd = await readTextIfExists(claudeMdPath);
  const nextClaudeMd = upsertMarkedSection(existingClaudeMd ?? "", CLAUDE_SECTION);
  if (nextClaudeMd !== (existingClaudeMd ?? "")) changed.push(claudeMdPath);

  const existingCommand = await readTextIfExists(commandPath);
  if (existingCommand !== COMMAND_TEXT) changed.push(commandPath);

  if (!options.dryRun) {
    if (nextClaudeMd !== (existingClaudeMd ?? "")) {
      await writeFile(claudeMdPath, nextClaudeMd, "utf8");
    }
    if (existingCommand !== COMMAND_TEXT) {
      await mkdir(join(root, ".claude", "commands"), { recursive: true });
      await writeFile(commandPath, COMMAND_TEXT, "utf8");
    }
  }

  return {
    root,
    claudeMdPath,
    commandPath,
    changed,
    dryRun: Boolean(options.dryRun),
  };
}

function upsertMarkedSection(existing: string, section: string): string {
  const normalized = existing.replace(/\s+$/u, "");
  const start = normalized.indexOf(CLAUDE_MARKER_START);
  const end = normalized.indexOf(CLAUDE_MARKER_END);

  if (start >= 0 && end > start) {
    const before = normalized.slice(0, start).trimEnd();
    const after = normalized.slice(end + CLAUDE_MARKER_END.length).trimStart();
    return [before, section, after].filter(Boolean).join("\n\n") + "\n";
  }

  return [normalized, section].filter(Boolean).join("\n\n") + "\n";
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}
