import { posix } from "node:path";
import {
  detectEntryPoints,
  extractFetchCalls,
  extractFileDoc,
  extractImports,
  extractSymbols,
} from "./extractors.js";
import { buildFlows } from "./flows.js";
import { packageForFile } from "./workspace.js";
import type {
  EntryPoint,
  FileRecord,
  GraphEdge,
  GraphNode,
  HotspotInfo,
  ScanResult,
  SkelImport,
  SkelSymbol,
  Skelograph,
  SvelteInventory,
  SveltePage,
} from "./types.js";

export function buildGraph(scan: ScanResult): Skelograph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const projectId = "project:root";
  addNode(nodes, {
    id: projectId,
    label: posix.basename(scan.root.replace(/\\/g, "/")) || scan.root,
    kind: "project",
    sourcePath: ".",
  });

  for (const pkg of scan.workspace.packages) {
    if (pkg.relativePath === "." && scan.workspace.packages.length === 1) continue;
    addNode(nodes, {
      id: `package:${pkg.name}`,
      label: pkg.name,
      kind: "package",
      sourcePath: pkg.relativePath,
      packageName: pkg.name,
    });
    addEdge(edges, {
      source: projectId,
      target: `package:${pkg.name}`,
      relation: "contains",
      confidence: "EXTRACTED",
    });
  }

  const sortedFiles = [...scan.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const fileSymbols: Record<string, SkelSymbol[]> = {};
  const fileImports: Record<string, SkelImport[]> = {};
  const fileDoc: Record<string, string> = {};

  for (const file of sortedFiles) {
    addFileNode(nodes, edges, file);

    const symbols = extractSymbols(file);
    if (symbols.length > 0) fileSymbols[file.relativePath] = symbols;
    for (const symbol of symbols) {
      if (symbol.visibility !== "public") continue;
      const symbolId = `symbol:${file.relativePath}:${symbol.kind}:${symbol.name}`;
      addNode(nodes, {
        id: symbolId,
        label: symbol.name,
        kind: "symbol",
        sourcePath: `${file.relativePath}:${symbol.line}`,
        language: file.language,
        packageName: file.packageName,
      });
      addEdge(edges, {
        source: `file:${file.relativePath}`,
        target: symbolId,
        relation: "defines",
        confidence: "EXTRACTED",
        sourcePath: `${file.relativePath}:${symbol.line}`,
      });
    }

    const doc = extractFileDoc(file);
    if (doc) fileDoc[file.relativePath] = doc;
  }

  const incoming = new Map<string, number>();
  const packageIncoming = new Map<string, number>();

  for (const file of sortedFiles) {
    const fileImportsList = extractImports(file, sortedFiles, scan.workspace);
    if (fileImportsList.length > 0) fileImports[file.relativePath] = fileImportsList;
    for (const imported of fileImportsList) {
      const target = imported.resolvedRelativePath
        ? `file:${imported.resolvedRelativePath}`
        : `external:${imported.specifier}`;

      if (!imported.resolvedRelativePath) {
        addNode(nodes, {
          id: target,
          label: imported.specifier,
          kind: "external",
        });
      } else {
        const targetFile = sortedFiles.find((candidate) => candidate.relativePath === imported.resolvedRelativePath);
        if (targetFile) {
          imported.targetPackage = targetFile.packageName;
        }
        incoming.set(target, (incoming.get(target) ?? 0) + 1);
        if (imported.targetPackage && imported.targetPackage !== file.packageName) {
          packageIncoming.set(
            imported.targetPackage,
            (packageIncoming.get(imported.targetPackage) ?? 0) + 1,
          );
        }
      }

      addEdge(edges, {
        source: `file:${file.relativePath}`,
        target,
        relation: "imports",
        confidence: imported.resolvedRelativePath ? "EXTRACTED" : "AMBIGUOUS",
        sourcePath: `${file.relativePath}:${imported.line}`,
        crossPackage: Boolean(
          imported.targetPackage && file.packageName && imported.targetPackage !== file.packageName,
        ),
      });
    }
  }

  const symbolIndex = buildSymbolIndex(fileSymbols, scan);
  const packageBins = new Map<string, Record<string, string>>();
  for (const pkg of scan.workspace.packages) {
    if (Object.keys(pkg.binEntries).length > 0) packageBins.set(pkg.name, pkg.binEntries);
  }
  const entryPoints = detectEntryPoints(sortedFiles, packageBins, scan.workspace);
  assignEntryPointPackages(entryPoints, sortedFiles, scan);

  const hotspots = buildHotspots(incoming, packageIncoming, fileSymbols, sortedFiles);
  const svelte = buildSvelteInventory(sortedFiles);

  const flows = buildFlows({
    files: sortedFiles,
    fileImports,
    fileSymbols,
    entryPoints,
    workspace: scan.workspace,
    svelte,
  });

  return {
    metadata: {
      tool: "skelograph",
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      root: scan.root,
    },
    stats: scan.stats,
    workspace: scan.workspace,
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
    symbolIndex,
    entryPoints,
    flows,
    hotspots,
    svelte,
    fileSymbols,
    fileImports,
    fileDoc,
  };
}

