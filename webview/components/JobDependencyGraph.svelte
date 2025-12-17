<script lang="ts">
  /**
   * JobDependencyGraph - Main inline graph component for visualizing job dependencies
   * GitHub-style horizontal layout with absolute positioning and SVG connectors
   * Uses collapsed graph (matrix jobs grouped) for cleaner display
   */
  import type {
    JobDependencyGraph as GraphType,
    JobGraphNode,
    GraphDisplayMode,
    WorkflowJobDefinition,
  } from '../../src/types/workflow-types';
  import {
    buildCollapsedJobDependencyGraph,
    calculateDisplayMode,
    getFocusedNodes,
    GRAPH_CONSTANTS,
    type JobData,
  } from '../utils/graph-utils';
  import JobNode from './JobNode.svelte';
  import MatrixJobGroup from './MatrixJobGroup.svelte';
  import GraphConnector from './GraphConnector.svelte';
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher<{
    showSteps: JobGraphNode;
    openModal: void;
  }>();

  // Props
  export let runId: number;
  export let jobs: JobData[] = [];
  export let jobDefinitions: WorkflowJobDefinition[] = [];
  export let isRunning = false;
  export let onJobClick: ((node: JobGraphNode) => void) | undefined = undefined;
  export let onGraphClick: (() => void) | undefined = undefined;

  // State
  let containerWidth = 600;
  let containerEl: HTMLDivElement;
  let resizeObserver: ResizeObserver | null = null;
  let expandedMatrixGroups = new Set<string>();
  let hoveredJobId: string | null = null;
  let zoomLevel = 1;

  // Constants for layout
  const MATRIX_HEADER_HEIGHT = 44; // Header height for collapsed matrix group
  const MATRIX_HINT_HEIGHT = 36; // "Show all X jobs" hint height
  const MATRIX_JOB_HEIGHT = 52; // Height per job when expanded (44px + 8px gap)
  const MATRIX_PADDING = 24; // Top/bottom padding when expanded

  /**
   * Toggle matrix group expansion
   */
  function toggleMatrixExpanded(nodeId: string) {
    if (expandedMatrixGroups.has(nodeId)) {
      expandedMatrixGroups.delete(nodeId);
    } else {
      expandedMatrixGroups.add(nodeId);
    }
    expandedMatrixGroups = expandedMatrixGroups;
  }

  /**
   * Calculate the height of a node, accounting for matrix expansion
   */
  function getNodeHeight(node: JobGraphNode, expanded: Set<string>): number {
    if (node.isMatrix && node.matrixJobs && node.matrixJobs.length > 0) {
      if (expanded.has(node.id)) {
        // Expanded: header + padding + jobs
        return (
          MATRIX_HEADER_HEIGHT + MATRIX_PADDING + node.matrixJobs.length * MATRIX_JOB_HEIGHT - 8
        );
      } else {
        // Collapsed: header + hint
        return MATRIX_HEADER_HEIGHT + MATRIX_HINT_HEIGHT;
      }
    }
    return GRAPH_CONSTANTS.NODE_HEIGHT;
  }

  /**
   * Calculate adjusted positions accounting for matrix heights
   * This function recalculates all node positions based on the current expansion state.
   * Nodes at the same level are stacked vertically, with expanded matrix groups
   * taking more vertical space and pushing down subsequent nodes.
   */
  function calculateAdjustedDimensions(
    nodes: JobGraphNode[],
    expanded: Set<string>
  ): {
    width: number;
    height: number;
    minX: number;
    minY: number;
    nodePositions: Map<string, { x: number; y: number }>;
    nodeHeights: Map<string, number>;
  } {
    if (nodes.length === 0) {
      return {
        width: 200,
        height: 100,
        minX: 0,
        minY: 0,
        nodePositions: new Map(),
        nodeHeights: new Map(),
      };
    }

    // Group nodes by level (stage)
    const levelMap = new Map<number, JobGraphNode[]>();
    for (const node of nodes) {
      const level = node.level || 0;
      if (!levelMap.has(level)) {
        levelMap.set(level, []);
      }
      levelMap.get(level)!.push(node);
    }

    // Sort nodes within each level by their original Y position for consistent ordering
    for (const levelNodes of levelMap.values()) {
      levelNodes.sort((a, b) => (a.position?.y || 0) - (b.position?.y || 0));
    }

    const sortedLevels = Array.from(levelMap.keys()).sort((a, b) => a - b);
    const nodePositions = new Map<string, { x: number; y: number }>();
    const nodeHeights = new Map<string, number>();

    const { NODE_WIDTH, STAGE_GAP, PADDING, NODE_GAP } = GRAPH_CONSTANTS;

    let maxX = 0;
    let maxY = 0;

    // Calculate positions for each level - nodes stack vertically with dynamic heights
    for (const level of sortedLevels) {
      const levelNodes = levelMap.get(level)!;
      const stageX = PADDING + level * (NODE_WIDTH + STAGE_GAP);
      let currentY = PADDING;

      for (const node of levelNodes) {
        // Calculate this node's height based on expansion state
        const height = getNodeHeight(node, expanded);
        nodeHeights.set(node.id, height);

        // Set position for this node
        nodePositions.set(node.id, { x: stageX, y: currentY });

        // Move Y position down for next node (accounting for this node's full height)
        currentY += height + NODE_GAP;
        maxY = Math.max(maxY, currentY);
      }

      maxX = Math.max(maxX, stageX + NODE_WIDTH);
    }

    return {
      width: maxX + PADDING,
      height: maxY + PADDING,
      minX: 0,
      minY: 0,
      nodePositions,
      nodeHeights,
    };
  }

  // Build the collapsed graph (matrix jobs grouped) from runtime jobs or job definitions
  $: graph =
    jobs.length > 0 || jobDefinitions.length > 0
      ? buildCollapsedJobDependencyGraph(jobDefinitions, jobs)
      : null;

  // Calculate display mode based on container width
  $: displayMode =
    graph && graph.totalJobs > 0 ? calculateDisplayMode(containerWidth, graph.totalJobs) : 'button';

  // Get nodes to display based on mode
  $: displayNodes = getDisplayNodes(graph, displayMode);

  // Calculate adjusted dimensions accounting for matrix heights
  // Re-calculate when expandedMatrixGroups changes
  $: adjustedDimensions = calculateAdjustedDimensions(displayNodes, expandedMatrixGroups);

  /**
   * Get nodes to display based on current display mode
   */
  function getDisplayNodes(g: GraphType | null, mode: GraphDisplayMode): JobGraphNode[] {
    if (!g || g.nodes.length === 0) {
      return [];
    }

    switch (mode) {
      case 'full':
        return g.nodes;
      case 'focused':
        return getFocusedNodes(g);
      case 'minimal': {
        const activeNode = g.nodes.find((n) => n.isActive);
        if (activeNode) {
          return [activeNode];
        }
        const incompleteNode = g.nodes.find((n) => n.status !== 'completed');
        return incompleteNode ? [incompleteNode] : g.nodes.slice(0, 1);
      }
      case 'button':
      default:
        return [];
    }
  }

  /**
   * Handle click on graph area to open full modal
   */
  function handleGraphClick() {
    if (onGraphClick) {
      onGraphClick();
    }
  }

  /**
   * Open graph in modal
   */
  function openModal() {
    dispatch('openModal');
  }

  /**
   * Handle job click to show steps modal
   * Dispatches event to parent to render modal at higher DOM level (avoids z-index issues)
   */
  function handleJobNodeClick(node: JobGraphNode) {
    if (node.steps && node.steps.length > 0) {
      dispatch('showSteps', node);
    } else if (onJobClick) {
      onJobClick(node);
    }
  }

  /**
   * Zoom controls
   */
  function zoomIn() {
    zoomLevel = Math.min(zoomLevel + 0.1, 1.5);
  }

  function zoomOut() {
    zoomLevel = Math.max(zoomLevel - 0.1, 0.5);
  }

  function resetZoom() {
    zoomLevel = 1;
  }

  /**
   * Handle hover on job nodes for connection highlighting
   */
  function handleJobHover(nodeId: string | null) {
    hoveredJobId = nodeId;
  }

  /**
   * Update container dimensions on resize
   */
  function updateDimensions() {
    if (containerEl) {
      containerWidth = containerEl.offsetWidth;
    }
  }

  onMount(() => {
    if (containerEl && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        updateDimensions();
      });
      resizeObserver.observe(containerEl);
      setTimeout(updateDimensions, 0);
    }
  });

  onDestroy(() => {
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
  });
