<script lang="ts">
  /**
   * FileContentModal - Modal for selecting content from a file
   * Supports multi-select with configurable delimiters and JSON property extraction
   */
  import { createEventDispatcher } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import type {
    ParsedContentItem,
    ParsedFileContent,
    DelimiterOption,
    JsonExtractionMode,
    FileContentConfig,
  } from '../../src/types/workflow-types';

  // Props
  export let title: string = 'Load Content from File';
  export let filePath: string = '';
  export let parsedContent: ParsedFileContent | null = null;
  export let isLoading: boolean = false;
  export let error: string | null = null;
  export let preSelectedValues: string[] = [];
  export let savedConfig: FileContentConfig | null = null;

  // Internal state
  let items: ParsedContentItem[] = [];
  let delimiter: DelimiterOption = 'comma';
  let customDelimiter: string = '';
  let extractionMode: JsonExtractionMode = 'specific-key';
  let specificKey: string = '';
  let showAdvanced: boolean = false;
  let selectedArrayPath: string = '';
  let lastParsedContentRef: ParsedFileContent | null = null; // Track the parsedContent reference to avoid resetting items

  const dispatch = createEventDispatcher<{
    close: void;
    confirm: { values: string[]; config: FileContentConfig };
    changeExtractionMode: { mode: JsonExtractionMode; key?: string; arrayPath?: string };
    showInfo: { title: string; content: string };
    reloadSavedConfig: void;
  }>();

  /**
   * Dispatches event to parent to reload with the saved configuration
   */
  function handleReloadSavedConfig() {
    if (savedConfig) {
      // Apply saved settings to local state
      if (savedConfig.delimiter) {
        delimiter = savedConfig.delimiter;
      }
      if (savedConfig.customDelimiter) {
        customDelimiter = savedConfig.customDelimiter;
      }
      if (savedConfig.jsonExtractionMode) {
        extractionMode = savedConfig.jsonExtractionMode;
      }
      if (savedConfig.jsonSpecificKey) {
        specificKey = savedConfig.jsonSpecificKey;
      }
      if (savedConfig.jsonArrayPath) {
        selectedArrayPath = savedConfig.jsonArrayPath;
      }
      // Dispatch event to re-parse with saved config
      dispatch('reloadSavedConfig');
    }
  }

  // Update items ONLY when parsedContent reference actually changes (not on every reactivity cycle)
  $: if (parsedContent && parsedContent !== lastParsedContentRef) {
    lastParsedContentRef = parsedContent;
    // Map items and pre-select based on preSelectedValues if provided
    items = parsedContent.items.map((item) => ({
      ...item,
      selected:
        preSelectedValues.length > 0 ? preSelectedValues.includes(item.value) : item.selected,
    }));
    if (parsedContent.suggestedKeys?.length && !specificKey) {
      specificKey = parsedContent.suggestedKeys[0];
    }
    // Set selected array path from parsed content
    if (parsedContent.selectedArrayPath) {
      selectedArrayPath = parsedContent.selectedArrayPath;
    }
  }

  $: selectedCount = items.filter((i) => i.selected).length;
  $: allSelected = items.length > 0 && selectedCount === items.length;
  $: noneSelected = selectedCount === 0;

  $: delimiterLabel = {
    comma: 'Comma (,)',
    pipe: 'Pipe (|)',
    newline: 'New line',
    space: 'Space',
    custom: 'Custom',
  }[delimiter];

  /**
   * Toggle item selection
   */
  function toggleItem(index: number) {
    items[index].selected = !items[index].selected;
    items = items;
  }

  /**
   * Select all items
   */
  function selectAll() {
    items = items.map((i) => ({ ...i, selected: true }));
  }

  /**
   * Unselect all items
   */
  function unselectAll() {
    items = items.map((i) => ({ ...i, selected: false }));
  }

  /**
   * Handle confirm
   */
  function handleConfirm() {
    const selectedValues = items.filter((i) => i.selected).map((i) => i.value);

    const config: FileContentConfig = {
      delimiter,
      customDelimiter: delimiter === 'custom' ? customDelimiter : undefined,
      jsonExtractionMode: parsedContent?.fileType === 'json' ? extractionMode : undefined,
      jsonSpecificKey: extractionMode === 'specific-key' ? specificKey : undefined,
      jsonArrayPath: selectedArrayPath || undefined,
      selectedValues,
    };

    dispatch('confirm', { values: selectedValues, config });
  }

  /**
   * Handle extraction mode change
   */
  function handleExtractionModeChange() {
    dispatch('changeExtractionMode', {
      mode: extractionMode,
      key: extractionMode === 'specific-key' ? specificKey : undefined,
      arrayPath: selectedArrayPath || undefined,
    });
  }

  /**
   * Handle nested array selection change
   */
  function handleArrayPathChange() {
    // When array path changes, reset extraction mode to specific-key
    extractionMode = 'specific-key';
    // Update specificKey to the first suggested key of the new array
    if (parsedContent?.nestedArrays?.[selectedArrayPath]) {
      specificKey = parsedContent.nestedArrays[selectedArrayPath][0] || '';
    }
    dispatch('changeExtractionMode', {
      mode: extractionMode,
      key: specificKey || undefined,
      arrayPath: selectedArrayPath,
    });
  }

  /**
   * Handle close
   */
  function handleClose() {
    lastParsedContentRef = null; // Reset so next open will initialize items properly
    dispatch('close');
  }

  /**
   * Handle backdrop click
   */
  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      handleClose();
    }
  }

  /**
   * Handle keyboard
   */
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      handleClose();
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
  class="modal-backdrop"
  role="dialog"
  aria-modal="true"
  aria-labelledby="modal-title"
  on:click={handleBackdropClick}
  transition:fade={{ duration: 150 }}
