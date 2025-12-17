<script lang="ts">
  /**
   * JobGraphModal - Full-screen modal for viewing the complete job dependency graph
   * Provides a larger view with zoom/pan controls and detailed job information
   */
  import type { JobGraphNode, WorkflowJobDefinition } from '../../src/types/workflow-types';
  import {
    buildCollapsedJobDependencyGraph,
    GRAPH_CONSTANTS,
    type JobData,
  } from '../utils/graph-utils';
  import JobNode from './JobNode.svelte';
  import MatrixJobGroup from './MatrixJobGroup.svelte';
  import GraphConnector from './GraphConnector.svelte';
  import { fade, scale } from 'svelte/transition';

  // Props
  export let runId: number; // Used by parent for context
  export let runName: string = '';
  // Suppress unused warning - runId is used by parent component for context
  void runId;
  export let jobs: JobData[] = [];
  export let jobDefinitions: WorkflowJobDefinition[] = [];
  export let isRunning = false;
  export let onClose: () => void;
  export let onJobClick: ((node: JobGraphNode) => void) | undefined = undefined;

  // State
  let expandedMatrixGroups = new Set<string>();
  let zoomLevel = 1;
  let hoveredJobId: string | null = null;

  // Constants for matrix layout
  const MATRIX_HEADER_HEIGHT = 44;
  const MATRIX_HINT_HEIGHT = 36;
  const MATRIX_JOB_HEIGHT = 52;
  const MATRIX_PADDING = 24;

  // Build the collapsed graph (with matrix grouping)
  $: graph =
    jobs.length > 0 || jobDefinitions.length > 0
      ? buildCollapsedJobDependencyGraph(jobDefinitions, jobs)
      : null;

  /**
   * Get the height of a node, accounting for matrix expansion
   */
  function getNodeHeight(node: JobGraphNode, expanded: Set<string>): number {
    if (node.isMatrix && node.matrixJobs && node.matrixJobs.length > 0) {
      if (expanded.has(node.id)) {
        return (
          MATRIX_HEADER_HEIGHT + MATRIX_PADDING + node.matrixJobs.length * MATRIX_JOB_HEIGHT - 8
        );
      } else {
        return MATRIX_HEADER_HEIGHT + MATRIX_HINT_HEIGHT;
      }
    }
    return GRAPH_CONSTANTS.NODE_HEIGHT;
  }

  /**
   * Calculate adjusted dimensions for the graph
   * This function recalculates all node positions based on the current expansion state.
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
    if (!nodes || nodes.length === 0) {
      return {
        width: 200,
        height: 100,
        minX: 0,
        minY: 0,
        nodePositions: new Map(),
        nodeHeights: new Map(),
      };
    }

    // Group nodes by level
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

  // Calculate adjusted dimensions reactively
  $: adjustedDimensions = graph
    ? calculateAdjustedDimensions(graph.nodes, expandedMatrixGroups)
    : null;

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
   * Zoom controls
   */
  function zoomIn() {
    zoomLevel = Math.min(zoomLevel + 0.1, 2);
  }

  function zoomOut() {
    zoomLevel = Math.max(zoomLevel - 0.1, 0.3);
  }

  function resetZoom() {
    zoomLevel = 1;
  }

  /**
   * Handle hover on job nodes
   */
  function handleJobHover(nodeId: string | null) {
    hoveredJobId = nodeId;
  }

  /**
   * Handle keyboard events for closing modal
   */
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      onClose();
    }
  }

  /**
   * Handle overlay click to close
   */
  function handleOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div
  class="modal-overlay"
  on:click={handleOverlayClick}
  on:keydown={(e) => e.key === 'Escape' && onClose()}
  role="dialog"
  aria-modal="true"
  aria-labelledby="graph-modal-title"
  tabindex="-1"
  transition:fade={{ duration: 150 }}
