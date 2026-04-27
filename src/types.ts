export type Confidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export type NodeKind =
  | "project"
  | "package"
  | "directory"
  | "file"
  | "symbol"
  | "external";

export type EdgeRelation =
  | "contains"
  | "defines"
  | "imports"
  | "references";

export type Visibility = "public" | "private";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "const"
  | "variable"
  | "type"
  | "interface"
  | "enum"
  | "object"
  | "extension"
  | "default";

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  sourcePath?: string;
  language?: string;
  sizeBytes?: number;
  lineCount?: number;
  packageName?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: EdgeRelation;
  confidence: Confidence;
  sourcePath?: string;
  crossPackage?: boolean;
}

export interface FileRecord {
  absolutePath: string;
  relativePath: string;
  extension: string;
  language: string;
  sizeBytes: number;
  lineCount: number;
  content: string;
  packageName?: string;
}

export interface ScanStats {
  totalFiles: number;
  totalBytes: number;
  totalLines: number;
  skippedIgnored: number;
  skippedSensitive: number;
  skippedLarge: number;
  skippedGenerated: number;
  languages: Record<string, number>;
}

export interface ScanResult {
  root: string;
  files: FileRecord[];
  stats: ScanStats;
  workspace: WorkspaceInfo;
}

export interface WorkspaceInfo {
  kind: "single" | "npm" | "pnpm" | "yarn" | "turborepo-hinted" | "cargo";
  rootPackageName?: string;
  rootDescription?: string;
  packages: PackageInfo[];
}

export interface PackageInfo {
  name: string;
  relativePath: string;
  description?: string;
  dependencies: string[];
  devDependencies: string[];
  isRoot: boolean;
  binEntries: Record<string, string>;
  scripts: Record<string, string>;
  framework?: FrameworkKind;
}

export type FrameworkKind =
  | "sveltekit"
  | "next"
  | "express"
  | "fastify"
  | "nestjs"
  | "axum"
  | "actix-web"
  | "rocket"
  | "tonic"
  | "unknown";

export type EntryPointKind =
  | "sveltekit-server"
  | "sveltekit-page-server"
  | "sveltekit-page"
  | "sveltekit-form-action"
  | "sveltekit-hooks"
  | "next-route"
  | "next-middleware"
  | "express-app"
  | "fastify-app"
  | "websocket"
  | "queue-worker"
  | "cli-bin"
  | "script"
  | "rust-bin"
  | "rust-main"
  | "axum-router"
  | "axum-route";

export interface EntryPoint {
  id: string;
  kind: EntryPointKind;
  filePath: string;
  packageName?: string;
  label: string;
  httpMethod?: string;
  routePath?: string;
  linkedFlow?: string;
}

export interface SkelSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  visibility: Visibility;
  doc?: string;
  isDefault?: boolean;
}

export interface SkelImport {
  specifier: string;
  line: number;
  resolvedRelativePath?: string;
  targetPackage?: string;
}

export interface FlowStep {
  filePath: string;
  symbol?: string;
  description?: string;
  packageName?: string;
}

export interface FlowDecisionPoint {
  description: string;
  line?: number;
  filePath?: string;
}

export interface FlowFailurePath {
  description: string;
  filePath?: string;
}

export interface FlowSpec {
  name: string;
  title: string;
  entry: EntryPoint;
  trigger: string;
  preconditions: string[];
  steps: FlowStep[];
  decisionPoints: FlowDecisionPoint[];
  failurePaths: FlowFailurePath[];
  related: string[];
}

export interface HotspotInfo {
  topFiles: Array<{ filePath: string; incoming: number }>;
  topPackages: Array<{ packageName: string; incoming: number }>;
  largestApiSurfaces: Array<{ packageName: string; publicSymbols: number }>;
}

export interface SveltePage {
  routePath: string;
  pageFile?: string;
  pageServerFile?: string;
  pageTsFile?: string;
  layoutServerFile?: string;
  packageName?: string;
  hasActions: boolean;
  fetchCalls: Array<{ url: string; method?: string; fromFile: string; line: number }>;
}

export interface SvelteInventory {
  pages: SveltePage[];
  apiCallers: Record<string, Array<{ routePath: string; fromFile: string; line: number; method?: string }>>;
}

export interface Skelograph {
  metadata: {
    tool: "skelograph";
    schemaVersion: 2;
    generatedAt: string;
    root: string;
  };
  stats: ScanStats;
  workspace: WorkspaceInfo;
  nodes: GraphNode[];
  edges: GraphEdge[];
  symbolIndex: Record<string, string | string[]>;
  entryPoints: EntryPoint[];
  flows: FlowSpec[];
  hotspots: HotspotInfo;
  svelte: SvelteInventory;
  fileSymbols: Record<string, SkelSymbol[]>;
  fileImports: Record<string, SkelImport[]>;
  fileDoc: Record<string, string>;
}

export interface BuildOptions {
  root: string;
  outDir?: string;
  maxFileBytes?: number;
}
