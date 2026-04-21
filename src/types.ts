export type Confidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export type NodeKind =
  | "project"
  | "directory"
  | "file"
  | "symbol"
  | "external";

export type EdgeRelation =
  | "contains"
  | "defines"
  | "imports"
  | "references";

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  sourcePath?: string;
  language?: string;
  sizeBytes?: number;
  lineCount?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: EdgeRelation;
  confidence: Confidence;
  sourcePath?: string;
}

export interface FileRecord {
  absolutePath: string;
  relativePath: string;
  extension: string;
  language: string;
  sizeBytes: number;
  lineCount: number;
  content: string;
}

export interface ScanStats {
  totalFiles: number;
  totalBytes: number;
  totalLines: number;
  skippedIgnored: number;
  skippedSensitive: number;
  skippedLarge: number;
  languages: Record<string, number>;
}

export interface ScanResult {
  root: string;
  files: FileRecord[];
  stats: ScanStats;
}

export interface Skelograph {
  metadata: {
    tool: "skelograph";
    schemaVersion: 1;
    generatedAt: string;
    root: string;
  };
  stats: ScanStats;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface BuildOptions {
  root: string;
  outDir?: string;
  maxFileBytes?: number;
}