>
  <div class="modal-content" transition:scale={{ duration: 150, start: 0.95 }}>
    <div class="modal-header">
      <h2 id="graph-modal-title">
        <span class="codicon codicon-git-merge"></span>
        Job Dependencies
        {#if runName}
          <span class="run-name">- {runName}</span>
        {/if}
      </h2>
      <div class="header-actions">
        <!-- Zoom controls -->
        <div class="zoom-controls">
          <button
            class="toolbar-btn"
            on:click={zoomOut}
            disabled={zoomLevel <= 0.3}
            title="Zoom out"
          >
            <span class="codicon codicon-zoom-out"></span>
          </button>
          <span class="zoom-level">{Math.round(zoomLevel * 100)}%</span>
          <button class="toolbar-btn" on:click={zoomIn} disabled={zoomLevel >= 2} title="Zoom in">
            <span class="codicon codicon-zoom-in"></span>
          </button>
          {#if zoomLevel !== 1}
            <button class="toolbar-btn" on:click={resetZoom} title="Reset zoom">
              <span class="codicon codicon-refresh"></span>
            </button>
          {/if}
        </div>
        {#if isRunning}
          <span class="running-indicator">
            <span class="codicon codicon-sync spinning-icon"></span>
            Running
          </span>
        {/if}
        <button class="close-button" on:click={onClose} title="Close (Esc)">
          <span class="codicon codicon-close"></span>
        </button>
      </div>
    </div>

    <div class="modal-body">
      {#if !graph || graph.nodes.length === 0}
        <div class="no-graph">
          <span class="codicon codicon-info"></span>
          <span>No job dependencies found for this workflow run.</span>
        </div>
      {:else if adjustedDimensions}
        <div class="graph-container">
          <!-- Scrollable wrapper with scaled dimensions -->
          <div
            class="graph-scroll-area"
            style="width: {adjustedDimensions.width * zoomLevel +
              32}px; height: {adjustedDimensions.height * zoomLevel + 32}px;"
          >
            <div
              class="graph-viewport"
              style="transform: scale({zoomLevel}); transform-origin: top left;"
            >
              <div
                class="graph-content"
                style="width: {adjustedDimensions.width}px; height: {adjustedDimensions.height}px;"
              >
                <GraphConnector
                  edges={graph.edges}
                  nodes={graph.nodes}
                  offsetX={adjustedDimensions.minX}
                  offsetY={adjustedDimensions.minY}
                  highlightedJobId={hoveredJobId}
                  nodePositions={adjustedDimensions.nodePositions}
                  nodeHeights={adjustedDimensions.nodeHeights}
                />
                {#each graph.nodes as node (node.id)}
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
                        onClick={onJobClick}
                        on:toggle={() => toggleMatrixExpanded(node.id)}
                      />
                    {:else}
                      <JobNode {node} compact={false} onClick={onJobClick} />
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          </div>
        </div>
      {/if}
    </div>

    <div class="modal-footer">
      <span class="job-count">
        {graph?.totalJobs || 0} job{(graph?.totalJobs || 0) !== 1 ? 's' : ''}
      </span>
      <button class="close-btn" on:click={onClose}>Close</button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 16px;
  }

  .modal-content {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    width: 95vw;
    height: 95vh;
    max-width: 1600px;
    max-height: 95vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }

  .modal-header h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--vscode-foreground);
  }

  .run-name {
    font-weight: 400;
    color: var(--vscode-descriptionForeground);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  /* Zoom controls */
  .zoom-controls {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--vscode-toolbar-hoverBackground);
    border-radius: 4px;
  }

  .toolbar-btn {
    background: transparent;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
  }

  .toolbar-btn:hover:not(:disabled) {
    background: var(--vscode-list-hoverBackground);
  }

  .toolbar-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .zoom-level {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    min-width: 40px;
    text-align: center;
  }

  .running-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--vscode-progressBar-background);
    font-size: 12px;
  }

  .spinning-icon {
    animation: spin 1.5s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .close-button {
    background: transparent;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .close-button:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }

  .modal-body {
    flex: 1;
    overflow: auto;
    padding: 0;
    min-height: 0;
    position: relative;
  }

  .no-graph {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--vscode-descriptionForeground);
    height: 100%;
    min-height: 200px;
  }

  .graph-container {
    position: absolute;
    inset: 0;
    overflow: auto;
    padding: 16px;
    background: var(--vscode-editor-background);
  }

  .graph-scroll-area {
    /* This div has explicit dimensions that account for zoom level */
    /* This ensures the scroll area expands when zoomed in */
    display: inline-block;
    min-width: 100%;
    min-height: 100%;
  }

  .graph-viewport {
    /* Transform is applied here for zoom */
    transform-origin: top left;
  }

  .graph-content {
    position: relative;
    min-height: 100px;
  }

  .node-wrapper {
    position: absolute;
    z-index: 1;
  }

  .node-wrapper.expanded-matrix {
    z-index: 10;
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }

  .job-count {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }

  .close-btn {
    padding: 6px 16px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  }

  .close-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
</style>
