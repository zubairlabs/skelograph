import type { Skelograph } from "../types.js";

export function renderMap(graph: Skelograph): string {
  return `${JSON.stringify(graph.symbolIndex, null, 2)}\n`;
}
