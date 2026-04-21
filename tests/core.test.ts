import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isIgnored, parseIgnoreRule } from "../src/ignore.js";
import { scan } from "../src/scanner.js";
import { buildGraph } from "../src/graph.js";
import { installClaude } from "../src/claude.js";

test("ignore rules match directories and globs", () => {
  const rules = [parseIgnoreRule("node_modules/"), parseIgnoreRule("*.generated.ts")];
  assert.equal(isIgnored(rules, "node_modules", true), true);
  assert.equal(isIgnored(rules, "pkg/node_modules", true), true);
  assert.equal(isIgnored(rules, "src/foo.generated.ts", false), true);
  assert.equal(isIgnored(rules, "src/foo.ts", false), false);
});

test("scan skips ignored and sensitive files", async () => {
  const root = await mkdtemp(join(tmpdir(), "skelograph-scan-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "src", "index.ts"), "export function run() {}\n", "utf8");
    await writeFile(join(root, "dist", "ignored.ts"), "export function nope() {}\n", "utf8");
    await writeFile(join(root, ".env"), "TOKEN=secret\n", "utf8");

    const result = await scan(root);
    assert.deepEqual(result.files.map((file) => file.relativePath), ["src/index.ts"]);
    assert.equal(result.stats.skippedSensitive, 1);
    assert.equal(result.stats.totalFiles, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("graph includes files, symbols, and resolved imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "skelograph-graph-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "util.ts"), "export function helper() { return 1; }\n", "utf8");
    await writeFile(
      join(root, "src", "index.ts"),
      "import { helper } from './util';\nexport const run = () => helper();\n",
      "utf8",
    );

    const graph = buildGraph(await scan(root));
    assert.ok(graph.nodes.some((node) => node.id === "file:src/index.ts"));
    assert.ok(graph.nodes.some((node) => node.id === "symbol:src/index.ts:function:run"));
    assert.ok(!graph.nodes.some((node) => node.id === "symbol:src/index.ts:function:default"));
    assert.ok(
      graph.edges.some(
        (edge) => edge.source === "file:src/index.ts"
          && edge.target === "file:src/util.ts"
          && edge.relation === "imports",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claude install writes project memory and slash command", async () => {
  const root = await mkdtemp(join(tmpdir(), "skelograph-claude-"));
  try {
    await writeFile(join(root, "CLAUDE.md"), "# Existing Notes\n\nKeep this.\n", "utf8");

    const dryRun = await installClaude({ root, dryRun: true });
    assert.equal(dryRun.changed.length, 2);

    const result = await installClaude({ root });
    assert.equal(result.changed.length, 2);

    const claudeMd = await readFile(join(root, "CLAUDE.md"), "utf8");
    const command = await readFile(join(root, ".claude", "commands", "skelograph.md"), "utf8");

    assert.match(claudeMd, /# Existing Notes/);
    assert.match(claudeMd, /## skelograph/);
    assert.match(command, /description: Build or refresh the skelograph graph brain/);

    const secondRun = await installClaude({ root });
    assert.equal(secondRun.changed.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