</script>

<div class="dependency-graph-container" bind:this={containerEl}>
  {#if !graph || graph.nodes.length === 0}
    <!-- No graph data available -->
    <div class="no-graph-data">
      <span class="codicon codicon-info"></span>
      <span>No jobs found</span>
    </div>
  {:else if displayMode === 'button'}
    <!-- Button fallback mode for constrained spaces -->
    <button class="graph-button" on:click={handleGraphClick} title="View job dependency graph">
      <span class="codicon codicon-type-hierarchy"></span>
      <span>View Graph ({graph.totalJobs} jobs)</span>
    </button>
  {:else if displayNodes.length > 0 && adjustedDimensions}
    <!-- Graph controls toolbar -->
    <div class="graph-toolbar">
      <div class="zoom-controls">
        <button class="toolbar-btn" on:click={zoomOut} disabled={zoomLevel <= 0.5} title="Zoom out">
          <span class="codicon codicon-zoom-out"></span>
        </button>
        <span class="zoom-level">{Math.round(zoomLevel * 100)}%</span>
        <button class="toolbar-btn" on:click={zoomIn} disabled={zoomLevel >= 1.5} title="Zoom in">
          <span class="codicon codicon-zoom-in"></span>
        </button>
        {#if zoomLevel !== 1}
          <button class="toolbar-btn" on:click={resetZoom} title="Reset zoom">
            <span class="codicon codicon-refresh"></span>
          </button>
        {/if}
      </div>
      <button class="toolbar-btn open-modal-btn" on:click={openModal} title="Open in full screen">
        <span class="codicon codicon-screen-full"></span>
        <span>Full Screen</span>
      </button>
    </div>

    <!-- Graph visualization - GitHub-style horizontal layout with absolute positioning -->
    <div class="graph-wrapper">
      <div
        class="graph-viewport"
        style="transform: scale({zoomLevel}); transform-origin: top left;"
      >
        <div
          class="graph-content absolute-layout"
          style="width: {adjustedDimensions.width}px; height: {adjustedDimensions.height}px;"
        >
          <!-- SVG Connectors layer (behind nodes) -->
          <GraphConnector
            edges={graph?.edges || []}
            nodes={displayNodes}
            offsetX={adjustedDimensions.minX}
            offsetY={adjustedDimensions.minY}
            highlightedJobId={hoveredJobId}
            nodePositions={adjustedDimensions.nodePositions}
            nodeHeights={adjustedDimensions.nodeHeights}
          />

          <!-- Job nodes with absolute positioning -->
          {#each displayNodes as node (node.id)}
            {@const pos = adjustedDimensions.nodePositions.get(node.id) || node.position}
            <div
              class="node-wrapper"
              class:expanded-matrix={node.isMatrix && expandedMatrixGroups.has(node.id)}
              style="left: {pos.x - adjustedDimensions.minX}px; top: {pos.y -
                adjustedDimensions.minY}px;"
              on:mouseenter={() => handleJobHover(node.id)}
              on:mouseleave={() => handleJobHover(null)}
              role="presentation"
            >
              {#if node.isMatrix && node.matrixJobs && node.matrixJobs.length > 0}
                <MatrixJobGroup
                  {node}
                  expanded={expandedMatrixGroups.has(node.id)}
                  matrixJobs={node.matrixJobs}
                  onClick={handleJobNodeClick}
                  on:toggle={() => toggleMatrixExpanded(node.id)}
                />
              {:else}
                <JobNode {node} compact={displayMode === 'minimal'} onClick={handleJobNodeClick} />
              {/if}
            </div>
          {/each}
        </div>
      </div>
    </div>

    <!-- Graph summary -->
    <div class="graph-summary">
      <span>{graph.totalJobs} job{graph.totalJobs !== 1 ? 's' : ''}</span>
      {#if graph.activeJobIds.length > 0}
        <span class="active-count">• {graph.activeJobIds.length} running</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .dependency-graph-container {
    width: 100%;
    padding: 8px 0;
  }

  .no-graph-data {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    padding: 8px;
  }

  .graph-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .graph-button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .graph-button:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  /* Toolbar with zoom controls and modal button */
  .graph-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
  }

  .zoom-controls {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .zoom-level {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    min-width: 40px;
    text-align: center;
  }

  .toolbar-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 4px 8px;
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid transparent;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .toolbar-btn:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground);
  }

  .toolbar-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .open-modal-btn {
    color: var(--vscode-textLink-foreground);
  }

  .graph-wrapper {
    position: relative;
    overflow: hidden;
  }

  .graph-viewport {
    position: relative;
    overflow: auto;
    padding: 10px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 0 0 6px 6px;
    max-height: 500px;
  }

  /* Absolute positioning layout for SVG connectors */
  .graph-content.absolute-layout {
    position: relative;
    min-height: 60px;
  }

  /* Node wrapper with absolute positioning */
  .node-wrapper {
    position: absolute;
    z-index: 1;
  }

  /* Expanded matrix groups get higher z-index */
  .node-wrapper.expanded-matrix {
    z-index: 10;
  }

  .graph-summary {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .active-count {
    color: var(--vscode-progressBar-background);
  }
</style>
