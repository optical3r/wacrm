/**
 * Funnel for the runs page: the flow's nodes in walking order (breadth
 * first from the entry node, so the first steps come first), each with
 * how many runs reached it. Pure, unit-tested.
 */
import { outgoingEdges, type NodeInput } from "./validate";

export interface FunnelStep {
  node_key: string;
  node_type: string;
  runs: number;
}

export function buildFunnel(
  nodes: NodeInput[],
  entryKey: string | null,
  reached: Record<string, number>,
): FunnelStep[] {
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = entryKey && byKey.has(entryKey) ? [entryKey] : [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    order.push(key);
    for (const next of outgoingEdges(byKey.get(key)!)) {
      if (byKey.has(next) && !seen.has(next)) queue.push(next);
    }
  }
  // Nodes nobody can reach from the entry still show, at the end.
  for (const n of nodes) if (!seen.has(n.node_key)) order.push(n.node_key);

  return order.map((key) => ({
    node_key: key,
    node_type: byKey.get(key)!.node_type,
    runs: Number(reached[key] ?? 0),
  }));
}
