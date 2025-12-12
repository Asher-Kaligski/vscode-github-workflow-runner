<script lang="ts">
  /**
   * GraphConnector - SVG connector lines between job nodes
   * GitHub-style simple horizontal lines for horizontal layout
   */
  import type { JobGraphNode, JobGraphEdge } from '../../src/types/workflow-types';
  import { GRAPH_CONSTANTS } from '../utils/graph-utils';

  export let edges: JobGraphEdge[] = [];
  export let nodes: JobGraphNode[] = [];
  export let offsetX = 0;
  export let offsetY = 0;
  export let highlightedJobId: string | null = null;
  // Optional adjusted positions for dynamic layout (e.g., expanded matrix groups)
  export let nodePositions: Map<string, { x: number; y: number }> | null = null;
  // Optional node heights for centering connectors on variable-height nodes
  export let nodeHeights: Map<string, number> | null = null;

  const { NODE_WIDTH, NODE_HEIGHT } = GRAPH_CONSTANTS;

  interface EdgePath {
    edge: JobGraphEdge;
    d: string;
    isHighlighted: boolean;
  }

  /**
   * Get node by ID from the nodes array
   */
  function getNode(id: string): JobGraphNode | undefined {
    return nodes.find((n) => n.id === id);
  }

  /**
   * Get position for a node, using adjusted positions if available
   */
  function getNodePosition(node: JobGraphNode): { x: number; y: number } {
    if (nodePositions && nodePositions.has(node.id)) {
      return nodePositions.get(node.id)!;
    }
    return node.position;
  }

  /**
   * Get height for a node, using adjusted heights if available
   */
  function getNodeHeight(node: JobGraphNode): number {
    if (nodeHeights && nodeHeights.has(node.id)) {
      return nodeHeights.get(node.id)!;
    }
    return NODE_HEIGHT;
  }

  /**
   * Calculate edge paths for horizontal layout (GitHub-style)
   * Uses simple horizontal lines with slight curves for non-aligned nodes
   */
  function calculateEdgePaths(
    edgeList: JobGraphEdge[],
    nodeList: JobGraphNode[],
    ox: number,
    oy: number,
    highlightId: string | null,
    positions: Map<string, { x: number; y: number }> | null,
    heights: Map<string, number> | null
  ): EdgePath[] {
    if (!edgeList || edgeList.length === 0) return [];

    return edgeList
      .map((edge) => {
        const fromNode = getNode(edge.from);
        const toNode = getNode(edge.to);

        if (!fromNode || !toNode) return null;

        // Get positions (use adjusted if available)
        const fromPos = getNodePosition(fromNode);
        const toPos = getNodePosition(toNode);

        // Get heights for vertical centering (use adjusted if available)
        const fromHeight = getNodeHeight(fromNode);
        const toHeight = getNodeHeight(toNode);

        // HORIZONTAL layout: connect right edge of source to left edge of target
        const fromX = fromPos.x + NODE_WIDTH - ox;
        const toX = toPos.x - ox;
        const fromY = fromPos.y + fromHeight / 2 - oy;
        const toY = toPos.y + toHeight / 2 - oy;

        let d: string;

        if (Math.abs(fromY - toY) < 5) {
          // Same Y level - simple horizontal line (GitHub-style: M x1 y H x2)
          d = `M ${fromX} ${fromY} H ${toX}`;
        } else {
          // Different Y levels - smooth curve
          const midX = (fromX + toX) / 2;
          d = `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`;
        }

        // Determine if this edge should be highlighted
        const isHighlighted =
          highlightId !== null &&
          (edge.from === highlightId ||
            edge.to === highlightId ||
            fromNode.dependencies.includes(highlightId) ||
            toNode.dependents.includes(highlightId));

        return { edge, d, isHighlighted };
      })
      .filter((p): p is EdgePath => p !== null);
  }

  $: edgePaths = calculateEdgePaths(
    edges,
    nodes,
    offsetX,
    offsetY,
    highlightedJobId,
    nodePositions,
    nodeHeights
  );
</script>

{#if edgePaths.length > 0}
  <!-- Base connector layer (gray lines) -->
  <svg class="graph-connectors base-layer" xmlns="http://www.w3.org/2000/svg">
    {#each edgePaths as { edge, d } (edge.from + '-' + edge.to)}
      <path class="connector-line" {d} />
    {/each}
  </svg>

  <!-- Highlight connector layer (blue lines, shown on hover) -->
  <svg class="graph-connectors highlight-layer" xmlns="http://www.w3.org/2000/svg">
    {#each edgePaths.filter((p) => p.isHighlighted) as { edge, d } (edge.from + '-' + edge.to + '-hl')}
      <path class="connector-line highlighted" {d} />
    {/each}
  </svg>
{/if}

<style>
  .graph-connectors {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: visible;
  }

  .graph-connectors.highlight-layer {
    z-index: 1;
  }

  .connector-line {
    fill: none;
    stroke: var(--vscode-panel-border, #3c3c3c);
    stroke-width: 2;
    stroke-linecap: round;
    transition:
      stroke 0.2s ease,
      stroke-width 0.2s ease;
  }

  .connector-line.highlighted {
    stroke: var(--vscode-progressBar-background, #0e70c0);
    stroke-width: 3;
  }
</style>
