import { posix } from "node:path";
import { extractImports, extractSymbols } from "./extractors.js";
import type { FileRecord, GraphEdge, GraphNode, ScanResult, Skelograph } from "./types.js";

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

  const sortedFiles = [...scan.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  for (const file of sortedFiles) {
    addDirectoryChain(nodes, edges, projectId, file.relativePath);
    addFileNode(nodes, edges, file);

    for (const symbol of extractSymbols(file)) {
      const symbolId = `symbol:${file.relativePath}:${symbol.kind}:${symbol.name}`;
      addNode(nodes, {
        id: symbolId,
        label: symbol.name,
        kind: "symbol",
        sourcePath: `${file.relativePath}:${symbol.line}`,
        language: file.language,
      });
      addEdge(edges, {
        source: `file:${file.relativePath}`,
        target: symbolId,
        relation: "defines",
        confidence: "EXTRACTED",
        sourcePath: `${file.relativePath}:${symbol.line}`,
      });
    }
  }

  for (const file of sortedFiles) {
    for (const imported of extractImports(file, sortedFiles)) {
      const target = imported.resolvedRelativePath
        ? `file:${imported.resolvedRelativePath}`
        : `external:${imported.specifier}`;

      if (!imported.resolvedRelativePath) {
        addNode(nodes, {
          id: target,
          label: imported.specifier,
          kind: "external",
        });
      }

      addEdge(edges, {
        source: `file:${file.relativePath}`,
        target,
        relation: "imports",
        confidence: imported.resolvedRelativePath ? "EXTRACTED" : "AMBIGUOUS",
        sourcePath: `${file.relativePath}:${imported.line}`,
      });
    }
  }

  return {
    metadata: {
      tool: "skelograph",
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      root: scan.root,
    },
    stats: scan.stats,
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
  };
}

function addDirectoryChain(
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  projectId: string,
  relativeFilePath: string,
): void {
  const parts = relativeFilePath.split("/").slice(0, -1);
  let parentId = projectId;
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const dirId = `dir:${current}`;
    addNode(nodes, {
      id: dirId,
      label: part,
      kind: "directory",
      sourcePath: current,
    });
    addEdge(edges, {
      source: parentId,
      target: dirId,
      relation: "contains",
      confidence: "EXTRACTED",
      sourcePath: current,
    });
    parentId = dirId;
  }
}

function addFileNode(
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  file: FileRecord,
): void {
  const fileId = `file:${file.relativePath}`;
  const parentDir = posix.dirname(file.relativePath);
  const parentId = parentDir === "." ? "project:root" : `dir:${parentDir}`;

  addNode(nodes, {
    id: fileId,
    label: posix.basename(file.relativePath),
    kind: "file",
    sourcePath: file.relativePath,
    language: file.language,
    sizeBytes: file.sizeBytes,
    lineCount: file.lineCount,
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

