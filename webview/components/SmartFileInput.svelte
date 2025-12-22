<script lang="ts">
  /**
   * SmartFileInput - Unified smart input component for workflow parameters
   * Supports three modes: regular text, file path selection, and load content from file
   */
  import { createEventDispatcher } from 'svelte';
  import { fade, slide } from 'svelte/transition';
  import type { SmartInputMode, FileFavorite, RecentFile } from '../../src/types/workflow-types';

  // Props
  export let inputName: string;
  export let value: string = '';
  export let placeholder: string = '';
  export let disabled: boolean = false;
  export let required: boolean = false;
  export let recentFiles: RecentFile[] = [];
  export let favorites: FileFavorite[] = [];
  export let isLoading: boolean = false;
  export let error: string | null = null;
  export let warning: string | null = null;
  export let suggestions: string[] = [];
  export let forceMode: SmartInputMode | null = null; // Parent can force mode change

  // Internal state
  let mode: SmartInputMode = 'text';

  // React to forceMode changes from parent
  $: if (forceMode !== null && forceMode !== mode) {
    mode = forceMode;
  }
  let showDropdown: boolean = false;
  let showModeSelector: boolean = false;
  let pathInput: string = '';
  let showPathSuggestions: boolean = false;
  let selectedSuggestionIndex: number = -1;
  let inputElement: HTMLInputElement;
  let dropdownElement: HTMLDivElement;
  let contentLoaded: boolean = false;
  let loadedFilePath: string = '';

  const dispatch = createEventDispatcher<{
    change: { value: string };
    loadContent: { path: string };
    selectPath: { path: string };
    browseFile: { mode: 'path' | 'content' };
    addFavorite: {
      path: string;
      nickname?: string;
      config?: import('../../src/types/workflow-types').FileContentConfig;
    };
    removeFavorite: { id: string };
    updateFavorite: { id: string; nickname?: string };
    openFile: { path: string };
    requestSuggestions: { partialPath: string };
    trackRecent: { path: string; mode?: 'path' | 'content' };
    showPreview: { value: string };
    reloadFromFile: {
      path: string;
      config: import('../../src/types/workflow-types').FileContentConfig;
    };
    showInfo: { title: string; content: string };
  }>();

  // Track if browse button should pulse (attention animation on mode switch)
  let browseButtonPulse: boolean = false;

  // Track if user has ever used mode selector (for first-time discovery pulse)
  let hasUsedModeSelector: boolean = false;

  // Track value-loaded animation state for visual feedback
  let valueLoadedAnimation: boolean = false;

  /**
   * Trigger the value-loaded animation when content is populated
   * Called externally via binding or internally when selecting files
   */
  export function triggerValueLoadedAnimation() {
    valueLoadedAnimation = true;
    setTimeout(() => {
      valueLoadedAnimation = false;
    }, 300);
  }

  // Constants for display limits
  const MAX_VISIBLE_RECENT_FILES = 5;

  // Combine recent and favorites for display
  $: allFiles = [
    ...favorites.map((f) => ({ ...f, isFavorite: true as const, type: 'favorite' as const })),
    ...recentFiles
      .filter((r) => !favorites.some((f) => f.relativePath === r.relativePath))
      .map((r) => ({ ...r, isFavorite: false as const, type: 'recent' as const })),
  ];

  // Filter recent files by current mode for showing history icon
  $: filteredRecentForMode = recentFiles.filter((r) => {
    // Exclude files already in favorites
    if (favorites.some((f) => f.relativePath === r.relativePath)) return false;
    // Only show files that have lastMode matching current mode
    if (!r.lastMode) return false;
    return mode === 'content' ? r.lastMode === 'content' : r.lastMode === 'path';
  });

  // Check if there are files to show in dropdown (favorites OR matching recent files)
  $: hasFiles = favorites.length > 0 || filteredRecentForMode.length > 0;

  /**
   * Handle value change
   */
  function handleInput(event: Event) {
    const target = event.target as HTMLInputElement;
    value = target.value;
    dispatch('change', { value });
  }

  /**
   * Handle path input for autocomplete
   */
  function handlePathInput(event: Event) {
    const target = event.target as HTMLInputElement;
    pathInput = target.value;
    if (pathInput.length > 1) {
      dispatch('requestSuggestions', { partialPath: pathInput });
      showPathSuggestions = true;
    } else {
      showPathSuggestions = false;
    }
  }

  /**
   * Handle path suggestion selection - auto-switches to text mode after selection
   */
  function selectPathSuggestion(suggestion: string) {
    pathInput = suggestion;
    showPathSuggestions = false;
    value = suggestion;
    dispatch('change', { value });
    dispatch('trackRecent', { path: suggestion });
    // Trigger value-loaded animation for path autocomplete
    triggerValueLoadedAnimation();
    // Auto-switch back to text mode
    mode = 'text';
  }

  /**
   * Handle keyboard navigation in suggestions
   */
  function handlePathKeydown(event: KeyboardEvent) {
    if (!showPathSuggestions || suggestions.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectedSuggestionIndex = Math.min(selectedSuggestionIndex + 1, suggestions.length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, 0);
    } else if (event.key === 'Enter' && selectedSuggestionIndex >= 0) {
      event.preventDefault();
      selectPathSuggestion(suggestions[selectedSuggestionIndex]);
    } else if (event.key === 'Escape') {
      showPathSuggestions = false;
    }
  }

  /**
   * Toggle mode selector dropdown
   */
  function toggleModeSelector() {
    showModeSelector = !showModeSelector;
    showDropdown = false;
    hasUsedModeSelector = true; // Stop discovery pulse after first interaction
  }

  /**
   * Set input mode - triggers attention animation for browse button
   */
  function setMode(newMode: SmartInputMode) {
    mode = newMode;
    showModeSelector = false;

    if (newMode === 'path') {
      pathInput = value;
    }

    // Trigger pulse animation when switching to path or content mode
    if (newMode === 'path' || newMode === 'content') {
      browseButtonPulse = true;
      setTimeout(() => {
        browseButtonPulse = false;
      }, 1500);
    }
  }

  /**
   * Toggle file dropdown
   */
  function toggleDropdown() {
    showDropdown = !showDropdown;
    showModeSelector = false;
  }

  /**
   * Select a file from recent/favorites - auto-switches to text mode after selection
   */
  function selectFile(file: RecentFile | FileFavorite, loadContent: boolean) {
    const path = file.relativePath;
    showDropdown = false;

    if (loadContent) {
      dispatch('loadContent', { path });
      loadedFilePath = path;
      // Note: Content mode will switch to text after content is loaded (handled by parent)
      // Animation will be triggered by parent after content is loaded
    } else {
      value = path;
      dispatch('change', { value });
      dispatch('trackRecent', { path, mode: 'path' });
      // Trigger value-loaded animation for path mode
      triggerValueLoadedAnimation();
      // Auto-switch back to text mode
      mode = 'text';
    }
  }

  /**
   * Show preview/edit modal for the current value
   */
  function showPreviewModal() {
    if (value) {
      dispatch('showPreview', { value });
    }
  }

  /**
   * Handle click outside to close dropdowns
   */
  function handleClickOutside(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const container = target.closest('.smart-input-container');
    if (!container) {
      showDropdown = false;
      showModeSelector = false;
      showPathSuggestions = false;
    }
  }

  /**
   * Handle Escape key to close dropdowns
   */
  function handleEscapeKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (showDropdown || showModeSelector || showPathSuggestions) {
        event.stopPropagation();
        showDropdown = false;
        showModeSelector = false;
        showPathSuggestions = false;
      }
    }
  }
