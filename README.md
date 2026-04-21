# skelograph

`skelograph` builds a deterministic skeleton graph of a project folder.

This is a clean-room tool by Zubair Safi. The v0 goal is intentionally small: scan a folder, detect useful files, infer a lightweight file/module graph, and write inspectable outputs.

## Install

```bash
npm install -g skelograph
```

## Use

```bash
skelograph .
skelograph ./src --out skelograph-out
skelograph . --format text
```

Outputs:

```text
skelograph-out/
  graph.json
  GRAPH_REPORT.md
```

## Claude Code

Install project-local Claude Code guidance:

```bash
skelograph install claude
```

This creates:

```text
CLAUDE.md
.claude/commands/skelograph.md
```

Then, inside Claude Code, run:

```text
/skelograph
```

Claude will rebuild the graph, read `skelograph-out/GRAPH_REPORT.md`, and use `skelograph-out/graph.json` as the project map before searching raw files.

Preview changes first:

```bash
skelograph install claude --dry-run
```

## Trust Posture

- No postinstall scripts.
- No telemetry.
- No network calls during analysis.
- No execution of analyzed source files.
- No assistant hooks unless a future explicit install command is added.

## Ignore Rules

Create `.skelographignore` in the analyzed root. The syntax is intentionally small for v0:

```gitignore
node_modules/
dist/
*.generated.ts
secrets.json
```

Negation rules are not supported yet.

