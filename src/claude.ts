import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { upsertMarkedSection } from "./preserve.js";

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

const ENFORCEMENT_BLOCK = `## Project Navigation — HARD RULES

This project has a skelograph-generated map at \`.claude/\`. These rules are not suggestions; follow them on every task.

**ALWAYS:**
1. Read \`.claude/INDEX.md\` FIRST, before any other exploration. Its "Where to Look" table routes you to the right file for the task at hand.
2. Use \`.claude/MAP.json\` to locate symbols by name. One JSON lookup beats any number of \`grep\` passes.
3. Consult \`.claude/FLOWS/{name}.md\` for cross-package or end-to-end behavior. Flows explain the *why* behind the code path — import graphs can't.
4. Open \`.claude/PACKAGES/{name}.md\` only AFTER scope has narrowed to that package.

**NEVER:**
1. Do NOT scan the repo blindly with \`ls\`, broad \`Glob\`, or \`Grep\` before reading \`INDEX.md\`. The map exists so you don't have to.
2. Do NOT open raw source files for orientation. Source reading is for implementation, not navigation.
3. Do NOT ignore \`.claude/FLOWS/\` when the task crosses package boundaries. That's exactly what flows are for.
4. Do NOT regenerate \`.claude/\` files yourself. Run \`/skelograph\` if the map looks stale.

**When the map is wrong or missing a route:** tell the user, then fall back to direct exploration for that task only. Do not silently work around a gap.`;

const COMMAND_TEXT = `---
description: Refresh the skelograph map at .claude/ for this project
argument-hint: [path]
---

Refresh the project navigation map, then orient yourself through it.

Steps:

1. Run \`skelograph $ARGUMENTS\` if arguments were provided, otherwise \`skelograph .\`.
2. Read \`.claude/INDEX.md\` (only this file; do not open PACKAGES/ or FLOWS/ yet).
3. Report back: the project type, the number of packages, the number of entry points, and the top 3 rows of the "Where to Look" table.
4. Only open further \`.claude/\` files if the user's question requires it.

Do not scan the repo with Glob or Grep during this command — the map is authoritative.
`;

export async function installClaude(options: ClaudeInstallOptions): Promise<ClaudeInstallResult> {
  const root = resolve(options.root);
  const claudeMdPath = join(root, "CLAUDE.md");
  const commandPath = join(root, ".claude", "commands", "skelograph.md");
  const changed: string[] = [];

  const existingClaudeMd = await readTextIfExists(claudeMdPath);
  const nextClaudeMd = upsertMarkedSection(existingClaudeMd ?? "", ENFORCEMENT_BLOCK, { placement: "top" });
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

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}
