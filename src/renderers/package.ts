import type { PackageInfo, SkelSymbol, Skelograph, SveltePage } from "../types.js";
import { packageFileName } from "./index.js";

function renderPagesTable(pages: SveltePage[]): string {
  const header = "| Route | Page | Load | Actions | Calls |";
  const sep = "|-------|------|------|---------|-------|";
  const rows = pages.slice(0, 40).map((page) => {
    const pageCell = page.pageFile ? `[\`${page.pageFile}\`](${repoLink(page.pageFile)})` : "_(no +page.svelte)_";
    const loadFiles = [page.pageServerFile, page.pageTsFile, page.layoutServerFile].filter((f): f is string => Boolean(f));
    const loadCell = loadFiles.length > 0 ? loadFiles.map((f) => `\`${basename(f)}\``).join(" + ") : "—";
    const actionsCell = page.hasActions ? "yes" : "—";
    const callsCell = page.fetchCalls.length > 0
      ? page.fetchCalls.slice(0, 4).map((c) => `${c.method ?? "GET"} ${c.url}`).join("; ") + (page.fetchCalls.length > 4 ? ` (+${page.fetchCalls.length - 4})` : "")
      : "—";
    return `| \`${page.routePath}\` | ${pageCell} | ${loadCell} | ${actionsCell} | ${callsCell} |`;
  });
  const tail = pages.length > 40 ? `\n_…and ${pages.length - 40} more pages._` : "";
  return [header, sep, ...rows].join("\n") + tail;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function repoLink(path: string): string {
  return path;
}

function manifestName(relativePath: string, isCargo: boolean): string {
  void relativePath;
  return isCargo ? "Cargo.toml" : "package.json";
}

function symbolKindLabel(kind: string, isRust: boolean): string {
  if (!isRust) return kind;
  switch (kind) {
    case "class":
      return "struct";
    case "interface":
      return "trait";
    case "function":
      return "fn";
    case "const":
      return "const";
    case "type":
      return "type";
    case "enum":
      return "enum";
    default:
      return kind;
  }
}

export interface PackagePage {
  filename: string;
  content: string;
}

export function renderPackagePages(graph: Skelograph): PackagePage[] {
  return graph.workspace.packages.map((pkg) => ({
    filename: `${packageFileName(pkg)}.md`,
    content: renderPackage(pkg, graph),
  }));
}

function renderPackage(pkg: PackageInfo, graph: Skelograph): string {
  const lines: string[] = [];
  const isCargo = graph.workspace.kind === "cargo";
  lines.push(`# ${pkg.name}`);
  lines.push("");
  const rel = pkg.relativePath === "." ? "(repo root)" : pkg.relativePath;
  lines.push(`_Path: \`${rel}\`_`);
  lines.push("");

  lines.push("## Purpose");
  lines.push("");
  const purpose = pkg.description?.trim() || findFirstFileDoc(pkg, graph) || `_TODO: add a one-line description to ${manifestName(rel, isCargo)}._`;
  lines.push(purpose);
  lines.push("");

  lines.push("## Public API");
  lines.push("");
  lines.push(renderPublicApi(pkg, graph));
  lines.push("");

  lines.push("## Entry Points");
  lines.push("");
  const entries = graph.entryPoints.filter((entry) => entry.packageName === pkg.name);
  if (entries.length === 0) {
    lines.push("_None detected in this package._");
  } else {
    for (const entry of entries.slice(0, 20)) {
      lines.push(`- **${entry.label}** — \`${entry.filePath}\``);
    }
    if (entries.length > 20) {
      lines.push(`- …and ${entries.length - 20} more. See [ENTRYPOINTS.md](../ENTRYPOINTS.md).`);
    }
  }
  lines.push("");

  lines.push("## Depends On");
  lines.push("");
  lines.push(renderDependencies(pkg, graph));
  lines.push("");

  lines.push("## Used By");
  lines.push("");
  lines.push(renderUsedBy(pkg, graph));
  lines.push("");

  const pages = graph.svelte.pages.filter((page) => page.packageName === pkg.name);
  if (pages.length > 0) {
    lines.push("## Pages");
    lines.push("");
    lines.push(renderPagesTable(pages));
    lines.push("");
  }

  if (!isCargo && pkg.scripts && Object.keys(pkg.scripts).length > 0) {
    lines.push("## Scripts");
    lines.push("");
    for (const [name, cmd] of Object.entries(pkg.scripts).slice(0, 10)) {
      lines.push(`- \`npm run ${name}\` — \`${cmd}\``);
    }
    lines.push("");
  }

  const text = lines.join("\n");
  return text.length > 20_000 ? text.slice(0, 20_000) + "\n\n_…truncated; package is large, consider per-module drill-down in a future run._\n" : text;
}

function renderPublicApi(pkg: PackageInfo, graph: Skelograph): string {
  const isRust = graph.workspace.kind === "cargo";
  const packageFiles = Object.entries(graph.fileSymbols).filter(([filePath]) => {
    const node = graph.nodes.find((n) => n.id === `file:${filePath}`);
    return node?.packageName === pkg.name;
  });

  if (packageFiles.length === 0) {
    return "_No public exports detected._";
  }

  const rowsByFile = new Map<string, SkelSymbol[]>();
  for (const [filePath, symbols] of packageFiles) {
    const publics = symbols.filter((s) => s.visibility === "public" && !s.isDefault);
    if (publics.length > 0) rowsByFile.set(filePath, publics);
  }

  if (rowsByFile.size === 0) return "_No public exports detected._";

  const chunks: string[] = [];
  let count = 0;
  for (const [filePath, publics] of [...rowsByFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    chunks.push(`### \`${filePath}\``);
    chunks.push("");
    for (const symbol of publics) {
      const doc = symbol.doc ? ` — ${symbol.doc}` : "";
      const label = symbolKindLabel(symbol.kind, isRust);
      chunks.push(`- \`${label} ${symbol.name}\`${doc}`);
      count += 1;
      if (count >= 80) break;
    }
    chunks.push("");
    if (count >= 80) {
      chunks.push("_Truncated at 80 symbols — consult MAP.json for more._");
      break;
    }
  }
  return chunks.join("\n").trim();
}

function renderDependencies(pkg: PackageInfo, graph: Skelograph): string {
  const internal = new Set<string>();
  const externalCandidates = new Set(pkg.dependencies);

  for (const edge of graph.edges) {
    if (edge.relation !== "imports") continue;
    if (!edge.source.startsWith("file:")) continue;
    const sourceFile = edge.source.replace(/^file:/, "");
    const sourceNode = graph.nodes.find((n) => n.id === edge.source);
    if (sourceNode?.packageName !== pkg.name) continue;

    if (edge.target.startsWith("file:")) {
      const targetNode = graph.nodes.find((n) => n.id === edge.target);
      if (targetNode?.packageName && targetNode.packageName !== pkg.name) {
        internal.add(targetNode.packageName);
      }
    } else if (edge.target.startsWith("external:")) {
      const specifier = edge.target.replace(/^external:/, "");
      externalCandidates.add(specifier);
    }
    void sourceFile;
  }

  const sectionLines: string[] = [];
  if (internal.size > 0) {
    sectionLines.push("**Internal (workspace packages):**");
    sectionLines.push("");
    for (const name of [...internal].sort()) sectionLines.push(`- \`${name}\``);
    sectionLines.push("");
  }
  if (pkg.dependencies.length > 0) {
    sectionLines.push("**External (from package.json):**");
    sectionLines.push("");
    const deps = pkg.dependencies.slice(0, 20);
    for (const name of deps) sectionLines.push(`- \`${name}\``);
    if (pkg.dependencies.length > 20) sectionLines.push(`- …and ${pkg.dependencies.length - 20} more`);
    sectionLines.push("");
  }
  return sectionLines.length > 0 ? sectionLines.join("\n").trim() : "_No dependencies._";
}

function renderUsedBy(pkg: PackageInfo, graph: Skelograph): string {
  const users = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.relation !== "imports") continue;
    if (!edge.target.startsWith("file:")) continue;
    const targetNode = graph.nodes.find((n) => n.id === edge.target);
    if (targetNode?.packageName !== pkg.name) continue;
    const sourceNode = graph.nodes.find((n) => n.id === edge.source);
    if (sourceNode?.packageName && sourceNode.packageName !== pkg.name) {
      users.add(sourceNode.packageName);
    }
  }
  if (users.size === 0) return "_No internal consumers detected._";
  return [...users].sort().map((name) => `- \`${name}\``).join("\n");
}

function findFirstFileDoc(pkg: PackageInfo, graph: Skelograph): string | undefined {
  for (const [filePath, doc] of Object.entries(graph.fileDoc)) {
    const node = graph.nodes.find((n) => n.id === `file:${filePath}`);
    if (node?.packageName === pkg.name) return doc;
  }
  return undefined;
}
