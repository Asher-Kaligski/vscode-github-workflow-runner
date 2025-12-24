<script lang="ts">
  /**
   * JobStepsModal - Modal to display job steps with status icons and duration
   * Shows step details when a user clicks on a job node in the dependency graph
   */
  import type { JobGraphNode, JobNodeStep } from '../../src/types/workflow-types';
  import { getStatusIcon, getStatusColor, formatDuration } from '../utils/graph-utils';
  import { fade, scale } from 'svelte/transition';

  export let job: JobGraphNode;
  export let runId: number | undefined = undefined;
  export let workflowId: number | undefined = undefined;
  export let workflowName: string | undefined = undefined;
  export let onClose: () => void;
  export let onViewLogs: (() => void) | undefined = undefined;
  export let onViewRawLogs: (() => void) | undefined = undefined;
  export let onViewSummary: (() => void) | undefined = undefined;
  export let onViewStepLogs: ((stepNumber: number, stepName: string) => void) | undefined =
    undefined;
  export let onCompareStepLogs:
    | ((
        stepNumber: number,
        stepName: string,
        jobId: number,
        jobName: string,
        runId: number,
        workflowId: number,
        workflowName: string
      ) => void)
    | undefined = undefined;
  export let compareSourceStep: {
    stepNumber: number;
    stepName: string;
    jobId: number;
    jobName: string;
    runId: number;
    workflowId: number;
    workflowName: string;
  } | null = null;
  export let loadingStepLogs: Set<number> = new Set();
  export let loadingStepComparison: boolean = false;
  export let loadingLogs: boolean = false;
  export let loadingRawLogs: boolean = false;
  export let loadingSummary: boolean = false;

  $: steps = job.steps || [];
  $: hasSteps = steps.length > 0;
  $: completedSteps = steps.filter(
    (s) => s.status === 'completed' && s.conclusion === 'success'
  ).length;
  $: failedSteps = steps.filter((s) => s.conclusion === 'failure').length;

  function getStepStatusIcon(step: JobNodeStep): string {
    if (step.status === 'completed') {
      return getStatusIcon('completed', step.conclusion || null);
    }
    if (step.status === 'in_progress') {
      return getStatusIcon('in_progress', null);
    }
    return getStatusIcon('queued', null);
  }

  function getStepStatusColor(step: JobNodeStep): string {
    if (step.status === 'completed') {
      return getStatusColor('completed', step.conclusion || null);
    }
    if (step.status === 'in_progress') {
      return getStatusColor('in_progress', null);
    }
    return getStatusColor('queued', null);
  }

  /**
   * Get formatted duration for a step
   * Shows '<1s' for completed steps with 0 or missing duration
   */
  function getStepDuration(step: JobNodeStep): string {
    if (step.duration && step.duration > 0) {
      return formatDuration(step.duration);
    }
    // Show '<1s' for completed steps with no duration (sub-second execution)
    if (step.status === 'completed') {
      return '<1s';
    }
    return '';
  }

  function handleOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  /**
   * Check if step logs can be viewed (step must have started)
   */
  function canViewStepLogs(step: JobNodeStep): boolean {
    return step.status === 'completed' || step.status === 'in_progress';
  }

  /**
   * Handle click on step logs icon
   */
  function handleViewStepLogs(step: JobNodeStep) {
    if (onViewStepLogs && canViewStepLogs(step)) {
      onViewStepLogs(step.number, step.name);
    }
  }

  /**
   * Handle click on compare step logs button
   */
  function handleCompareStepLogs(step: JobNodeStep) {
    if (
      onCompareStepLogs &&
      canViewStepLogs(step) &&
      runId !== undefined &&
      job.jobId !== undefined &&
      workflowId !== undefined &&
      workflowName !== undefined
    ) {
      onCompareStepLogs(
        step.number,
        step.name,
        job.jobId,
        job.name,
        runId,
        workflowId,
        workflowName
      );
    }
  }

  /**
   * Check if this step is the comparison source
   */
  function isCompareSource(step: JobNodeStep): boolean {
    return (
      compareSourceStep !== null &&
      compareSourceStep.stepNumber === step.number &&
      compareSourceStep.jobId === job.jobId
    );
  }

  /**
   * Check if a step can be compared with the current comparison source
   * Steps can only be compared if they have same step name, job name, and workflow
   */
  function canCompareWithStep(step: JobNodeStep): boolean {
    if (!compareSourceStep || workflowId === undefined) return false;
    return (
      compareSourceStep.stepName === step.name &&
      compareSourceStep.jobName === job.name &&
      compareSourceStep.workflowId === workflowId
    );
  }
</script>

<svelte:window on:keydown={(e) => e.key === 'Escape' && onClose()} />