>
  <div class="modal-content" transition:scale={{ duration: 150, start: 0.95 }}>
    <div class="modal-header">
      <h3 id="modal-title" class="modal-title">{title}</h3>
      {#if filePath}
        <span class="file-path" title={filePath}>
          <span class="codicon codicon-file"></span>
          {filePath.split('/').pop()}
        </span>
      {/if}
      <div class="modal-header-actions">
        {#if savedConfig}
          <button
            type="button"
            class="reload-config-button"
            title="Reload with saved settings from favorites"
            on:click={handleReloadSavedConfig}
          >
            <span class="codicon codicon-history"></span>
          </button>
        {/if}
        <button
          type="button"
          class="info-button"
          title="Learn more"
          on:click={() =>
            dispatch('showInfo', {
              title: 'Select Content from File',
              content: `<h4>What is this?</h4>
<p>Extract values from files to use as workflow parameters. Great for loading test data, configuration values, or dynamic inputs.</p>

<h4>Supported Formats</h4>
<ul>
  <li><strong>JSON:</strong> Extract array items, object keys, or specific nested values</li>
  <li><strong>YAML:</strong> Same extraction options as JSON</li>
  <li><strong>Text:</strong> Split by lines or custom delimiters</li>
</ul>

<h4>Extraction Modes</h4>
<ul>
  <li><strong>Specific Key:</strong> Extract values from a specific JSON key (e.g., "names" from {"names": [...]})</li>
  <li><strong>All Keys:</strong> List all top-level keys</li>
  <li><strong>All Values:</strong> List all values from the file</li>
</ul>

<h4>Output Delimiter</h4>
<p>Choose how selected values are joined: comma, pipe, newline, space, or custom.</p>`,
            })}
        >
          <span class="codicon codicon-info"></span>
        </button>
        <button type="button" class="close-button" on:click={handleClose} aria-label="Close modal">
          <span class="codicon codicon-close"></span>
        </button>
      </div>
    </div>

    {#if isLoading}
      <div class="modal-body loading">
        <span class="codicon codicon-loading spinning-icon"></span>
        <span>Loading file content...</span>
      </div>
    {:else if error}
      <div class="modal-body error">
        <span class="codicon codicon-error"></span>
        <span>{error}</span>
      </div>
    {:else if parsedContent}
      <div class="modal-body">
        <!-- Nested array selector for JSON objects containing arrays -->
        {#if parsedContent.fileType === 'json' && parsedContent.nestedArrays && Object.keys(parsedContent.nestedArrays).length > 0}
          <div class="extraction-options nested-array-options">
            <label class="option-label" for="array-path">
              <span class="codicon codicon-symbol-array"></span>
              Extract from array:
            </label>
            <select
              id="array-path"
              bind:value={selectedArrayPath}
              on:change={handleArrayPathChange}
            >
              <option value="">-- Select an array --</option>
              {#each Object.entries(parsedContent.nestedArrays) as [arrayName, keys] (arrayName)}
                <option value={arrayName}>{arrayName} ({keys.length} properties)</option>
              {/each}
            </select>
            {#if selectedArrayPath && parsedContent.nestedArrays[selectedArrayPath]}
              <label class="option-label" for="nested-key">Property:</label>
              <select
                id="nested-key"
                bind:value={specificKey}
                on:change={handleExtractionModeChange}
              >
                {#each parsedContent.nestedArrays[selectedArrayPath] as key (key)}
                  <option value={key}>{key}</option>
                {/each}
              </select>
            {/if}
          </div>
        {/if}

        <!-- Extraction options for JSON files with arrays (not nested) -->
        {#if parsedContent.fileType === 'json' && parsedContent.suggestedKeys?.length && (!parsedContent.nestedArrays || Object.keys(parsedContent.nestedArrays).length === 0 || parsedContent.selectedArrayPath)}
          <div class="extraction-options">
            <label class="option-label" for="extraction-mode">Extract:</label>
            <select
              id="extraction-mode"
              bind:value={extractionMode}
              on:change={handleExtractionModeChange}
            >
              <option value="specific-key">Specific property</option>
              <option value="full">Full objects</option>
              <option value="property-names">Property names</option>
            </select>
            {#if extractionMode === 'specific-key'}
              <select bind:value={specificKey} on:change={handleExtractionModeChange}>
                {#each parsedContent.suggestedKeys as key (key)}
                  <option value={key}>{key}</option>
                {/each}
              </select>
            {/if}
          </div>
        {/if}

        <!-- Selection controls -->
        <div class="selection-controls">
          <button
            type="button"
            class="control-btn"
            on:click={selectAll}
            disabled={allSelected}
            title="Select all items in the list"
          >
            <span class="codicon codicon-check-all"></span>
            Select All
          </button>
          <button
            type="button"
            class="control-btn"
            on:click={unselectAll}
            disabled={noneSelected}
            title="Unselect all items in the list"
          >
            <span class="codicon codicon-close-all"></span>
            Unselect All
          </button>
          <span class="selection-count">{selectedCount} of {items.length} selected</span>
        </div>

        <!-- Items list -->
        <div class="items-list">
          {#each items as item, index (item.value)}
            <label class="item-row" class:selected={item.selected}>
              <input
                type="checkbox"
                checked={item.selected}
                on:click|stopPropagation={() => toggleItem(index)}
              />
              <span class="item-display" title={item.value}>{item.display}</span>
              <span class="item-source">{item.source}</span>
            </label>
          {/each}
        </div>

        <!-- Delimiter options -->
        <div class="delimiter-options">
          <button
            type="button"
            class="toggle-advanced"
            on:click={() => (showAdvanced = !showAdvanced)}
          >
            <span class="codicon codicon-{showAdvanced ? 'chevron-down' : 'chevron-right'}"></span>
            Join with: {delimiterLabel}
          </button>

          {#if showAdvanced}
            <div class="delimiter-choices">
              <label>
                <input type="radio" bind:group={delimiter} value="comma" />
                Comma (,)
              </label>
              <label>
                <input type="radio" bind:group={delimiter} value="pipe" />
                Pipe (|)
              </label>
              <label>
                <input type="radio" bind:group={delimiter} value="newline" />
                New line
              </label>
              <label>
                <input type="radio" bind:group={delimiter} value="space" />
                Space
              </label>
              <label>
                <input type="radio" bind:group={delimiter} value="custom" />
                Custom:
                <input
                  type="text"
                  bind:value={customDelimiter}
                  placeholder="e.g. ;"
                  class="custom-delimiter-input"
                  disabled={delimiter !== 'custom'}
                />
              </label>
            </div>
          {/if}
        </div>
      </div>
    {:else}
      <div class="modal-body empty">
        <span class="codicon codicon-file"></span>
        <span>No content to display</span>
      </div>
    {/if}

    <div class="modal-footer">
      <button
        type="button"
        class="btn secondary"
        on:click={handleClose}
        title="Cancel and close without saving"
      >
        Cancel
      </button>
      <button
        type="button"
        class="btn primary"
        on:click={handleConfirm}
        disabled={noneSelected || isLoading}
        title="Load selected items into the input field"
      >
        Load Selected ({selectedCount})
      </button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal-content {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 6px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    width: 90%;
    max-width: 600px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
  }

  .modal-header {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-widget-border);
    gap: 12px;
  }

  .modal-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    flex: 1;
  }

  .file-path {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .modal-header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .reload-config-button {
    background: transparent;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    padding: 4px;
    opacity: 0.8;
    border-radius: 4px;
  }

  .reload-config-button:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }

  .info-button {
    background: transparent;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: help;
    padding: 4px;
    opacity: 0.7;
    border-radius: 4px;
  }

  .info-button:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }

  .close-button {
    background: transparent;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 4px;
    opacity: 0.7;
    border-radius: 4px;
  }

  .close-button:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }

  .modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  .modal-body.loading,
  .modal-body.error,
  .modal-body.empty {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 150px;
    color: var(--vscode-descriptionForeground);
  }

  .modal-body.error {
    color: var(--vscode-errorForeground);
  }

  .extraction-options {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    padding: 8px;
    background: var(--vscode-input-background);
    border-radius: 4px;
    flex-wrap: wrap;
  }

  .nested-array-options {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-input-border);
  }

  .nested-array-options .option-label {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .option-label {
    font-size: 12px;
    color: var(--vscode-foreground);
    white-space: nowrap;
  }

  .extraction-options select {
    padding: 4px 8px;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    color: var(--vscode-dropdown-foreground);
    font-size: 12px;
    border-radius: 2px;
  }

  .selection-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .control-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    font-size: 11px;
    cursor: pointer;
    border-radius: 2px;
  }

  .control-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .control-btn:not(:disabled):hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .selection-count {
    margin-left: auto;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .items-list {
    max-height: 250px;
    overflow-y: auto;
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    margin-bottom: 12px;
  }

  .item-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    cursor: pointer;
    border-bottom: 1px solid var(--vscode-widget-border);
  }

  .item-row:last-child {
    border-bottom: none;
  }

  .item-row:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .item-row.selected {
    background: var(--vscode-list-activeSelectionBackground);
  }

  .item-display {
    flex: 1;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-source {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
  }

  .delimiter-options {
    border-top: 1px solid var(--vscode-widget-border);
    padding-top: 12px;
  }

  .toggle-advanced {
    display: flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: none;
    color: var(--vscode-foreground);
    font-size: 12px;
    cursor: pointer;
    padding: 4px 0;
  }

  .toggle-advanced:hover {
    color: var(--vscode-textLink-foreground);
  }

  .delimiter-choices {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 8px;
    padding: 8px;
    background: var(--vscode-input-background);
    border-radius: 4px;
  }

  .delimiter-choices label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    cursor: pointer;
  }

  .custom-delimiter-input {
    width: 50px;
    padding: 2px 6px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    color: var(--vscode-input-foreground);
    font-size: 12px;
    border-radius: 2px;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--vscode-widget-border);
  }

  .btn {
    padding: 6px 14px;
    font-size: 12px;
    border-radius: 2px;
    cursor: pointer;
    border: none;
  }

  .btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .btn.primary:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }

  .btn.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }

  .btn.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .spinning-icon {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