function buildSvelteInventory(files: FileRecord[]): SvelteInventory {
  const routeToPage = new Map<string, SveltePage>();
  const ensure = (routePath: string, packageName?: string): SveltePage => {
    const key = `${packageName ?? ""}::${routePath}`;
    let page = routeToPage.get(key);
    if (!page) {
      page = {
        routePath,
        packageName,
        hasActions: false,
        fetchCalls: [],
      };
      routeToPage.set(key, page);
    }
    return page;
  };

  const pageRoute = (rel: string): string => {
    const match = /\/routes\/(.*?)\/(?:\+page\.svelte|\+page\.server\.(?:ts|js)|\+page\.(?:ts|js)|\+layout\.server\.(?:ts|js))$/.exec(`/${rel}`);
    if (!match) return "";
    const path = match[1]
      .replace(/\([^)]+\)/g, "")
      .replace(/\/+/g, "/")
      .replace(/^\/+|\/+$/g, "");
    return path ? `/${path}` : "/";
  };

  for (const file of files) {
    const rel = file.relativePath;
    if (/\+page\.svelte$/.test(rel)) {
      const route = pageRoute(rel);
      if (route) {
        const page = ensure(route, file.packageName);
        page.pageFile = rel;
      }
    } else if (/\+page\.server\.(ts|js)$/.test(rel)) {
      const route = pageRoute(rel);
      if (route) {
        const page = ensure(route, file.packageName);
        page.pageServerFile = rel;
        if (/export\s+const\s+actions\b/.test(file.content)) page.hasActions = true;
      }
    } else if (/\+page\.(ts|js)$/.test(rel)) {
      const route = pageRoute(rel);
      if (route) {
        const page = ensure(route, file.packageName);
        page.pageTsFile = rel;
      }
    } else if (/\+layout\.server\.(ts|js)$/.test(rel)) {
      const route = pageRoute(rel);
      if (route) {
        const page = ensure(route, file.packageName);
        page.layoutServerFile = rel;
      }
    }
  }

  // Attribute fetch calls to pages: a call lives in a file; find the nearest
  // page by walking up the route tree.
  const apiCallers: SvelteInventory["apiCallers"] = {};
  for (const file of files) {
    const calls = extractFetchCalls(file);
    if (calls.length === 0) continue;
    for (const call of calls) {
      const owningPage = findOwningPage(file.relativePath, [...routeToPage.values()]);
      if (owningPage) {
        owningPage.fetchCalls.push({
          url: call.urlPattern,
          method: call.method,
          fromFile: file.relativePath,
          line: call.line,
        });
      }
      const normalized = normalizeApiUrl(call.urlPattern);
      const existing = apiCallers[normalized] ?? [];
      existing.push({
        routePath: owningPage?.routePath ?? "(unknown)",
        fromFile: file.relativePath,
        line: call.line,
        method: call.method,
      });
      apiCallers[normalized] = existing;
    }
  }

  return {
    pages: [...routeToPage.values()].sort((a, b) => a.routePath.localeCompare(b.routePath)),
    apiCallers,
  };
}

function findOwningPage(fromFile: string, pages: SveltePage[]): SveltePage | undefined {
  const bestMatch = pages
    .filter((page) => {
      const files = [page.pageFile, page.pageServerFile, page.pageTsFile, page.layoutServerFile].filter((f): f is string => Boolean(f));
      return files.some((f) => f === fromFile);
    })
    .sort((a, b) => b.routePath.length - a.routePath.length)[0];
  if (bestMatch) return bestMatch;

  // If the caller isn't exactly at a page file, attribute to the closest
  // page whose directory contains this file.
  const normalizedFrom = fromFile.replace(/\\/g, "/");
  const dirMatch = /^(.*?\/routes\/)([^]+)$/.exec(normalizedFrom);
  if (!dirMatch) return undefined;
  const fromDir = dirMatch[2].split("/").slice(0, -1).join("/");
  return pages
    .filter((page) => page.pageFile)
    .filter((page) => {
      const pageDir = page.pageFile!.replace(/\\/g, "/");
      const routesMatch = /^(.*?\/routes\/)([^]+)\/\+page\.svelte$/.exec(`/${pageDir}`);
      if (!routesMatch) return false;
      const pageRouteDir = routesMatch[2];
      return fromDir.startsWith(pageRouteDir);
    })
    .sort((a, b) => b.routePath.length - a.routePath.length)[0];
}