<div
  class="modal-overlay"
  on:click={handleOverlayClick}
  on:keydown={(e) => e.key === 'Escape' && onClose()}
  role="dialog"
  aria-modal="true"
  aria-labelledby="steps-modal-title"
  tabindex="-1"
  transition:fade={{ duration: 150 }}
>
  <div class="modal-content" transition:scale={{ duration: 150, start: 0.95 }}>
    <div class="modal-header">
      <div class="header-title">
        <span class="job-status-icon" style="color: {getStatusColor(job.status, job.conclusion)}">
          <i class="codicon codicon-{getStatusIcon(job.status, job.conclusion)}"></i>
        </span>
        <h3 id="steps-modal-title">{job.name}</h3>
      </div>
      <button class="close-button" on:click={onClose} title="Close (Esc)" type="button">
        <span class="codicon codicon-close"></span>
      </button>
    </div>

    <div class="modal-body">
      {#if hasSteps}
        <div class="steps-summary">
          <span class="summary-item">
            <span class="codicon codicon-list-ordered"></span>
            {steps.length} step{steps.length !== 1 ? 's' : ''}
          </span>
          {#if completedSteps > 0}
            <span class="summary-item success">
              <span class="codicon codicon-pass"></span>{completedSteps} passed
            </span>
          {/if}
          {#if failedSteps > 0}
            <span class="summary-item failure">
              <span class="codicon codicon-error"></span>{failedSteps} failed
            </span>
          {/if}
          {#if job.duration}
            <span class="summary-item">
              <span class="codicon codicon-clock"></span>{formatDuration(job.duration)}
            </span>
          {/if}
        </div>
        <div class="steps-list">
          {#each steps as step, displayIndex (step.number)}
            <div class="step-item" class:failed={step.conclusion === 'failure'}>
              <span class="step-number">{displayIndex + 1}</span>
              <span class="step-icon" style="color: {getStepStatusColor(step)}">
                <i
                  class="codicon codicon-{getStepStatusIcon(step)}"
                  class:spinning={step.status === 'in_progress'}
                ></i>
              </span>
              <span class="step-name" title={step.name}>{step.name}</span>
              {#if getStepDuration(step)}<span class="step-duration">{getStepDuration(step)}</span
                >{/if}
              {#if onViewStepLogs && canViewStepLogs(step)}
                <button
                  class="step-logs-button"
                  on:click|stopPropagation={() => handleViewStepLogs(step)}
                  disabled={loadingStepLogs.has(step.number)}
                  title="View logs for this step"
                  type="button"
                >
                  {#if loadingStepLogs.has(step.number)}
                    <span class="codicon codicon-sync spinning"></span>
                  {:else}
                    <span class="codicon codicon-file-text"></span>
                  {/if}
                </button>
              {/if}
              <!-- DISABLED: Step comparison - temporarily disabled in v1.2.0
              {#if onCompareStepLogs && canViewStepLogs(step) && job.jobId !== undefined}
                {#if isCompareSource(step)}
                  <button
                    class="step-logs-button compare-btn compare-source cancel-compare"
                    on:click|stopPropagation={() => handleCompareStepLogs(step)}
                    disabled={loadingStepComparison}
                    title="Cancel step comparison"
                    type="button"
                  >
                    {#if loadingStepComparison}
                      <span class="codicon codicon-sync spinning"></span>
                    {:else}
                      <span class="codicon codicon-close"></span>
                      <span class="cancel-text">Cancel</span>
                    {/if}
                  </button>
                {:else if compareSourceStep && canCompareWithStep(step)}
                  <button
                    class="step-logs-button compare-btn"
                    on:click|stopPropagation={() => handleCompareStepLogs(step)}
                    disabled={loadingStepComparison}
                    title={`Compare with "${compareSourceStep.stepName}"`}
                    type="button"
                  >
                    <span class="codicon codicon-diff"></span>
                  </button>
                {:else if compareSourceStep && !canCompareWithStep(step)}
                  <button
                    class="step-logs-button compare-btn disabled-compare"
                    disabled
                    title={`Cannot compare: step must be "${compareSourceStep.stepName}" in job "${compareSourceStep.jobName}" from workflow "${compareSourceStep.workflowName}"`}
                    type="button"
                  >
                    <span class="codicon codicon-diff"></span>
                  </button>
                {:else}
                  <button
                    class="step-logs-button compare-btn"
                    on:click|stopPropagation={() => handleCompareStepLogs(step)}
                    title="Select this step for comparison"
                    type="button"
                  >
                    <span class="codicon codicon-diff"></span>
                  </button>
                {/if}
              {/if}
              -->
            </div>
          {/each}
        </div>
      {:else}
        <div class="no-steps">
          <span class="codicon codicon-info"></span>
          <span>No step information available for this job.</span>
        </div>
      {/if}
    </div>

    <div class="modal-footer">
      {#if onViewSummary}
        <button
          class="secondary-button"
          on:click={onViewSummary}
          disabled={loadingSummary}
          type="button"
          title="View GitHub job summary"
        >
          {#if loadingSummary}
            <span class="codicon codicon-sync spinning"></span>
            Loading...
          {:else}
            <span class="codicon codicon-github"></span>
            Summary
          {/if}
        </button>
      {/if}
      {#if onViewLogs}
        <button class="secondary-button" on:click={onViewLogs} disabled={loadingLogs} type="button">
          {#if loadingLogs}
            <span class="codicon codicon-sync spinning"></span>
            Loading...
          {:else}
            <span class="codicon codicon-output"></span>
            View Logs
          {/if}
        </button>
      {/if}
      {#if onViewRawLogs}
        <button
          class="secondary-button"
          on:click={onViewRawLogs}
          disabled={loadingRawLogs}
          type="button"
        >
          {#if loadingRawLogs}
            <span class="codicon codicon-sync spinning"></span>
            Loading...
          {:else}
            <span class="codicon codicon-file-code"></span>
            View Raw Logs
          {/if}
        </button>
      {/if}
      <button class="primary-button" on:click={onClose} type="button">Close</button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 99999;
    padding: 20px;
  }
  .modal-content {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    max-width: 600px;
    width: 100%;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .header-title {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .header-title h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .job-status-icon {
    font-size: 18px;
    flex-shrink: 0;
  }
  .close-button {
    background: transparent;
    border: none;
    color: var(--vscode-foreground);
    font-size: 16px;
    cursor: pointer;
    padding: 4px;
    opacity: 0.7;
    transition: opacity 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .close-button:hover {
    opacity: 1;
  }
  .modal-body {
    padding: 16px 20px;
    overflow-y: auto;
    flex: 1;
  }
  .steps-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
    margin-bottom: 16px;
  }
  .summary-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }
  .summary-item.success {
    color: var(--vscode-testing-iconPassed, #3fb950);
  }
  .summary-item.failure {
    color: var(--vscode-testing-iconFailed, #f85149);
  }
  .steps-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .step-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: var(--vscode-list-hoverBackground);
    border-radius: 4px;
    font-size: 13px;
  }
  .step-item.failed {
    background: color-mix(in srgb, var(--vscode-testing-iconFailed, #f85149) 10%, transparent);
  }
  .step-number {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    min-width: 20px;
    text-align: right;
  }
  .step-icon {
    font-size: 14px;
    flex-shrink: 0;
  }
  .step-icon .spinning {
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
  .step-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .step-duration {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    flex-shrink: 0;
  }
  .step-logs-button {
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
    opacity: 0.7;
    transition:
      opacity 0.2s,
      background-color 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .step-logs-button:hover:not(:disabled) {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }
  .step-logs-button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .step-logs-button .spinning {
    animation: spin 1.5s linear infinite;
  }
  .step-logs-button.compare-btn {
    color: var(--vscode-textLink-foreground);
  }
  .step-logs-button.compare-btn:hover:not(:disabled) {
    color: var(--vscode-textLink-activeForeground);
  }
  .step-logs-button.compare-btn.compare-source {
    color: var(--vscode-charts-green);
    opacity: 1;
  }
  .step-logs-button.compare-btn.compare-source.cancel-compare {
    color: var(--vscode-errorForeground);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    min-width: auto;
    width: auto;
    background: var(--vscode-inputValidation-errorBackground);
    border-radius: 3px;
  }
  .step-logs-button.compare-btn.compare-source.cancel-compare:hover {
    background: var(--vscode-inputValidation-errorBorder);
  }
  .step-logs-button.compare-btn.compare-source .cancel-text {
    font-size: 11px;
    font-weight: 500;
  }
  .step-logs-button.compare-btn.disabled-compare {
    opacity: 0.35;
    cursor: not-allowed;
    color: var(--vscode-disabledForeground);
  }
  .step-logs-button.compare-btn.disabled-compare:hover {
    background: transparent;
    opacity: 0.35;
  }
  .no-steps {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 24px;
    color: var(--vscode-descriptionForeground);
    justify-content: center;
  }
  .modal-footer {
    padding: 16px 20px;
    border-top: 1px solid var(--vscode-panel-border);
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .primary-button,
  .secondary-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: none;
    padding: 8px 16px;
    border-radius: 2px;
    cursor: pointer;
    font-size: 13px;
    transition: background-color 0.2s;
  }
  .primary-button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .primary-button:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .secondary-button {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .secondary-button:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  .secondary-button:disabled {
    opacity: 0.7;
    cursor: default;
  }
  .secondary-button .spinning {
    animation: spin 1.5s linear infinite;
  }
</style>