</script>

<svelte:window on:click={handleClickOutside} on:keydown={handleEscapeKey} />

<div class="smart-input-container">
  <!-- Unified input with inline controls -->
  <div class="input-wrapper" class:has-error={error}>
    <!-- Mode prefix icon with chevron indicator -->
    <button
      type="button"
      class="inline-mode-button"
      class:discovery-pulse={!hasUsedModeSelector}
      on:click={toggleModeSelector}
      {disabled}
      title={mode === 'text'
        ? 'Text (direct input) · Click to switch modes'
        : mode === 'path'
          ? 'Path (file autocomplete) · Click to switch modes'
          : 'Content (extract from JSON/YAML) · Click to switch modes'}
    >
      {#if mode === 'text'}
        <span class="codicon codicon-symbol-string"></span>
      {:else if mode === 'path'}
        <span class="codicon codicon-file-symlink-file"></span>
      {:else}
        <span class="codicon codicon-file-code"></span>
      {/if}
      <span class="mode-chevron codicon codicon-chevron-down"></span>
    </button>

    <!-- Mode dropdown (positioned from inline button) -->
    {#if showModeSelector}
      <div class="mode-dropdown" transition:fade={{ duration: 100 }}>
        <button
          type="button"
          class="mode-option"
          class:active={mode === 'text'}
          on:click={() => setMode('text')}
        >
          <span class="codicon codicon-symbol-string"></span>
          <div class="mode-option-text">
            <span class="mode-option-label">Text</span>
            <span class="mode-desc">Enter text directly</span>
          </div>
        </button>
        <button
          type="button"
          class="mode-option"
          class:active={mode === 'path'}
          on:click={() => setMode('path')}
        >
          <span class="codicon codicon-file-symlink-file"></span>
          <div class="mode-option-text">
            <span class="mode-option-label">Path</span>
            <span class="mode-desc">Insert file path as value</span>
          </div>
        </button>
        <button
          type="button"
          class="mode-option"
          class:active={mode === 'content'}
          on:click={() => setMode('content')}
        >
          <span class="codicon codicon-file-code"></span>
          <div class="mode-option-text">
            <span class="mode-option-label">Content</span>
            <span class="mode-desc">Extract values from file</span>
          </div>
        </button>
        {#if value}
          <div class="mode-divider"></div>
          <button
            type="button"
            class="mode-option clear-option"
            on:click={() => {
              value = '';
              pathInput = '';
              contentLoaded = false;
              loadedFilePath = '';
              setMode('text');
              dispatch('change', { value: '' });
            }}
          >
            <span class="codicon codicon-clear-all"></span>
            <div class="mode-option-text">
              <span class="mode-option-label">Clear</span>
              <span class="mode-desc">Reset value and mode</span>
            </div>
          </button>
        {/if}
      </div>
    {/if}

    <!-- Main input area -->
    <div class="input-area" class:value-loaded={valueLoadedAnimation}>
      {#if mode === 'text'}
        <input
          type="text"
          bind:this={inputElement}
          bind:value
          on:input={handleInput}
          {placeholder}
          {disabled}
          class="inline-input"
        />
      {:else if mode === 'path'}
        <input
          type="text"
          bind:value={pathInput}
          on:input={handlePathInput}
          on:keydown={handlePathKeydown}
          placeholder="Type to search files..."
          {disabled}
          class="inline-input"
        />
        {#if showPathSuggestions && suggestions.length > 0}
          <div class="suggestions-dropdown" transition:fade={{ duration: 100 }}>
            {#each suggestions as suggestion, i (suggestion)}
              <button
                type="button"
                class="suggestion-item"
                class:selected={i === selectedSuggestionIndex}
                on:click={() => selectPathSuggestion(suggestion)}
              >
                <span class="codicon codicon-file"></span>
                <span class="suggestion-path">{suggestion}</span>
              </button>
            {/each}
          </div>
        {/if}
      {:else}
        <!-- Content mode -->
        {#if contentLoaded}
          <div class="loaded-indicator">
            <span class="loaded-path" title={loadedFilePath}>{loadedFilePath}</span>
            <button
              type="button"
              class="inline-action-btn"
              on:click={() => {
                contentLoaded = false;
              }}
              title="Edit value"
            >
              <span class="codicon codicon-edit"></span>
            </button>
            <button
              type="button"
              class="inline-action-btn"
              on:click={() => {
                contentLoaded = false;
                value = '';
                dispatch('change', { value: '' });
              }}
              title="Clear"
            >
              <span class="codicon codicon-close"></span>
            </button>
          </div>
        {:else}
          <input
            type="text"
            bind:value
            on:input={handleInput}
            placeholder="Select file to load content..."
            {disabled}
            class="inline-input"
          />
        {/if}
      {/if}
    </div>

    <!-- Right-side action buttons -->
    <div class="inline-actions">
      <!-- Preview/Edit button - shown when there's a value -->
      {#if value}
        <button
          type="button"
          class="inline-action-btn preview-btn"
          on:click={showPreviewModal}
          {disabled}
          title="Preview & Edit: View and edit multi-value inputs. Supports comma, pipe, newline, and other delimiters. Select/unselect items and save to favorites."
        >
          <span class="codicon codicon-eye"></span>
        </button>
      {/if}

      {#if (mode === 'path' || mode === 'content') && hasFiles}
        <button
          type="button"
          class="inline-action-btn"
          on:click={toggleDropdown}
          {disabled}
          title="Recent & favorite files"
        >
          <span class="codicon codicon-history"></span>
        </button>
      {/if}

      {#if mode === 'path' || mode === 'content'}
        <button
          type="button"
          class="inline-action-btn browse-btn"
          class:pulse={browseButtonPulse}
          on:click={() => dispatch('browseFile', { mode: mode === 'content' ? 'content' : 'path' })}
          disabled={disabled || isLoading}
          title={mode === 'content' ? 'Browse and load file content' : 'Browse for file'}
        >
          {#if isLoading}
            <span class="codicon codicon-loading spinning-icon"></span>
          {:else}
            <span class="codicon codicon-folder-opened"></span>
          {/if}
        </button>
      {/if}
    </div>
  </div>

  <!-- Files dropdown -->
  {#if showDropdown && hasFiles}
    <div class="files-dropdown" bind:this={dropdownElement} transition:slide={{ duration: 150 }}>
      <div class="dropdown-header">
        <span class="dropdown-title">
          {mode === 'content' ? 'Select content from file:' : 'Insert path:'}
        </span>
        <div class="dropdown-header-actions">
          <button
            type="button"
            class="dropdown-info-btn"
            title="Learn more"
            on:click={() =>
              dispatch('showInfo', {
                title: mode === 'content' ? 'Load Content from File' : 'Insert File Path',
                content:
                  mode === 'content'
                    ? `<h4>What is this?</h4>
<p>Load values from a file directly into the input field. This is useful for workflow parameters that accept file content.</p>

<h4>Supported Formats</h4>
<ul>
  <li><strong>JSON:</strong> Extract specific keys or array items</li>
  <li><strong>YAML:</strong> Parse and extract values</li>
  <li><strong>Text:</strong> Load entire file content</li>
</ul>

<h4>How to use</h4>
<ol>
  <li>Select a file from favorites or recent files</li>
  <li>Choose what to extract (specific key, array items, etc.)</li>
  <li>The extracted value will be inserted into the input</li>
</ol>`
                    : `<h4>What is this?</h4>
<p>Insert a file path into the input field. The relative path from your workspace root will be used.</p>

<h4>How to use</h4>
<ol>
  <li>Select a file from favorites or recent files</li>
  <li>Or click "Browse..." to select a file</li>
  <li>The file's relative path will be inserted</li>
</ol>

<h4>Tips</h4>
<ul>
  <li>Star files you use frequently to add them to favorites</li>
  <li>Recent files are filtered by mode (path vs content)</li>
</ul>`,
              })}
          >
            <span class="codicon codicon-info"></span>
          </button>
          <button
            type="button"
            class="dropdown-close-btn"
            on:click={() => (showDropdown = false)}
            title="Close"
          >
            <span class="codicon codicon-close"></span>
          </button>
        </div>
      </div>

      {#if favorites.length > 0}
        <div class="dropdown-section">
          <span class="section-label">⭐ Favorites</span>
          {#each favorites as fav (fav.id)}
            {@const fileName = fav.relativePath.split('/').pop() || fav.relativePath}
            {@const fileNameWithoutExt = fileName.startsWith('.')
              ? fileName
              : fileName.replace(/\.[^/.]+$/, '') || fileName}
            <div class="file-item">
              <button
                type="button"
                class="file-select-btn"
                on:click={() => selectFile(fav, mode === 'content')}
                title={fav.relativePath}
              >
                <span class="codicon codicon-star-full favorite-icon"></span>
                <span class="file-name">{fav.nickname || fileNameWithoutExt}</span>
                {#if fav.nickname || fileName !== fileNameWithoutExt}
                  <span class="file-path-hint">{fileName}</span>
                {/if}
              </button>

              {#if mode === 'content' && fav.config}
                <button
                  type="button"
                  class="file-action-btn reload-btn"
                  on:click|stopPropagation={() => {
                    if (fav.config) {
                      dispatch('reloadFromFile', {
                        path: fav.relativePath,
                        config: fav.config,
                      });
                    }
                  }}
                  title="Reload with saved settings: {fav.config.jsonSpecificKey
                    ? `Extract "${fav.config.jsonSpecificKey}" from ${fav.config.jsonArrayPath || 'root'}`
                    : 'Load file content'}{fav.config.selectedValues?.length
                    ? ` (${fav.config.selectedValues.length} items pre-selected)`
                    : ''}"
                >
                  <span class="codicon codicon-history"></span>
                </button>
              {/if}
              <button
                type="button"
                class="file-action-btn"
                on:click|stopPropagation={() => dispatch('openFile', { path: fav.relativePath })}
                title="Open in editor"
              >
                <span class="codicon codicon-go-to-file"></span>
              </button>
              <button
                type="button"
                class="file-action-btn remove-fav-btn"
                on:click|stopPropagation={() => dispatch('removeFavorite', { id: fav.id })}
                title="Remove from favorites"
              >
                <span class="codicon codicon-close"></span>
              </button>
            </div>
          {/each}
        </div>
      {/if}

      <!-- Recent files section - uses filteredRecentForMode reactive variable -->
      {#if filteredRecentForMode.length > 0}
        <div class="dropdown-section">
          <span class="section-label">🕐 Recent ({mode === 'content' ? 'content' : 'path'})</span>
          {#each filteredRecentForMode.slice(0, MAX_VISIBLE_RECENT_FILES) as recent (recent.relativePath)}
            <div class="file-item">
              <button
                type="button"
                class="file-select-btn"
                on:click={() => selectFile(recent, mode === 'content')}
                title={recent.relativePath}
              >
                <span
                  class="codicon {recent.lastMode === 'content'
                    ? 'codicon-symbol-string'
                    : 'codicon-file-symlink-file'}"
                  title={recent.lastMode === 'content' ? 'Used for content' : 'Used for path'}
                ></span>
                <span class="file-name">{recent.relativePath.split('/').pop()}</span>
                <span class="file-path-hint">{recent.relativePath}</span>
              </button>
              <!-- Show reload button in content mode for recent files with saved config -->
              {#if mode === 'content' && recent.lastConfig}
                <button
                  type="button"
                  class="file-action-btn reload-btn"
                  on:click|stopPropagation={() => {
                    if (recent.lastConfig) {
                      dispatch('reloadFromFile', {
                        path: recent.relativePath,
                        config: recent.lastConfig,
                      });
                    }
                  }}
                  title="Reload with saved settings: {recent.lastConfig.jsonSpecificKey
                    ? `Extract "${recent.lastConfig.jsonSpecificKey}" from ${recent.lastConfig.jsonArrayPath || 'root'}`
                    : 'Load file content'}{recent.lastConfig.selectedValues?.length
                    ? ` (${recent.lastConfig.selectedValues.length} items pre-selected)`
                    : ''}"
                >
                  <span class="codicon codicon-history"></span>
                </button>
              {/if}
              <button
                type="button"
                class="file-action-btn"
                on:click|stopPropagation={() =>
                  dispatch('addFavorite', { path: recent.relativePath, config: recent.lastConfig })}
                title="Add to favorites{recent.lastConfig ? ' (with saved settings)' : ''}"
              >
                <span class="codicon codicon-star-empty"></span>
              </button>
              <button
                type="button"
                class="file-action-btn"
                on:click|stopPropagation={() => dispatch('openFile', { path: recent.relativePath })}
                title="Open in editor"
              >
                <span class="codicon codicon-go-to-file"></span>
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Error/Warning messages -->
  {#if error}
    <div class="message error" transition:fade>
      <span class="codicon codicon-error"></span>
      {error}
    </div>
  {/if}
  {#if warning}
    <div class="message warning" transition:fade>
      <span class="codicon codicon-warning"></span>
      {warning}
    </div>
  {/if}
</div>

<style>
  .smart-input-container {
    display: flex;
    flex-direction: column;
    gap: 4px;
    position: relative;
  }

  /* Unified input wrapper with inline controls */
  .input-wrapper {
    display: flex;
    align-items: stretch;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    overflow: visible;
    position: relative;
    min-height: 28px;
  }

  .input-wrapper:focus-within {
    border-color: var(--vscode-focusBorder);
  }

  .input-wrapper.has-error {
    border-color: var(--vscode-inputValidation-errorBorder);
  }

  /* Inline mode button (left side) */
  .inline-mode-button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 0 6px 0 8px;
    background: transparent;
    border: none;
    border-right: 1px solid var(--vscode-input-border);
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    height: 100%;
    min-height: 28px;
  }

  .inline-mode-button:hover {
    background: var(--vscode-list-hoverBackground);
    color: var(--vscode-foreground);
  }

  /* Chevron indicator - appears on hover */
  .mode-chevron {
    font-size: 10px;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .inline-mode-button:hover .mode-chevron,
  .inline-mode-button:focus .mode-chevron {
    opacity: 0.7;
  }

  /* First-time discovery pulse animation */
  @keyframes discovery-pulse {
    0%,
    100% {
      background: transparent;
    }
    50% {
      background: var(--vscode-list-hoverBackground);
    }
  }

  .inline-mode-button.discovery-pulse {
    animation: discovery-pulse 2s ease-in-out 3;
    animation-delay: 1s;
  }

  .inline-mode-button.discovery-pulse:hover,
  .inline-mode-button.discovery-pulse:focus {
    animation: none;
  }

  /* Mode dropdown */
  .mode-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 1000;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    min-width: 180px;
    margin-top: 2px;
  }

  .mode-option {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    color: var(--vscode-dropdown-foreground);
    cursor: pointer;
    text-align: left;
  }

  .mode-option:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .mode-option.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }

  .mode-option-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .mode-option-label {
    font-size: 12px;
    font-weight: 500;
  }

  .mode-desc {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
  }

  .mode-option.active .mode-desc {
    color: var(--vscode-list-activeSelectionForeground);
    opacity: 0.8;
  }

  .mode-divider {
    height: 1px;
    background: var(--vscode-dropdown-border);
    margin: 4px 8px;
  }

  .mode-option.clear-option {
    color: var(--vscode-errorForeground);
  }

  .mode-option.clear-option:hover {
    background: var(--vscode-inputValidation-errorBackground);
  }

  /* Input area (center) */
  .input-area {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
    min-width: 0;
  }

  /* Value loaded animation - subtle highlight effect */
  @keyframes value-loaded-highlight {
    0% {
      background: var(--vscode-editor-selectionBackground);
    }
    100% {
      background: transparent;
    }
  }

  .input-area.value-loaded {
    animation: value-loaded-highlight 300ms ease-out;
  }

  .inline-input {
    width: 100%;
    padding: 6px 8px;
    background: transparent;
    border: none;
    color: var(--vscode-input-foreground);
    font-size: 13px;
    outline: none;
  }

  .inline-input::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }

  /* Loaded content indicator */
  .loaded-indicator {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    flex: 1;
    min-width: 0;
  }

  .loaded-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--vscode-foreground);
    font-size: 12px;
  }

  /* Inline action buttons (right side) */
  .inline-actions {
    display: flex;
    align-items: stretch;
    border-left: 1px solid var(--vscode-input-border);
  }

  .inline-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 8px;
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    height: 100%;
    min-height: 28px;
  }

  .inline-action-btn:hover:not(:disabled) {
    background: var(--vscode-list-hoverBackground);
    color: var(--vscode-foreground);
  }

  .inline-action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .inline-action-btn + .inline-action-btn {
    border-left: 1px solid var(--vscode-input-border);
  }

  /* Preview button styling */
  .inline-action-btn.preview-btn {
    color: var(--vscode-textLink-foreground);
  }

  .inline-action-btn.preview-btn:hover:not(:disabled) {
    background: var(--vscode-textLink-foreground);
    color: var(--vscode-button-foreground);
  }

  /* Browse button - more prominent styling */
  .inline-action-btn.browse-btn {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    padding: 0 10px;
    transition: all 0.2s ease;
  }

  .inline-action-btn.browse-btn:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
    color: var(--vscode-button-secondaryForeground);
    transform: scale(1.05);
  }

  /* Pulse animation for browse button */
  .inline-action-btn.browse-btn.pulse {
    animation: pulse-attention 1.5s ease-out;
  }

  @keyframes pulse-attention {
    0% {
      box-shadow: 0 0 0 0 var(--vscode-focusBorder);
    }
    50% {
      box-shadow: 0 0 0 4px var(--vscode-focusBorder);
    }
    100% {
      box-shadow: 0 0 0 0 var(--vscode-focusBorder);
    }
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

  /* Suggestions dropdown */
  .suggestions-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 1000;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    max-height: 200px;
    overflow-y: auto;
    margin-top: 2px;
  }

  .suggestion-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    background: transparent;
    border: none;
    color: var(--vscode-dropdown-foreground);
    cursor: pointer;
    text-align: left;
    font-size: 12px;
  }

  .suggestion-item:hover,
  .suggestion-item.selected {
    background: var(--vscode-list-hoverBackground);
  }

  .suggestion-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Files dropdown */
  .files-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 1000;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    max-height: 300px;
    overflow-y: auto;
    margin-top: 2px;
  }

  .dropdown-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-dropdown-border);
  }

  .dropdown-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-foreground);
  }

  .dropdown-header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .dropdown-info-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    background: transparent;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: help;
    border-radius: 4px;
    opacity: 0.7;
  }

  .dropdown-info-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
    opacity: 1;
  }

  .dropdown-close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    border-radius: 4px;
  }

  .dropdown-close-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
    color: var(--vscode-foreground);
  }

  .dropdown-section {
    padding: 4px 0;
  }

  .dropdown-section + .dropdown-section {
    border-top: 1px solid var(--vscode-dropdown-border);
    margin-top: 4px;
    padding-top: 8px;
  }

  .dropdown-section:first-of-type {
    background: var(--vscode-editor-background);
    margin: 0 4px;
    border-radius: 4px;
    padding: 4px 0;
  }

  .section-label {
    display: block;
    padding: 4px 12px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    font-weight: 600;
  }

  .file-item {
    display: flex;
    align-items: center;
    padding: 0 8px;
  }

  .file-select-btn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 4px;
    background: transparent;
    border: none;
    color: var(--vscode-dropdown-foreground);
    cursor: pointer;
    text-align: left;
    overflow: hidden;
  }

  .file-select-btn:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .file-name {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-path-hint {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 150px;
  }

  .favorite-icon {
    color: var(--vscode-charts-yellow);
  }

  .file-action-btn {
    padding: 4px;
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    opacity: 0.7;
    flex-shrink: 0;
  }

  .file-action-btn:hover {
    opacity: 1;
    color: var(--vscode-foreground);
  }

  .file-action-btn.remove-fav-btn:hover {
    color: var(--vscode-editorError-foreground);
  }

  .file-action-btn.reload-btn:hover {
    color: var(--vscode-charts-green);
  }

  /* Messages */
  .message {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    font-size: 11px;
    border-radius: 2px;
  }

  .message.error {
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    color: var(--vscode-errorForeground);
  }

  .message.warning {
    background: var(--vscode-inputValidation-warningBackground);
    border: 1px solid var(--vscode-inputValidation-warningBorder);
    color: var(--vscode-editorWarning-foreground);
  }
</style>