function normalizeApiUrl(url: string): string {
  // Normalize dynamic segments (`/api/users/123`) to stable keys
  // (`/api/users/:id`) so callers share a bucket per endpoint.
  return url.replace(/\/\d+(?=\/|$)/g, "/:id").replace(/\?.*$/, "");
}

function buildSymbolIndex(
  fileSymbols: Record<string, SkelSymbol[]>,
  scan: ScanResult,
): Record<string, string | string[]> {
  const map = new Map<string, string[]>();
  for (const [filePath, symbols] of Object.entries(fileSymbols)) {
    for (const symbol of symbols) {
      if (symbol.visibility !== "public") continue;
      if (symbol.name === "default") continue;
      const key = symbol.name;
      const existing = map.get(key) ?? [];
      existing.push(filePath);
      map.set(key, existing);
    }
  }

  const result: Record<string, string | string[]> = {};
  for (const [name, paths] of map) {
    if (paths.length === 1) {
      result[name] = paths[0];
    } else {
      const namespaced = paths.map((path) => {
        const pkg = packageForFile(path, scan.workspace);
        return pkg?.name ? `${pkg.name}:${path}` : path;
      });
      result[name] = namespaced;
    }
  }
  return result;
}

function assignEntryPointPackages(entries: EntryPoint[], files: FileRecord[], scan: ScanResult): void {
  for (const entry of entries) {
    if (entry.packageName) continue;
    const file = files.find((candidate) => candidate.relativePath === entry.filePath);
    const pkg = file
      ? packageForFile(file.relativePath, scan.workspace)
      : packageForFile(entry.filePath, scan.workspace);
    if (pkg) entry.packageName = pkg.name;
  }
}

function buildHotspots(
  incoming: Map<string, number>,
  packageIncoming: Map<string, number>,
  fileSymbols: Record<string, SkelSymbol[]>,
  files: FileRecord[],
): HotspotInfo {
  const topFiles = [...incoming.entries()]
    .filter(([key]) => key.startsWith("file:"))
    .map(([key, count]) => ({ filePath: key.replace(/^file:/, ""), incoming: count }))
    .sort((a, b) => b.incoming - a.incoming)
    .slice(0, 10);

  const topPackages = [...packageIncoming.entries()]
    .map(([packageName, incoming]) => ({ packageName, incoming }))
    .sort((a, b) => b.incoming - a.incoming)
    .slice(0, 5);

  const apiCounts = new Map<string, number>();
  for (const [filePath, symbols] of Object.entries(fileSymbols)) {
    const file = files.find((candidate) => candidate.relativePath === filePath);
    const pkg = file?.packageName ?? "(root)";
    const publicCount = symbols.filter((s) => s.visibility === "public").length;
    apiCounts.set(pkg, (apiCounts.get(pkg) ?? 0) + publicCount);
  }
  const largestApiSurfaces = [...apiCounts.entries()]
    .map(([packageName, publicSymbols]) => ({ packageName, publicSymbols }))
    .sort((a, b) => b.publicSymbols - a.publicSymbols)
    .slice(0, 5);

  return { topFiles, topPackages, largestApiSurfaces };
}

function addFileNode(
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  file: FileRecord,
): void {
  const fileId = `file:${file.relativePath}`;
  const parentId = file.packageName ? `package:${file.packageName}` : "project:root";

  addNode(nodes, {
    id: fileId,
    label: posix.basename(file.relativePath),
    kind: "file",
    sourcePath: file.relativePath,
    language: file.language,
    sizeBytes: file.sizeBytes,
    lineCount: file.lineCount,
    packageName: file.packageName,
  });
  addEdge(edges, {
    source: parentId,
    target: fileId,
    relation: "contains",
    confidence: "EXTRACTED",
    sourcePath: file.relativePath,
  });
}

function addNode(nodes: Map<string, GraphNode>, node: GraphNode): void {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

function addEdge(edges: Map<string, GraphEdge>, edge: GraphEdge): void {
  edges.set(edgeKey(edge), edge);
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.source}->${edge.target}:${edge.relation}:${edge.sourcePath ?? ""}`;
}
