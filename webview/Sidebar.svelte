<script lang="ts">
  /**
   * Main sidebar component for workflow dispatch
   */
  import { onMount, tick } from 'svelte';
  import { fade, slide, fly } from 'svelte/transition';
  import type {
    WorkflowDefinition,
    WorkflowFavorite,
    WorkflowTemplate,
    FileFavorite,
    RecentFile,
    ParsedFileContent,
    FileContentConfig,
  } from '../src/types/workflow-types';
  import SmartFileInput from './components/SmartFileInput.svelte';
  import FileContentModal from './components/FileContentModal.svelte';

  let authenticated = false;
  let workflows: WorkflowDefinition[] = [];
  let filteredWorkflows: WorkflowDefinition[] = [];
  let searchQuery = '';
  let selectedWorkflow: WorkflowDefinition | null = null;
  let branch = '';
  let currentBranch: string | null = null; // Current local Git branch
  const WAVE_ANIMATION_MIN_INTERVAL_MS = 60_000;
  const SIDEBAR_WAVE_STORAGE_KEY = 'githubWorkflowRunner:sidebarWaveLastTime';
  let showWelcomeWave = false;
  let showGitHubIcon = false; // Track transition to GitHub icon
  // Default branch for presets (fetched from backend; empty until known)
  let defaultBranch = '';
  let inputs: Record<string, string> = {};
  let hasBranchInput = false;

  $: hasBranchInput = !!selectedWorkflow?.inputs?.some(
    (input) => input.name.toLowerCase() === 'branch'
  );

  let prefillData: {
    workflowFilename: string;
    branch: string;
    inputs: Record<string, string>;
  } | null = null;
  let loading = false;
  let error = '';
  let errorTimeout: number | null = null; // Timer for auto-dismissing errors
  let dropdownOpen = false;

  // User info state
  let userInfo: { login: string; avatar_url?: string } | null = null;

  // Repository config state
  let repoOwner = '';
  let repoName = '';
  let isReloading = false; // Track reload state for UI feedback

  // Favorites state
  let favorites: WorkflowFavorite[] = [];
  let favoriteWorkflowFilenames: Set<string> = new Set();
  let repositoryFavorites: Array<{ owner: string; name: string }> = []; // Favorite repositories

  // Templates (presets) state
  let templates: WorkflowTemplate[] = [];
  let selectedTemplateId: string = '';

  // Presets section state
  let showPresets: boolean = false;

  // Advanced configuration state
  let artifactPattern: string = '';
  let showAdvancedConfig: boolean = false;
  let artifactPatternSaveTimeout: number | null = null;
  let artifactPatternSaving: boolean = false;

  // NOTE: The decision to add a run to the watch list is now made in the
  // extension host confirmation dialog (dispatch/rerun modal). We keep this
  // flag only for backward compatibility of messages, but the sidebar UI no
  // longer renders a separate "Add to watch list" checkbox here.
  let addToWatchList: boolean = false;

  // Track saved state for artifact pattern save button
  let artifactPatternSavedValue: string = '';
  let artifactPatternDirty: boolean = false;
  let artifactPatternJustSaved: boolean = false; // Show "saved" indicator briefly

  // Input modal state
  let showInputModal: boolean = false;
  let inputModalTitle: string = '';
  let inputModalValue: string = '';
  let inputModalPlaceholder: string = '';
  let inputModalCallback: ((_value: string | null) => void) | null = null;

  // Confirmation modal state
  type ConfirmModalMode = 'generic' | 'dispatch';
  let showConfirmModal: boolean = false;
  let confirmModalTitle: string = '';
  let confirmModalMessage: string = '';
  let confirmModalButtons: Array<{
    label: string;
    value: string;
    primary?: boolean;
  }> = [];
  let confirmModalCallback: ((_value: string | null) => void) | null = null;
  let confirmModalMode: ConfirmModalMode = 'generic';
  let dispatchConfirmBranch: string = '';
  let dispatchConfirmInputs: Record<string, unknown> = {};

  // Info modal state
  let showInfoModal: boolean = false;
  let infoModalTitle: string = '';
  let infoModalContent: string = '';

  // Toasts
  type ToastType = 'success' | 'error' | 'info' | 'warning';
  type Toast = {
    id: number;
    message: string;
    type: ToastType;
    duration: number;
  };
  let toasts: Toast[] = [];
  let toastIdCounter = 1;
  let reduceMotion = false;
  let reloadingInputs = false;

  // SmartFileInput state
  let smartFileInputData: Map<string, { recentFiles: RecentFile[]; favorites: FileFavorite[] }> =
    new Map();
  let smartFileInputLoading: Map<string, boolean> = new Map();
  let smartFileInputErrors: Map<string, string | null> = new Map();
  let smartFileInputSuggestions: Map<string, string[]> = new Map();
  let smartFileInputForceMode: Map<string, 'text' | 'path' | 'content' | null> = new Map();
  let smartFileInputValueFavorites: Map<
    string,
    Array<{ value: string; label?: string; addedAt: number }>
  > = new Map();

  // FileContentModal state
  let showFileContentModal: boolean = false;
  let fileContentModalInputName: string = '';
  let fileContentModalFilePath: string = '';
  let fileContentModalParsedContent: ParsedFileContent | null = null;
  let fileContentModalLoading: boolean = false;
  let fileContentModalError: string | null = null;
  let fileContentModalPreSelectedValues: string[] = []; // Issue 9: Pre-selected values for reload

  // Preview modal state
  let showPreviewModal: boolean = false;
  let previewModalInputName: string = '';
  let previewModalValue: string = '';
  let previewModalItems: Array<{ value: string; selected: boolean }> = [];
  let previewModalDelimiter: string = ',';
  let previewModalDelimiterName: string = 'Comma';
  let previewModalMode: 'text' | 'list' = 'text';
  let previewModalNewItemValue: string = '';
  let previewModalShowFavorites: boolean = false;

  // Value favorites per input (loaded from storage)
  let previewModalValueFavorites: Array<{ value: string; label?: string; addedAt: number }> = [];

  // Delimiter options for preview modal
  const DELIMITER_OPTIONS = [
    { delimiter: ',', name: 'Comma', display: ',' },
    { delimiter: '|', name: 'Pipe', display: '|' },
    { delimiter: '\n', name: 'Newline', display: '\\n' },
    { delimiter: ';', name: 'Semicolon', display: ';' },
    { delimiter: ' ', name: 'Space', display: '(space)' },
  ];

  // Delimiter detection patterns for preview modal (order matters - check more specific first)
  const DELIMITER_PATTERNS = [
    { delimiter: '|', name: 'Pipe' },
    { delimiter: ';', name: 'Semicolon' },
    { delimiter: '\n', name: 'Newline' },
    { delimiter: ',', name: 'Comma' },
  ];

  function showToast(message: string, type: ToastType = 'info', duration = 4000) {
    const id = toastIdCounter++;
    toasts = [...toasts, { id, message, type, duration }];
    const ms = Math.min(Math.max(duration, 2000), 8000);
    window.setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
    }, ms);
  }

  function getToastIcon(t: ToastType): string {
    switch (t) {
      case 'success':
        return 'codicon-pass';
      case 'error':
        return 'codicon-error';
      case 'warning':
        return 'codicon-warning';
      default:
        return 'codicon-info';
    }
  }

  // Templates (presets) helpers
  function requestTemplates() {
    if (selectedWorkflow) {
      vscode.postMessage({
        type: 'getTemplates',
        data: selectedWorkflow.filename,
      });
    }
  }

  function loadTemplate(t: WorkflowTemplate) {
    if (!t) {
      return;
    }
    branch = t.branch || branch;
    // Note: artifactPattern is NOT loaded from presets - it's workflow-specific config

    // Fix reactivity issue: create a new object instead of mutating
    const newInputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.inputs || {})) {
      newInputs[k] = String(v ?? '');
    }
    inputs = newInputs;
  }

  function onSelectTemplate(event: Event) {
    const id = (event.target as HTMLSelectElement).value;
    selectedTemplateId = id;
    const t = templates.find((x) => x.id === id);
    if (t) {
      loadTemplate(t);
    }
  }

  /**
   * Decide which branch should be stored in a preset.
   * Prompts when the current branch differs from the default branch.
   */
  async function resolvePresetBranchForSave(): Promise<string | null> {
    const trimmedBranch = branch.trim();
    const trimmedDefaultBranch = defaultBranch.trim();
    const trimmedCurrentBranch = (currentBranch ?? '').trim();

    // Effective branch we fall back to when we don't need to prompt:
    // 1) explicit branch field
    // 2) configured default branch
    // 3) current local branch
    // 4) empty string (let backend decide)
    const effectiveBranch = trimmedBranch || trimmedDefaultBranch || trimmedCurrentBranch || '';

    // If there is no explicit branch, or no known default branch, or the branch
    // already equals the default, don't prompt.
    if (!trimmedBranch || !trimmedDefaultBranch || trimmedBranch === trimmedDefaultBranch) {
      return effectiveBranch;
    }

    const choice = await showConfirmPrompt(
      'Confirm preset branch',
      `You're saving this preset with branch "${trimmedBranch}". Would you like to save it with the default branch "${trimmedDefaultBranch}" instead?`,
      [
        {
          label: `Use default branch (${trimmedDefaultBranch})`,
          value: 'useDefault',
          primary: true,
        },
        {
          label: `Keep "${trimmedBranch}"`,
          value: 'keepBranch',
        },
      ]
    );

    if (!choice) {
      return null;
    }

    if (choice === 'useDefault') {
      return trimmedDefaultBranch;
    }

    return trimmedBranch;
  }

  /**
   * Generate a unique name for a preset
   */

  async function saveCurrentAsTemplate() {
    if (!selectedWorkflow) {
      return;
    }

    // Generate a better default name
    const defaultName = generatePresetName(selectedWorkflow.name);

    let name = await showInputPrompt('Save Preset', defaultName, 'Enter preset name');
    if (!name) {
      return;
    }

    // Check for duplicate names
    while (presetNameExists(name)) {
      const action = await showConfirmPrompt(
        'Duplicate Preset Name',
        `A preset named "${name}" already exists. What would you like to do?`,
        [
          { label: 'Overwrite', value: 'overwrite', primary: true },
          { label: 'Rename', value: 'rename' },
          { label: 'Cancel', value: 'cancel' },
        ]
      );

      if (action === 'cancel' || !action) {
        return;
      } else if (action === 'overwrite') {
        // Find and delete the existing preset
        const existingPreset = templates.find((t) => t.name === name);
        if (existingPreset) {
          vscode.postMessage({
            type: 'deleteTemplate',
            data: existingPreset.id,
          });
          // Wait for deletion to complete and refresh templates
          await new Promise((resolve) => setTimeout(resolve, 150));
          // Refresh templates list to ensure local state is in sync
          requestTemplates();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        break;
      } else if (action === 'rename') {
        // Show input prompt again with the current name
        const newName = await showInputPrompt('Rename Preset', name, 'Enter a different name');
        if (!newName) {
          return;
        }
        name = newName;
      }
    }

    const branchToSave = await resolvePresetBranchForSave();
    if (!branchToSave) {
      return;
    }

    // Save the preset
    vscode.postMessage({
      type: 'saveTemplate',
      data: {
        name,
        workflowFilename: selectedWorkflow.filename,
        inputs,
        branch: branchToSave,
      },
    });

    // Refresh list and auto-select the new preset
    window.setTimeout(() => {
      requestTemplates();
      // Auto-select after templates are loaded
      window.setTimeout(() => {
        const savedPreset = templates.find((t) => t.name === name);
        if (savedPreset) {
          selectedTemplateId = savedPreset.id;
        }
      }, 200);
    }, 150);
  }

  async function renameSelectedTemplate() {
    const t = templates.find((x) => x.id === selectedTemplateId);
    if (!t) {
      return;
    }
    const name = await showInputPrompt('Rename preset', t.name, 'Enter new name');
    if (!name) {
      return;
    }
    vscode.postMessage({
      type: 'updateTemplate',
      data: { id: t.id, updates: { name } },
    });
    window.setTimeout(requestTemplates, 150);
  }

  async function deleteSelectedTemplate() {
    const t = templates.find((x) => x.id === selectedTemplateId);
    if (!t) {
      return;
    }

    const confirmed = await showConfirmPrompt(
      'Delete Preset',
      `Are you sure you want to delete the preset "${t.name}"? This action cannot be undone.`,
      [
        { label: 'Delete', value: 'delete', primary: true },
        { label: 'Cancel', value: 'cancel' },
      ]
    );

    if (confirmed !== 'delete') {
      return;
    }

    vscode.postMessage({ type: 'deleteTemplate', data: t.id });
    selectedTemplateId = '';
    window.setTimeout(requestTemplates, 150);
  }

  function exportSelectedPreset() {
    if (!selectedTemplateId) {
      return;
    }
    vscode.postMessage({ type: 'exportPreset', data: selectedTemplateId });
  }

  function importPresetFromFile() {
    vscode.postMessage({ type: 'importPreset' });
  }

  function showStorageInfo() {
    vscode.postMessage({ type: 'getStorageInfo' });
  }

  /**
   * Show input modal (replacement for window.prompt)
   */
  function showInputPrompt(
    title: string,
    defaultValue: string = '',
    placeholder: string = ''
  ): Promise<string | null> {
    return new Promise((resolve) => {
      inputModalTitle = title;
      inputModalValue = defaultValue;
      inputModalPlaceholder = placeholder;
      inputModalCallback = resolve;
      showInputModal = true;
    });
  }

  /**
   * Handle input modal confirm
   */
  function handleInputModalConfirm() {
    if (inputModalCallback) {
      inputModalCallback(inputModalValue || null);
    }
    showInputModal = false;
    inputModalCallback = null;
    inputModalValue = '';
  }

  /**
   * Handle input modal cancel
   */
  function handleInputModalCancel() {
    if (inputModalCallback) {
      inputModalCallback(null);
    }
    showInputModal = false;
    inputModalCallback = null;
    inputModalValue = '';
  }

  /**
   * Show confirmation modal with custom buttons
   */
  function showConfirmPrompt(
    title: string,
    message: string,
    buttons: Array<{ label: string; value: string; primary?: boolean }>
  ): Promise<string | null> {
    return new Promise((resolve) => {
      confirmModalMode = 'generic';
      confirmModalTitle = title;
      confirmModalMessage = message;
      confirmModalButtons = buttons;
      confirmModalCallback = resolve;
      showConfirmModal = true;
    });
  }

  /**
   * Handle confirmation modal button click
   */
  function handleConfirmModalClick(value: string) {
    if (confirmModalCallback) {
      confirmModalCallback(value);
    }
    showConfirmModal = false;
    confirmModalCallback = null;
  }

  /**
   * Handle confirmation modal cancel
   */
  function handleConfirmModalCancel() {
    if (confirmModalMode === 'dispatch') {
      // Notify extension host that the dispatch was cancelled.
      vscode.postMessage({
        type: 'confirmDispatchResult',
        data: { confirmed: false, addToWatchList: false },
      });
    } else if (confirmModalCallback) {
      confirmModalCallback(null);
    }
    showConfirmModal = false;
    confirmModalCallback = null;
    confirmModalMode = 'generic';
    dispatchConfirmBranch = '';
    dispatchConfirmInputs = {};
  }

  /**
   * Format a workflow input value for display in the dispatch confirmation
   * modal. This mirrors the formatting used in the Workflow Runs parameters
   * modal so the user sees a consistent representation of inputs.
   */
  function formatParameterValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }

    if (typeof value === 'string') {
      return value;
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  /**
   * Generate a unique preset name
   */
  function generatePresetName(workflowName: string): string {
    // Remove emoji and clean up workflow name
    const cleanName = workflowName.replace(/[\u{1F300}-\u{1F9FF}]/gu, '').trim();
    const baseName = cleanName.toLowerCase().replace(/\s+/g, '-');

    // Find existing preset numbers
    const existingNumbers = templates
      .filter((t) => t.name.startsWith(`${baseName}-preset-`))
      .map((t) => {
        const match = t.name.match(/-preset-(\d+)$/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter((n) => !isNaN(n));

    const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
    return `${baseName}-preset-${nextNumber}`;
  }

  /**
   * Check if preset name already exists
   */
  function presetNameExists(name: string): boolean {
    return templates.some((t) => t.name === name);
  }

  /**
   * Show info modal with detailed explanation
   */
  function showInfoModal_func(title: string, content: string) {
    infoModalTitle = title;
    infoModalContent = content;
    showInfoModal = true;
  }

  /**
   * Show help modal with extension overview
   */
  function showHelpModal() {
    const helpContent = `
<h4>🚀 GitHub Actions Runner</h4>

<h4>📖 Overview</h4>
<p>Run, monitor, and manage GitHub Actions workflows directly from VS Code. This extension provides a comprehensive interface for dispatching workflows with inputs, tracking runs in real-time, and managing workflow configurations.</p>

<h4>✨ Key Features</h4>
<ul>
  <li><strong>Workflow Dispatch:</strong> Trigger workflows with dynamic inputs directly from the sidebar</li>
  <li><strong>Real-time Monitoring:</strong> Track workflow runs with auto-refresh and live status updates</li>
  <li><strong>Advanced Filtering:</strong> Filter runs by workflow, actor, PR, branch, or bot runs</li>
  <li><strong>Preset Management:</strong> Save, load, export, and import workflow input configurations</li>
  <li><strong>Smart Input:</strong> Enhanced input fields with file path selection, content extraction, and multi-value editing</li>
  <li><strong>Favorites System:</strong> Quick access to frequently used workflows and input values</li>
  <li><strong>Artifact Management:</strong> Download and view workflow artifacts</li>
  <li><strong>Parameter Recovery:</strong> Automatically recover inputs from previous runs</li>
  <li><strong>Logs & Jobs:</strong> View detailed logs and job information</li>
</ul>

<h4>📝 Smart Input Features</h4>
<p>Smart Input provides three modes for entering workflow parameters:</p>
<ul>
  <li><strong>Text Mode</strong> <span class="codicon codicon-symbol-string"></span>: Enter text directly (default)</li>
  <li><strong>Path Mode</strong> <span class="codicon codicon-file-symlink-file"></span>: Browse and insert file paths from your workspace</li>
  <li><strong>Content Mode</strong> <span class="codicon codicon-file-code"></span>: Extract values from JSON/YAML files (e.g., test tags, config values)</li>
</ul>
<p><strong>Preview/Edit</strong> <span class="codicon codicon-eye"></span>: Click the eye icon to preview and edit multi-value inputs. Supports comma, pipe (|), newline, and other delimiters. Select/unselect items and save favorites.</p>
<p><strong>Recent & Favorites</strong>: Access recently used files and save favorites for quick reuse.</p>

<h4>🎯 Quick Start</h4>
<ol>
  <li>Authenticate with GitHub (if not already authenticated)</li>
  <li>Select a workflow from the dropdown</li>
  <li>Fill in required inputs (if any)</li>
  <li>Click "Dispatch Workflow" to trigger the run</li>
  <li>Monitor progress in the Workflow Runs panel</li>
</ol>

<h4>💡 Pro Tips</h4>
<ul>
  <li>Click the <span class="codicon codicon-bookmark"></span> <strong>Presets</strong> button to save and load workflow configurations for quick reuse</li>
  <li>Click on branch names in the Workflow Runs panel to open them on GitHub</li>
  <li>Use the <span class="codicon codicon-go-to-file"></span> <strong>View File</strong> button to open workflow YAML files in the editor</li>
  <li>Export presets to share configurations with your team</li>
  <li>Use artifact patterns (in Advanced Configuration) to automatically recover parameters from previous runs</li>
  <li>Use Smart Input's Content Mode to extract test tags or config values from JSON/YAML files</li>
</ul>

<h4>📚 Documentation</h4>
<p>For detailed documentation, visit the <a href="https://github.com/Asher-Kaligski/vscode-github-workflow-runner">GitHub repository</a>.</p>

<h4>🐛 Report Issues</h4>
<p>Found a bug or have a feature request? <a href="https://github.com/Asher-Kaligski/vscode-github-workflow-runner/issues">Open an issue</a> on GitHub.</p>

<h4>💖 Support</h4>
<p>If you find this extension helpful, consider <a href="https://github.com/sponsors/Asher-Kaligski">sponsoring the project</a>!</p>
    `.trim();

    showInfoModal_func('Help & Information', helpContent);
  }

  /**
   * Close info modal
   */
  function closeInfoModal() {
    showInfoModal = false;
  }

  /**
   * Handle clicks on links in the info modal
   */
  function handleInfoModalClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (target.tagName === 'A') {
      const href = target.getAttribute('href');
      if (href) {
        event.preventDefault();
        vscode.postMessage({
          type: 'openExternalUrl',
          data: href,
        });
      }
    }
  }

  /**
   * Show artifact pattern help
   */
  function showArtifactPatternHelp() {
    const content = `
<h4>What are Artifact Patterns?</h4>
<p>Artifact patterns are used to identify and download workflow artifacts that contain previous input parameters. This enables the extension to restore your workflow inputs when rerunning workflows.</p>

<h4>How It Works: 3-Tier Parameter Recovery</h4>
<ol>
  <li><strong>Priority 1: Local Storage</strong> - Most recent dispatch for this workflow (fastest)</li>
  <li><strong>Priority 2: Artifact Recovery</strong> - Downloads artifacts matching your pattern and extracts parameters</li>
  <li><strong>Priority 3: Direct Rerun</strong> - Falls back to GitHub API rerun (no parameter restoration)</li>
</ol>

<h4>Pattern Syntax</h4>
<ul>
  <li><strong>Simple Wildcards:</strong> Use <code>*</code> as a wildcard
    <ul>
      <li><code>build-parameters-*</code> matches "build-parameters-123", "build-parameters-main"</li>
      <li><code>*-params</code> matches "workflow-params", "test-params"</li>
    </ul>
  </li>
  <li><strong>Full Regex:</strong> Use standard regex patterns
    <ul>
      <li><code>^workflow-inputs-.*$</code> matches any artifact starting with "workflow-inputs-"</li>
      <li><code>^(build|test)-params-\\d+$</code> matches "build-params-123" or "test-params-456"</li>
    </ul>
  </li>
</ul>

<h4>Common Use Cases</h4>
<ul>
  <li><strong>Default:</strong> <code>*parameter*</code> - Matches any artifact containing "parameter"</li>
  <li><strong>Branch-specific:</strong> <code>params-{branch}-*</code> - Different params per branch</li>
  <li><strong>Environment-specific:</strong> <code>*-{env}-params</code> - prod-params, dev-params, etc.</li>
</ul>

<h4>💡 Tips</h4>
<ul>
  <li>The pattern is auto-saved after 1 second of inactivity</li>
  <li>Test your pattern by checking if artifacts are found in recent workflow runs</li>
  <li>If no artifacts match, the extension will fall back to direct rerun without parameter restoration</li>
</ul>
    `.trim();

    showInfoModal_func('Artifact Pattern for Parameter Recovery', content);
  }

  /**
   * Show presets help modal
   */
  function showPresetsHelp() {
    const content = `
<h4>What are Presets?</h4>
<p>Presets allow you to save and quickly load workflow configurations. Instead of manually filling in inputs every time, you can save your commonly used configurations and load them with a single click.</p>

<h4>📝 Saving a Preset</h4>
<ol>
  <li>Select a workflow and fill in the inputs you want to save</li>
  <li>Click the <strong>💾 Save preset</strong> button</li>
  <li>Enter a descriptive name (e.g., "Production Deploy", "Staging Test")</li>
  <li>The preset is saved and automatically selected</li>
</ol>

<h4>📂 Loading a Preset</h4>
<ol>
  <li>Click the <strong>📑 Presets</strong> button to open the presets section</li>
  <li>Select a preset from the <strong>Load preset...</strong> dropdown</li>
  <li>All saved inputs and the branch will be restored</li>
</ol>

<h4>🔧 Managing Presets</h4>
<p>When a preset is selected, additional management buttons appear:</p>
<ul>
  <li><strong>📝 Rename</strong> - Change the preset name</li>
  <li><strong>↗️ Export</strong> - Save the preset to a JSON file</li>
  <li><strong>🗑️ Delete</strong> - Remove the preset permanently</li>
</ul>

<h4>📤 Sharing Presets with Your Team</h4>
<ol>
  <li><strong>Export:</strong> Select a preset and click <strong>Export</strong> to save it as a JSON file</li>
  <li><strong>Share:</strong> Send the JSON file to your teammates via Slack, email, or your repository</li>
  <li><strong>Import:</strong> Team members click <strong>Import from File</strong> and select the JSON file</li>
</ol>

<h4>💾 Storage Info</h4>
<p>Click <strong>Storage Info</strong> to see where presets are stored on your system. Presets are stored per-workflow, so each workflow has its own set of presets.</p>

<h4>💡 Tips</h4>
<ul>
  <li>Use descriptive names that indicate environment, purpose, or context</li>
  <li>Create presets for each environment (dev, staging, production)</li>
  <li>Export your presets to back them up or share with new team members</li>
  <li>Presets include both inputs and the selected branch</li>
</ul>
    `.trim();

    showInfoModal_func('About Presets', content);
  }

  /**
   * Reload workflow inputs from file
   */
  function handleReloadWorkflowInputs() {
    if (!selectedWorkflow) {
      return;
    }
    reloadingInputs = true;
    vscode.postMessage({
      type: 'getWorkflowSchema',
      data: selectedWorkflow.filename,
    });
    vscode.postMessage({
      type: 'getWorkflowConfig',
      data: selectedWorkflow.filename,
    });
    vscode.postMessage({
      type: 'getTemplates',
      data: selectedWorkflow.filename,
    });
    showToast('Reloading workflow inputs...', 'info', 2000);
  }

  /**
   * Open workflow file in editor
   */
  function handleOpenWorkflowFile() {
    if (!selectedWorkflow) {
      return;
    }
    vscode.postMessage({
      type: 'openWorkflowFile',
      data: { filePath: selectedWorkflow.filepath },
    });
    showToast('Opening workflow file...', 'info', 2000);
  }

  /**
   * Save artifact pattern manually
   */
  function saveArtifactPattern() {
    if (!selectedWorkflow) {
      return;
    }

    artifactPatternSaving = true;

    vscode.postMessage({
      type: 'setWorkflowConfig',
      data: {
        workflowFilename: selectedWorkflow.filename,
        artifactPattern: artifactPattern || undefined,
      },
    });

    if (artifactPatternSaveTimeout) {
      clearTimeout(artifactPatternSaveTimeout);
      artifactPatternSaveTimeout = null;
    }
  }

  // File picker state
  let filePickerStates: Map<string, any> = new Map();

  /**
   * Decide whether the sidebar welcome wave animation should run.
   */
  function shouldPlaySidebarWave(): boolean {
    try {
      const last = window.sessionStorage.getItem(SIDEBAR_WAVE_STORAGE_KEY);
      const now = Date.now();

      if (last) {
        const lastTime = Number(last);
        if (!Number.isNaN(lastTime) && now - lastTime < WAVE_ANIMATION_MIN_INTERVAL_MS) {
          return false;
        }
      }

      window.sessionStorage.setItem(SIDEBAR_WAVE_STORAGE_KEY, String(now));
      return true;
    } catch {
      // If storage is unavailable, fall back to animating once per mount.
      return true;
    }
  }

  /**
   * Trigger the welcome wave animation once, with a small reset to
   * ensure the CSS animation reliably plays.
   * After the wave completes, wait 3-5 seconds and transition to GitHub icon.
   */
  async function playSidebarWaveOnce() {
    // Reset the class so toggling re-triggers the animation.
    showWelcomeWave = false;
    showGitHubIcon = false;
    await tick();
    showWelcomeWave = true;

    // Remove the class after the animation finishes so it can be
    // re-applied in a future session if allowed by rate limiting.
    window.setTimeout(() => {
      showWelcomeWave = false;
    }, 2000);

    // After wave animation completes, wait 3-5 seconds then transition to GitHub icon
    // Wave animation is 2s, so total delay is 2s + 4s = 6s
    window.setTimeout(() => {
      showGitHubIcon = true;
    }, 6000); // 2s wave + 4s delay
  }

  function triggerSidebarWaveIfAllowed() {
    if (reduceMotion) {
      return;
    }
    if (!shouldPlaySidebarWave()) {
      return;
    }
    void playSidebarWaveOnce();
  }

  onMount(() => {
    // Listen for messages from extension
    window.addEventListener('message', handleMessage);

    // Listen for clicks outside to close dropdown
    document.addEventListener('click', handleClickOutside);

    // Detect motion preference
    reduceMotion = !!(
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );

    triggerSidebarWaveIfAllowed();

    // Notify extension that the webview is ready to receive messages
    vscode.postMessage({ type: 'webviewReady' });

    // Check authentication status first
    vscode.postMessage({ type: 'checkAuth' });

    // Load favorites on mount
    vscode.postMessage({ type: 'getFavorites' });
    vscode.postMessage({ type: 'getRepositoryFavorites' });

    // Always request local Git and repository info; this does not require GitHub auth
    vscode.postMessage({ type: 'getCurrentBranch' });
    vscode.postMessage({ type: 'getRepositoryConfig' });

    // Request default branch for presets
    vscode.postMessage({ type: 'getDefaultBranch' });

    return () => {
      window.removeEventListener('message', handleMessage);
      document.removeEventListener('click', handleClickOutside);
    };
  });

  /**
   * Handle messages from extension
   */
  function handleMessage(event: MessageEvent) {
    const message = event.data;
    console.log('[Sidebar] Received message:', message.type, message);

    switch (message.type) {
      case 'confirmDispatch': {
        loading = false;
        const data = message.data as {
          workflowName: string;
          workflowFilename: string;
          branch: string;
          inputs: Record<string, unknown>;
        };

        confirmModalMode = 'dispatch';
        confirmModalTitle = `Dispatch workflow "${data.workflowName}"?`;
        confirmModalMessage = '';
        confirmModalButtons = [];
        dispatchConfirmBranch = data.branch;
        dispatchConfirmInputs = data.inputs || {};
        showConfirmModal = true;
        break;
      }

      case 'getWorkflows':
        if (message.success) {
          workflows = message.data;
          filterWorkflows(); // Apply filtering and sorting
          authenticated = true;
          // If we have a pending prefill, try to select and load schema now
          if (prefillData) {
            const wf = workflows.find((w) => w.filename === prefillData.workflowFilename);
            if (wf) {
              selectedWorkflow = wf;
              searchQuery = wf.name;
              filterWorkflows();
              // Request schema to finalize prefill
              vscode.postMessage({
                type: 'getWorkflowSchema',
                data: prefillData.workflowFilename,
              });
            }
          }
        }
        break;

      case 'getWorkflowSchema':
        if (message.success) {
          selectedWorkflow = message.data;
          // Start from defaults
          initializeInputs();
          // If prefill data targets this workflow, merge values and branch
          if (
            prefillData &&
            selectedWorkflow &&
            selectedWorkflow.filename === prefillData.workflowFilename
          ) {
            branch = prefillData.branch || branch;
            for (const [k, v] of Object.entries(prefillData.inputs || {})) {
              inputs[k] = String(v ?? '');
            }
            if (selectedWorkflow) {
              searchQuery = selectedWorkflow.name;
              filterWorkflows();
            }
            // Clear prefill after applying
            prefillData = null;
          }
          // Show toast if this was a reload action
          if (reloadingInputs) {
            showToast('Workflow inputs reloaded', 'success', 2500);
            reloadingInputs = false;
          }
          // Request templates for this workflow
          if (selectedWorkflow) {
            vscode.postMessage({
              type: 'getTemplates',
              data: selectedWorkflow.filename,
            });
            // Request workflow config for artifact pattern
            vscode.postMessage({
              type: 'getWorkflowConfig',
              data: selectedWorkflow.filename,
            });
          }
        }
        break;

      case 'getWorkflowConfig':
        if (message.success) {
          // Update even when no config exists yet to clear stale value
          artifactPattern = message.data?.artifactPattern || '';
          // Sync saved state and clear dirty flag
          artifactPatternSavedValue = artifactPattern;
          artifactPatternDirty = false;
          artifactPatternSaving = false;
          if (artifactPatternSaveTimeout) {
            clearTimeout(artifactPatternSaveTimeout);
            artifactPatternSaveTimeout = null;
          }
        }
        break;

      case 'getCurrentBranch':
        if (message.success && message.data) {
          currentBranch = message.data;
          if (!branch) {
            branch = message.data;
          }
        }
        break;

      case 'getDefaultBranch':
        if (message.success && message.data) {
          defaultBranch = String(message.data ?? '').trim();
        }
        break;

      case 'getUserInfo':
        if (message.success && message.data) {
          userInfo = message.data;
        }
        break;

      case 'getRepositoryConfig':
        if (message.success && message.data) {
          const config = message.data;
          repoOwner = config.owner;
          repoName = config.name;

          // Now that repository is known, recompute favorites for this repo
          if (repoOwner && repoName && favorites?.length) {
            favoriteWorkflowFilenames = new Set(
              favorites
                .filter((f) => f.repository.owner === repoOwner && f.repository.name === repoName)
                .map((f) => f.workflowFilename)
            );
            // Re-sort to place favorites first
            filterWorkflows();
          }
        }
        break;

      case 'getTemplates':
        if (message.success) {
          templates = message.data || [];
        }
        break;

      case 'checkAuth':
        console.log('Received checkAuth message:', message);
        if (message.success && message.data?.authenticated) {
          // User is authenticated, request initial data that requires GitHub
          authenticated = true;
          vscode.postMessage({ type: 'getWorkflows' });
          vscode.postMessage({ type: 'getUserInfo' });
        } else {
          // User is not authenticated, show auth screen
          authenticated = false;
        }
        break;

      case 'signOut':
        console.log('Received signOut message:', message);
        if (message.success) {
          // Reset all state to unauthenticated
          authenticated = false;
          userInfo = null;
          workflows = [];
          filteredWorkflows = [];
          selectedWorkflow = null;
          inputs = {};
          repoOwner = '';
          repoName = '';
          branch = '';
          error = '';
          loading = false;
          console.log('State reset complete, authenticated:', authenticated);
        }
        break;

      case 'success': {
        loading = false;
        error = '';
        const messageText: string | undefined = message.data?.message;

        // Check if this is a preset import success
        if (messageText?.includes('imported successfully')) {
          // Refresh templates for current workflow only
          requestTemplates();
        }

        // Check if this is a workflow config save (artifact pattern)
        if (messageText === 'Workflow configuration saved successfully') {
          artifactPatternSavedValue = artifactPattern;
          artifactPatternDirty = false;
          artifactPatternSaving = false;
          artifactPatternJustSaved = true;
          // Clear the "just saved" indicator after 2 seconds
          window.setTimeout(() => {
            artifactPatternJustSaved = false;
          }, 2000);
          if (artifactPatternSaveTimeout) {
            clearTimeout(artifactPatternSaveTimeout);
            artifactPatternSaveTimeout = null;
          }
        }

        // Don't reset form - keep inputs and workflow selected for easy re-dispatch
        break;
      }

      case 'cancelled':
        loading = false;
        error = '';
        // User cancelled dispatch - keep form as is
        break;

      case 'reloadExtensionDataResponse':
        isReloading = false;
        if (message.success) {
          // Data reloaded successfully - UI will update from other messages
          console.log('Extension data reloaded successfully');
        } else {
          setError(message.error || 'Failed to reload extension data');
        }
        break;

      case 'gitContextMismatch':
        loading = false;
        setError(
          message.error || 'Repository or branch has changed. Please reload the extension data.'
        );
        break;

      case 'prefillDispatch': {
        const data = message.data as {
          workflowFilename: string;
          branch: string;
          inputs: Record<string, string>;
        };
        if (data && data.workflowFilename) {
          prefillData = data;
          // Set branch immediately for user feedback
          branch = data.branch || branch;

          // Ensure workflows are available and select the target workflow
          const wf = workflows.find((w) => w.filename === data.workflowFilename);
          if (wf) {
            // Workflows already loaded: select and request schema immediately
            selectedWorkflow = wf;
            searchQuery = wf.name;
            filterWorkflows();
            // Request schema to merge defaults with prefilled values
            vscode.postMessage({
              type: 'getWorkflowSchema',
              data: data.workflowFilename,
            });
          } else {
            // Workflows not loaded yet: request them and defer schema request
            // The getWorkflows handler will select the workflow and request schema
            vscode.postMessage({ type: 'getWorkflows' });
          }
        }
        break;
      }

      case 'error':
        loading = false;
        setError(message.error || 'An error occurred');

        if (artifactPatternSaving) {
          artifactPatternSaving = false;
          if (artifactPatternSaveTimeout) {
            clearTimeout(artifactPatternSaveTimeout);
            artifactPatternSaveTimeout = null;
          }
        }
        break;

      case 'storageInfo':
        if (message.success && message.data?.info) {
          showInfoModal_func(
            'Preset Storage Information',
            `
<h4>Storage Location</h4>
<p>${message.data.info}</p>

<h4>About VS Code globalState</h4>
<p>Presets are stored in VS Code's internal storage (globalState), which is:</p>
<ul>
  <li><strong>Persistent:</strong> Survives VS Code restarts and updates</li>
  <li><strong>Per-machine:</strong> Stored locally on your computer</li>
  <li><strong>Not synced:</strong> Not automatically synced across devices</li>
</ul>

<h4>Sharing Presets</h4>
<p>To share presets with teammates:</p>
<ol>
  <li>Select a preset from the dropdown</li>
  <li>Click <strong>Export</strong> to save it as a JSON file</li>
  <li>Share the JSON file with your team</li>
  <li>They can use <strong>Import from File</strong> to load it</li>
</ol>

<h4>Backup & Migration</h4>
<p>Export your presets regularly to back them up or migrate to another machine.</p>
          `.trim()
          );
        }
        break;

      case 'addFavoriteResponse':
        if (message.success) {
          // Refresh favorites list
          vscode.postMessage({ type: 'getFavorites' });
        } else {
          setError(message.error || 'Failed to add favorite');
        }
        break;

      case 'removeFavoriteResponse':
        if (message.success) {
          // Refresh favorites list
          vscode.postMessage({ type: 'getFavorites' });
        } else {
          setError(message.error || 'Failed to remove favorite');
        }
        break;

      case 'getFavoritesResponse':
        if (message.success) {
          favorites = message.data?.favorites || [];
          // If repository is not yet known, keep optimistic UI state until repo config arrives
          if (repoOwner && repoName) {
            // Update the set of favorite workflow filenames for current repo only
            favoriteWorkflowFilenames = new Set(
              favorites
                .filter((f) => f.repository.owner === repoOwner && f.repository.name === repoName)
                .map((f) => f.workflowFilename)
            );
            // Re-sort dropdown with favorites first
            filterWorkflows();
          }
        }
        break;

      case 'getRepositoryFavoritesResponse':
        if (message.success) {
          repositoryFavorites = message.data?.repositories || [];
        } else {
          setError(message.error || 'Failed to get repository favorites');
        }
        break;

      case 'saveRepositoryFavoritesResponse':
        if (message.success) {
          repositoryFavorites = message.data?.repositories || repositoryFavorites;
        } else {
          setError(message.error || 'Failed to save repository favorites');
        }
        break;

      case 'dispatchFavoriteResponse':
        if (message.success) {
          loading = false;
          clearError();
        } else {
          loading = false;
          setError(message.error || 'Failed to dispatch favorite');
        }
        break;

      case 'selectFileResponse':
        {
          const paramName = message.data?.parameterName;
          const mode = message.data?.mode;
          if (paramName) {
            // Check if this is a SmartFileInput request (has mode parameter)
            if (mode) {
              // Clear SmartFileInput loading state
              smartFileInputLoading.set(paramName, false);
              smartFileInputLoading = smartFileInputLoading;

              if (message.success) {
                const relativePath = message.data.relativePath || message.data.path;

                if (mode === 'content') {
                  // For content mode, open the FileContentModal
                  handleSmartInputLoadContent(paramName, relativePath);
                } else {
                  // For path mode, set the value directly
                  inputs[paramName] = relativePath;
                  inputs = inputs;
                  // Track as recent file with path mode
                  handleSmartInputTrackRecent(paramName, relativePath, undefined, 'path');
                  // Auto-switch to text mode after browse, then clear force mode
                  smartFileInputForceMode.set(paramName, 'text');
                  smartFileInputForceMode = smartFileInputForceMode;
                  // Clear force mode after a tick so component can react but future mode switches work
                  setTimeout(() => {
                    smartFileInputForceMode.set(paramName, null);
                    smartFileInputForceMode = smartFileInputForceMode;
                  }, 50);
                }
              } else if (message.error !== 'File selection cancelled') {
                // Only show error if not cancelled
                smartFileInputErrors.set(paramName, message.error || 'Failed to select file');
                smartFileInputErrors = smartFileInputErrors;
              }
            }
            // Check if this is a "load contents" request (old file picker)
            else if (paramName.startsWith('__loadContents_')) {
              const actualParamName = paramName.replace('__loadContents_', '');
              if (message.success) {
                // Request file contents
                vscode.postMessage({
                  type: 'readFileContent',
                  data: {
                    path: message.data.path,
                    parameterName: actualParamName,
                  },
                });
              } else {
                filePickerStates.set(actualParamName, {
                  isLoading: false,
                  error: message.error,
                });
                filePickerStates = filePickerStates;
              }
            } else {
              // Regular file path selection (old file picker)
              const state = filePickerStates.get(paramName);
              if (message.success) {
                inputs[paramName] = message.data.relativePath || message.data.path;
                filePickerStates.set(paramName, {
                  ...state,
                  selectedPath: message.data.path,
                  fileSize: message.data.size,
                  isLoading: false,
                  warning: message.warning,
                });
              } else {
                filePickerStates.set(paramName, {
                  ...state,
                  isLoading: false,
                  error: message.error,
                });
              }
              filePickerStates = filePickerStates;
            }
          }
        }
        break;

      case 'readFileContentResponse':
        if (message.data?.parameterName) {
          const paramName = message.data.parameterName;
          if (message.success) {
            // Find the input definition to get its description
            const inputDef = selectedWorkflow?.inputs?.find((inp) => inp.name === paramName);
            const description = inputDef?.description || '';

            // Parse the file contents based on the input description
            const parsedContent = parseFileContents(message.data.content, description);

            // Set the input value to the parsed file contents
            inputs[paramName] = parsedContent;
            filePickerStates.set(paramName, {
              isLoading: false,
              warning: message.warning,
            });
          } else {
            filePickerStates.set(paramName, {
              isLoading: false,
              error: message.error,
            });
          }
          filePickerStates = filePickerStates;
        }
        break;

      // SmartFileInput message handlers
      case 'smartFileInputDataResponse':
        if (message.data?.inputName) {
          const inputName = message.data.inputName;
          if (message.success) {
            smartFileInputData.set(inputName, {
              recentFiles: message.data.recentFiles || [],
              favorites: message.data.favorites || [],
            });
            // Also load value favorites if present
            if (message.data.valueFavorites) {
              const storageKey = `${repoOwner}/${repoName}/${selectedWorkflow?.filename}/${inputName}`;
              smartFileInputValueFavorites.set(storageKey, message.data.valueFavorites);
              smartFileInputValueFavorites = smartFileInputValueFavorites;
            }
          }
          smartFileInputData = smartFileInputData;
        }
        break;

      case 'addFileFavoriteResponse':
      case 'removeFileFavoriteResponse':
      case 'updateFileFavoriteResponse':
      case 'trackRecentFileResponse':
        // Refresh the data for this input to show updated history
        if (message.data?.inputName) {
          requestSmartFileInputData(message.data.inputName);
        }
        break;

      case 'fileSuggestionsResponse':
        if (message.data?.inputName) {
          smartFileInputSuggestions.set(message.data.inputName, message.data.suggestions || []);
          smartFileInputSuggestions = smartFileInputSuggestions;
        }
        break;

      case 'parseFileForSelectionResponse':
        if (message.data?.inputName === fileContentModalInputName) {
          fileContentModalLoading = false;
          if (message.success) {
            fileContentModalParsedContent = message.data.parsedContent;
            fileContentModalFilePath = message.data.filePath || fileContentModalFilePath;
          } else {
            fileContentModalError = message.error || 'Failed to parse file';
          }
        }
        break;

      case 'saveValueFavoritesResponse':
        if (message.success && message.data?.inputName) {
          const storageKey = `${repoOwner}/${repoName}/${selectedWorkflow?.filename}/${message.data.inputName}`;
          smartFileInputValueFavorites.set(storageKey, message.data.favorites || []);
          smartFileInputValueFavorites = smartFileInputValueFavorites;
          // Update the preview modal state if it's open for this input
          if (showPreviewModal && previewModalInputName === message.data.inputName) {
            previewModalValueFavorites = message.data.favorites || [];
          }
        }
        break;
    }
  }

  /**
   * Initialize inputs with default values
   */
  function initializeInputs() {
    if (!selectedWorkflow) {
      return;
    }

    inputs = {};
    // Clear SmartFileInput data for new workflow
    smartFileInputData.clear();
    smartFileInputLoading.clear();
    smartFileInputErrors.clear();
    smartFileInputSuggestions.clear();

    for (const input of selectedWorkflow.inputs) {
      if (input.default !== undefined) {
        inputs[input.name] = String(input.default);
      } else {
        inputs[input.name] = '';
      }

      // Request SmartFileInput data for string-type inputs
      if (input.type === 'string' || input.type === 'text') {
        requestSmartFileInputData(input.name);
      }
    }
  }

  /**
   * Apply a branch helper selection to both the branch field and any
   * explicit "branch" workflow input so they stay in sync.
   */
  function applyBranchHelper(selectedBranch: string) {
    if (!selectedBranch) {
      return;
    }

    branch = selectedBranch;
    if (hasBranchInput) {
      inputs['branch'] = selectedBranch;
    }
  }

  /**
   * Handle form submission
   *
   * When confirmBeforeDispatch is enabled, the extension host will trigger a
   * webview-based confirmation modal so the user can review parameters and
   * optionally choose to add the run to the watch list before dispatch.
   */
  function handleSubmit() {
    if (!selectedWorkflow || !branch) {
      setError('Please select a workflow and branch');
      return;
    }

    loading = true;
    clearError();

    vscode.postMessage({
      type: 'dispatchWorkflow',
      data: {
        workflowFilename: selectedWorkflow.filename,
        branch,
        inputs,
        // addToWatchList is kept for backward compatibility but the
        // effective choice is made in the extension's confirmation modal.
        addToWatchList,
      },
    });
  }

  /**
   * Handle sign out
   */
  function handleSignOut() {
    console.log('handleSignOut called, sending signOut message');
    // Send sign out request to extension
    // The extension will respond with a signOut message to update the UI
    vscode.postMessage({ type: 'signOut' });
  }

  /**
   * Reload extension data after repository/branch change.
   * Re-detects the current repository and branch, refreshes Git context,
   * and reloads all sidebar data (workflows, repository config, branches, etc.)
   */
  function handleReloadExtensionData() {
    if (isReloading) {
      return;
    }
    isReloading = true;
    vscode.postMessage({ type: 'reloadExtensionData' });
  }

  /**
   * Show info modal explaining the reload functionality
   */
  function showReloadInfoModal() {
    infoModalTitle = 'Reload Extension Data';
    infoModalContent = `
<h4>🔄 When to Reload</h4>
<p>Use the reload button when you've switched Git branches or repositories and want the extension to detect the new context.</p>

<h4>⚠️ Why This Matters</h4>
<p>The extension validates that your current repository and branch match what was detected when the sidebar opened. If they don't match, GitHub API operations (like dispatching workflows) will be blocked to prevent accidental actions on the wrong repository or branch.</p>

<h4>🔧 What Reload Does</h4>
<ul>
  <li>Re-detects the current Git repository and branch</li>
  <li>Refreshes the stored Git context for validation</li>
  <li>Reloads workflows, repository config, and branch information</li>
  <li>Clears any stale state from the previous context</li>
</ul>

<h4>💡 Tip</h4>
<p>If you see a "Repository or branch has changed" error, click the reload button to update the extension's context.</p>
`;
    showInfoModal = true;
  }

  /**
   * Handle authentication
   */
  function handleAuthenticate() {
    vscode.postMessage({ type: 'authenticate' });
  }

  /**
   * Check if a workflow is favorited
   */
  function isWorkflowFavorited(workflowFilename: string): boolean {
    return favoriteWorkflowFilenames.has(workflowFilename);
  }

  /**
   * Toggle favorite status for a workflow
   */
  function toggleWorkflowFavorite(workflow: WorkflowDefinition, event: Event) {
    event.stopPropagation(); // Prevent dropdown item click

    if (isWorkflowFavorited(workflow.filename)) {
      // Remove from favorites - update UI immediately
      favoriteWorkflowFilenames.delete(workflow.filename);
      // Create new Set to trigger reactivity
      favoriteWorkflowFilenames = new Set(favoriteWorkflowFilenames);
      // Update ordering immediately
      filterWorkflows();

      const favorite = favorites.find(
        (f) =>
          f.workflowFilename === workflow.filename &&
          f.repository.owner === repoOwner &&
          f.repository.name === repoName
      );
      if (favorite && favorite.id) {
        vscode.postMessage({
          type: 'removeFavorite',
          data: { id: favorite.id },
        });
      } else {
        console.warn('[Sidebar] Could not find favorite to remove:', workflow.filename);
      }
    } else {
      // Add to favorites - update UI immediately
      favoriteWorkflowFilenames.add(workflow.filename);
      // Create new Set to trigger reactivity
      favoriteWorkflowFilenames = new Set(favoriteWorkflowFilenames);
      // Update ordering immediately
      filterWorkflows();

      vscode.postMessage({
        type: 'addFavorite',
        data: {
          workflowName: workflow.name,
          workflowFilename: workflow.filename,
          repository: {
            owner: repoOwner,
            name: repoName,
          },
          branch: branch || '',
          savedInputs: {},
        },
      });
    }
  }

  /**
   * Set error message with auto-dismiss after 5 seconds
   */
  function setError(message: string) {
    // Clear any existing timeout
    if (errorTimeout) {
      clearTimeout(errorTimeout);
    }

    error = message;

    // Auto-dismiss after 5 seconds
    errorTimeout = window.setTimeout(() => {
      error = '';
      errorTimeout = null;
    }, 5000);
  }

  /**
   * Clear error message when user makes changes
   */
  function clearError() {
    if (error) {
      error = '';
    }
    if (errorTimeout) {
      clearTimeout(errorTimeout);
      errorTimeout = null;
    }
  }

  /**
   * Parse file contents based on input description
   */
  function parseFileContents(content: string, description: string): string {
    if (!description) {
      return content;
    }

    const lowerDesc = description.toLowerCase();

    // Check for comma-separated format
    if (lowerDesc.includes('comma-separated') || lowerDesc.includes('comma separated')) {
      // Parse and clean up comma-separated values
      return content
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .join(', ');
    }

    // Check for key=value format
    if (
      lowerDesc.includes('key=value') ||
      lowerDesc.includes('key-value') ||
      lowerDesc.includes('key value')
    ) {
      // Parse key=value pairs and format them
      return content
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line.includes('='))
        .join(', ');
    }

    // Check for semicolon-separated format
    if (lowerDesc.includes('semicolon-separated') || lowerDesc.includes('semicolon separated')) {
      return content
        .split(/[;\n]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .join('; ');
    }

    // Check for space-separated format
    if (lowerDesc.includes('space-separated') || lowerDesc.includes('space separated')) {
      return content
        .split(/[\s\n]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .join(' ');
    }

    // Check for JSON format
    if (lowerDesc.includes('json')) {
      try {
        // Try to parse and minify JSON
        const parsed = JSON.parse(content);
        return JSON.stringify(parsed);
      } catch {
        // If parsing fails, return as-is
        return content;
      }
    }

    // Default: if content has multiple lines, join them with commas
    // This handles the common case of multi-line parameter lists
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length > 1) {
      return lines.join(', ');
    }

    // Single line: return as-is, but trim whitespace
    return content.trim();
  }

  /**
   * Load file contents into a text input
   */
  function loadFileContents(parameterName: string) {
    filePickerStates.set(parameterName, {
      parameterName,
      isLoading: true,
    });
    filePickerStates = filePickerStates;

    vscode.postMessage({
      type: 'selectFile',
      data: {
        parameterName: `__loadContents_${parameterName}`,
        filters: { 'All Files': ['*'] },
      },
    });
  }

  /**
   * Filter workflows based on search query
   * Also sorts favorited workflows to the top
   */
  function filterWorkflows() {
    let filtered: WorkflowDefinition[];
    if (!searchQuery.trim()) {
      filtered = workflows;
    } else {
      const query = searchQuery.toLowerCase();
      filtered = workflows.filter(
        (workflow) =>
          workflow.name.toLowerCase().includes(query) ||
          workflow.filename.toLowerCase().includes(query)
      );
    }

    // Sort: favorited workflows first, then alphabetically
    filteredWorkflows = filtered.sort((a, b) => {
      const aFav = isWorkflowFavorited(a.filename);
      const bFav = isWorkflowFavorited(b.filename);

      if (aFav && !bFav) {
        return -1;
      }
      if (!aFav && bFav) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Clear search
   */
  function clearSearch() {
    searchQuery = '';
    // Reset selection and inputs when clearing the selection
    selectedWorkflow = null;
    inputs = {};
    artifactPattern = '';
    // Collapse preset section when clearing workflow selection
    showPresets = false;
    filePickerStates.clear();
    filePickerStates = filePickerStates;
    filterWorkflows();
  }

  /**
   * Handle search input
   */
  function handleSearchInput() {
    filterWorkflows();
    dropdownOpen = true;
  }

  /**
   * Toggle dropdown
   */
  function toggleDropdown() {
    dropdownOpen = !dropdownOpen;
    if (dropdownOpen) {
      // Temporarily clear search to show all workflows when opening dropdown
      const previousQuery = searchQuery;
      searchQuery = '';
      filterWorkflows();
      // Restore the query to keep selected workflow name visible in input
      searchQuery = previousQuery;
    }
  }

  /**
   * Select workflow from dropdown
   */
  function selectWorkflowFromDropdown(workflow: WorkflowDefinition) {
    searchQuery = workflow.name;
    dropdownOpen = false;
    // Collapse preset section when switching workflows for a clean view
    showPresets = false;
    vscode.postMessage({ type: 'getWorkflowSchema', data: workflow.filename });
    // Request current branch when workflow is selected
    vscode.postMessage({ type: 'getCurrentBranch' });
  }

  /**
   * Close dropdown when clicking outside
   */
  function handleClickOutside(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('.combobox-container')) {
      dropdownOpen = false;
    }
  }

  /**
   * Open workflow runs panel
   */
  function openWorkflowRuns() {
    vscode.postMessage({
      type: 'openWorkflowRuns',
      data: { actorFilter: 'all' },
    });
  }

  /**
   * Open the last dispatched workflow run
   */
  function openLastRun() {
    // If a workflow is selected, filter to show only that workflow
    // If no workflow is selected, show all workflows with "All Users" filter
    if (selectedWorkflow) {
      vscode.postMessage({
        type: 'openWorkflowRuns',
        data: {
          workflowName: selectedWorkflow.filename, // Use filename for consistent comparison
          actorFilter: 'all', // Default to "All Users" for View Last Run
          showBotRuns: false, // Hide bot runs
        },
      });
    } else {
      // No workflow selected - open with "All Users" filter but no workflow filter
      vscode.postMessage({
        type: 'openWorkflowRuns',
        data: {
          actorFilter: 'all', // Default to "All Users" for View Last Run
          showBotRuns: false, // Hide bot runs
        },
      });
    }
  }

  /**
   * Clear all input fields and reset to default values
   */
  function clearFields() {
    if (!selectedWorkflow) {
      return;
    }

    // Reset all inputs to their default values
    inputs = {};
    selectedWorkflow.inputs.forEach((input) => {
      if (input.default !== undefined) {
        inputs[input.name] = String(input.default);
      } else {
        inputs[input.name] = '';
      }
    });

    // Clear file picker states
    filePickerStates.clear();
    filePickerStates = filePickerStates;

    // Reset smart input force modes to text (default mode)
    smartFileInputForceMode.clear();
    smartFileInputForceMode = smartFileInputForceMode;

    // Clear smart input errors
    smartFileInputErrors.clear();
    smartFileInputErrors = smartFileInputErrors;
  }

  /**
   * Check if an input should show the file loader button
   * Show for string/text inputs whose description suggests key=value pairs or structured data
   */
  function shouldShowFileLoader(input: any): boolean {
    // Must be string or text type
    if (input.type !== 'string' && input.type !== 'text') {
      return false;
    }

    const description = (input.description || '').toLowerCase();

    const keywords = [
      'comma-separated',
      'comma separated',
      'key=value',
      'key-value',
      'key value',
      'json',
      'yaml',
      'semicolon',
      'delimiter',
      'delimited',
      'list of',
      'array of',
      'env',
      'environment',
      'parameters',
      'params',
    ];

    const hasKeyword = keywords.some((keyword) => description.includes(keyword));

    // Detect patterns like key=value, KEY=VALUE, foo=bar separated by comma/space/semicolon
    const keyValuePattern = /(?:^|[\s,;])[^\s,;=]+\s*=\s*[^\s,;=]+/i;

    return hasKeyword || keyValuePattern.test(description);
  }

  // ============================================
  // SmartFileInput handlers
  // ============================================

  /**
   * Request SmartFileInput data for an input field
   */
  function requestSmartFileInputData(inputName: string) {
    if (!selectedWorkflow) return;

    vscode.postMessage({
      type: 'getSmartFileInputData',
      data: {
        repoOwner,
        repoName,
        workflowPath: selectedWorkflow.filename,
        inputName,
      },
    });
  }

  /**
   * Handle SmartFileInput value change
   */
  function handleSmartInputChange(inputName: string, value: string) {
    inputs[inputName] = value;
    inputs = inputs;
    clearError();
  }

  /**
   * Handle SmartFileInput browse file request
   */
  function handleSmartInputBrowse(inputName: string, mode: 'path' | 'content') {
    smartFileInputLoading.set(inputName, true);
    smartFileInputLoading = smartFileInputLoading;

    vscode.postMessage({
      type: 'selectFile',
      data: {
        parameterName: inputName,
        mode,
      },
    });
  }

  /**
   * Handle SmartFileInput load content request
   */
  function handleSmartInputLoadContent(inputName: string, path: string) {
    if (!selectedWorkflow) return;

    fileContentModalInputName = inputName;
    fileContentModalFilePath = path;
    fileContentModalLoading = true;
    fileContentModalError = null;
    fileContentModalParsedContent = null;
    fileContentModalPreSelectedValues = []; // Clear pre-selected values for fresh load
    showFileContentModal = true;

    vscode.postMessage({
      type: 'parseFileForSelection',
      data: {
        path,
        inputName,
      },
    });
  }

  /**
   * Handle SmartFileInput add favorite - shows a prompt for label (display name)
   */
  async function handleSmartInputAddFavorite(inputName: string, path: string, label?: string) {
    if (!selectedWorkflow) return;

    // Extract filename without extension for default display
    // Handle dotfiles (like .gitignore) by not stripping extension if name starts with dot
    const fileName = path.split('/').pop() || path;
    const fileNameWithoutExt = fileName.startsWith('.')
      ? fileName // Keep dotfiles as-is (e.g., .gitignore stays .gitignore)
      : fileName.replace(/\.[^/.]+$/, '') || fileName;

    // Prompt for label only if not provided - explain that leaving blank uses filename
    const finalLabel =
      label ??
      (await showInputPrompt(
        `Label for "${fileName}" (optional):`,
        '',
        `Leave blank to use "${fileNameWithoutExt}"`
      ));

    // Convert empty string to undefined to use default display
    const nickname = finalLabel?.trim() || undefined;

    vscode.postMessage({
      type: 'addFileFavorite',
      data: {
        repoOwner,
        repoName,
        workflowPath: selectedWorkflow.filename,
        inputName,
        relativePath: path,
        absolutePath: path, // Will be resolved on extension side
        nickname, // Keep 'nickname' in message for backward compatibility
      },
    });
  }

  /**
   * Handle SmartFileInput remove favorite
   */
  function handleSmartInputRemoveFavorite(inputName: string, favoriteId: string) {
    if (!selectedWorkflow) return;

    vscode.postMessage({
      type: 'removeFileFavorite',
      data: {
        repoOwner,
        repoName,
        workflowPath: selectedWorkflow.filename,
        inputName,
        favoriteId,
      },
    });
  }

  /**
   * Handle SmartFileInput track recent file
   */
  function handleSmartInputTrackRecent(
    inputName: string,
    path: string,
    config?: FileContentConfig,
    mode?: 'path' | 'content'
  ) {
    if (!selectedWorkflow) return;

    vscode.postMessage({
      type: 'trackRecentFile',
      data: {
        repoOwner,
        repoName,
        workflowPath: selectedWorkflow.filename,
        inputName,
        relativePath: path,
        absolutePath: path,
        config,
        mode,
      },
    });
  }

  /**
   * Handle SmartFileInput request suggestions
   */
  function handleSmartInputRequestSuggestions(inputName: string, partialPath: string) {
    vscode.postMessage({
      type: 'getFileSuggestions',
      data: {
        partialPath,
        inputName,
      },
    });
  }

  /**
   * Handle SmartFileInput open file in editor
   */
  function handleSmartInputOpenFile(path: string) {
    vscode.postMessage({
      type: 'openFileInEditor',
      data: { path },
    });
  }

  /**
   * Handle SmartFileInput preview/edit request
   * Detects delimiters and shows list mode if multiple values found
   */
  function handleSmartInputShowPreview(inputName: string, value: string) {
    previewModalInputName = inputName;
    previewModalValue = value;
    previewModalNewItemValue = '';
    previewModalShowFavorites = false;

    // Load value favorites for this input
    const storageKey = `${repoOwner}/${repoName}/${selectedWorkflow?.filename}/${inputName}`;
    const storedFavorites = smartFileInputValueFavorites.get(storageKey);
    previewModalValueFavorites = storedFavorites || [];

    // Detect delimiter and parse into items
    let detectedDelimiter = ',';
    let detectedName = 'Comma';
    let items: string[] = [];

    for (const { delimiter, name } of DELIMITER_PATTERNS) {
      const parts = value
        .split(delimiter)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (parts.length > 1) {
        detectedDelimiter = delimiter;
        detectedName = name;
        items = parts;
        break;
      }
    }

    previewModalDelimiter = detectedDelimiter;
    previewModalDelimiterName = detectedName;
    if (items.length > 1) {
      previewModalItems = items.map((v) => ({ value: v, selected: true }));
      previewModalMode = 'list';
    } else {
      // For single value, create a single-item list so user can switch to list mode
      const trimmedValue = value.trim();
      previewModalItems = trimmedValue ? [{ value: trimmedValue, selected: true }] : [];
      previewModalMode = 'text';
    }

    showPreviewModal = true;
  }

  /**
   * Handle preview modal save
   */
  function handlePreviewModalSave(newValue: string) {
    inputs[previewModalInputName] = newValue;
    inputs = inputs;
    showPreviewModal = false;
  }

  /**
   * Handle preview modal save from list mode
   */
  function handlePreviewModalSaveList() {
    const selectedValues = previewModalItems
      .filter((item) => item.selected)
      .map((item) => item.value);
    const delimiter = previewModalDelimiter === '\n' ? '\n' : previewModalDelimiter;
    const newValue = selectedValues.join(delimiter);
    handlePreviewModalSave(newValue);
  }

  /**
   * Toggle preview modal item selection
   */
  function togglePreviewModalItem(index: number) {
    previewModalItems[index].selected = !previewModalItems[index].selected;
    previewModalItems = previewModalItems;
  }

  /**
   * Select all preview modal items
   */
  function selectAllPreviewModalItems() {
    previewModalItems = previewModalItems.map((item) => ({ ...item, selected: true }));
  }

  /**
   * Unselect all preview modal items
   */
  function unselectAllPreviewModalItems() {
    previewModalItems = previewModalItems.map((item) => ({ ...item, selected: false }));
  }

  /**
   * Add a new item to the preview modal list
   */
  function addPreviewModalItem() {
    const trimmedValue = previewModalNewItemValue.trim();
    if (!trimmedValue) return;

    // Check if item already exists
    if (previewModalItems.some((item) => item.value === trimmedValue)) {
      showToast('Item already exists in the list', 'warning');
      return;
    }

    previewModalItems = [...previewModalItems, { value: trimmedValue, selected: true }];
    previewModalNewItemValue = '';
  }

  /**
   * Remove an item from the preview modal list
   */
  function removePreviewModalItem(index: number) {
    previewModalItems = previewModalItems.filter((_, i) => i !== index);
  }

  /**
   * Add current item to value favorites for this input
   */
  function addToValueFavorites(value: string) {
    if (!value.trim()) return;

    // Check if already in favorites
    if (previewModalValueFavorites.some((f) => f.value === value)) {
      showToast('Value already in favorites', 'warning');
      return;
    }

    const newFavorite = { value, addedAt: Date.now() };
    previewModalValueFavorites = [...previewModalValueFavorites, newFavorite];

    // Save to storage
    vscode.postMessage({
      type: 'saveValueFavorites',
      data: {
        repoOwner,
        repoName,
        workflowPath: selectedWorkflow?.filename,
        inputName: previewModalInputName,
        favorites: previewModalValueFavorites,
      },
    });

    showToast('Added to favorites', 'success');
  }

  /**
   * Remove item from value favorites
   */
  function removeFromValueFavorites(value: string) {
    previewModalValueFavorites = previewModalValueFavorites.filter((f) => f.value !== value);

    // Save to storage
    vscode.postMessage({
      type: 'saveValueFavorites',
      data: {
        repoOwner,
        repoName,
        workflowPath: selectedWorkflow?.filename,
        inputName: previewModalInputName,
        favorites: previewModalValueFavorites,
      },
    });
  }

  /**
   * Add a favorite value to the current list
   */
  function addFavoriteToList(value: string) {
    if (previewModalItems.some((item) => item.value === value)) {
      showToast('Item already in list', 'warning');
      return;
    }
    previewModalItems = [...previewModalItems, { value, selected: true }];
  }

  /**
   * Handle switching from List mode to Text mode in preview modal.
   * Syncs the list items to the text value using the selected delimiter.
   */
  function handlePreviewModalSwitchToText() {
    // Join list items using the selected delimiter and update previewModalValue
    const selectedValues = previewModalItems
      .filter((item) => item.selected)
      .map((item) => item.value);
    const delimiter = previewModalDelimiter === '\n' ? '\n' : previewModalDelimiter;
    previewModalValue = selectedValues.join(delimiter);
    previewModalMode = 'text';
  }

  /**
   * Handle preview modal close
   */
  function handlePreviewModalClose() {
    showPreviewModal = false;
    previewModalMode = 'text';
    previewModalItems = [];
    previewModalNewItemValue = '';
    previewModalShowFavorites = false;
  }

  /**
   * Handle SmartFileInput reload from file with saved config
   * Opens the FileContentModal with the saved configuration pre-applied
   */
  function handleSmartInputReloadFromFile(
    inputName: string,
    path: string,
    config: FileContentConfig
  ) {
    fileContentModalInputName = inputName;
    fileContentModalFilePath = path;
    fileContentModalLoading = true;
    fileContentModalError = null;
    fileContentModalParsedContent = null;
    // Issue 9: Set pre-selected values from saved config
    fileContentModalPreSelectedValues = config.selectedValues || [];
    showFileContentModal = true;

    // Send message to parse file content with the saved config
    vscode.postMessage({
      type: 'parseFileForSelection',
      data: {
        path,
        inputName,
        config: {
          jsonExtractionMode: config.jsonExtractionMode,
          jsonSpecificKey: config.jsonSpecificKey,
          jsonArrayPath: config.jsonArrayPath,
        },
      },
    });
  }

  /**
   * Handle FileContentModal confirm
   */
  function handleFileContentModalConfirm(values: string[], config: FileContentConfig) {
    // Join values with the configured delimiter
    let delimiter = ',';
    switch (config.delimiter) {
      case 'pipe':
        delimiter = '|';
        break;
      case 'newline':
        delimiter = '\n';
        break;
      case 'space':
        delimiter = ' ';
        break;
      case 'custom':
        delimiter = config.customDelimiter || ',';
        break;
    }

    const joinedValue = values.join(delimiter);
    inputs[fileContentModalInputName] = joinedValue;
    inputs = inputs;

    // Issue 9: Save selected values in config for reload
    const configWithSelectedValues: FileContentConfig = {
      ...config,
      selectedValues: values,
    };

    // Track as recent file with the config used (including selected values) and content mode
    handleSmartInputTrackRecent(
      fileContentModalInputName,
      fileContentModalFilePath,
      configWithSelectedValues,
      'content'
    );

    // Reset mode to text after content is loaded
    smartFileInputForceMode.set(fileContentModalInputName, 'text');
    smartFileInputForceMode = smartFileInputForceMode;
    // Clear force mode after a tick so component can react
    setTimeout(() => {
      smartFileInputForceMode.set(fileContentModalInputName, null);
      smartFileInputForceMode = smartFileInputForceMode;
    }, 50);

    showFileContentModal = false;
    fileContentModalParsedContent = null;
  }

  /**
   * Handle FileContentModal close
   */
  function handleFileContentModalClose() {
    showFileContentModal = false;
    fileContentModalParsedContent = null;
    fileContentModalError = null;
    fileContentModalPreSelectedValues = []; // Clear pre-selected values
  }

  /**
   * Handle FileContentModal extraction mode change - re-parse with new mode
   */
  function handleFileContentModalExtractionModeChange(
    mode: string,
    key?: string,
    arrayPath?: string
  ) {
    // Re-request parsing with new extraction mode
    vscode.postMessage({
      type: 'parseFileForSelection',
      data: {
        path: fileContentModalFilePath,
        inputName: fileContentModalInputName,
        config: {
          jsonExtractionMode: mode,
          jsonSpecificKey: key,
          jsonArrayPath: arrayPath,
        },
      },
    });
    fileContentModalLoading = true;
  }

  /**
   * Check if input should use SmartFileInput (all string types)
   */
  function shouldUseSmartFileInput(input: any): boolean {
    return input.type === 'string' || input.type === 'text';
  }
</script>

<div class="container">
  {#if !authenticated}
    <div class="auth-section">
      <h3>GitHub Authentication Required</h3>
      <p>Please authenticate with GitHub to use this extension.</p>
      <button on:click={handleAuthenticate}>Authenticate</button>
    </div>
  {:else}
    <div class="workflow-section">
      <!-- Welcome Header -->
      <div class="welcome-header">
        {#if userInfo}
          <div class="welcome-message">
            <div class="icon-container">
              <span
                class="wave-emoji"
                class:wave-emoji--animated={showWelcomeWave}
                class:fade-out={showGitHubIcon}>👋</span
              >
              <span
                class="codicon codicon-mark-github github-icon"
                class:fade-in={showGitHubIcon}
                title="GitHub"
                aria-label="GitHub"
              ></span>
            </div>
            <div class="welcome-text">
              <span class="welcome-greeting">Welcome,</span>
              <span class="welcome-username">{userInfo.login}!</span>
            </div>
          </div>
        {:else}
          <div class="welcome-message">
            <div class="icon-container">
              <span
                class="wave-emoji"
                class:wave-emoji--animated={showWelcomeWave}
                class:fade-out={showGitHubIcon}>👋</span
              >
              <span
                class="codicon codicon-mark-github github-icon"
                class:fade-in={showGitHubIcon}
                title="GitHub"
                aria-label="GitHub"
              ></span>
            </div>
            <span class="welcome-greeting">Welcome!</span>
          </div>
        {/if}
        <button class="sign-out-button" on:click={handleSignOut} title="Sign out from GitHub">
          <span class="codicon codicon-sign-out"></span>
          <span>Sign Out</span>
        </button>
      </div>

      <!-- Repository Information Section (Simplified) -->
      <div class="repo-info-section">
        <div class="repo-info-header">
          <span class="repo-info-title">Git Context</span>
          <div class="repo-info-actions">
            <button
              class="icon-button-small"
              on:click={showReloadInfoModal}
              title="Learn about reload functionality"
              type="button"
              aria-label="Learn about reload functionality"
            >
              <span class="codicon codicon-info"></span>
            </button>
            <button
              class="icon-button-small reload-button"
              class:spinning={isReloading}
              on:click={handleReloadExtensionData}
              disabled={isReloading}
              title="Reload extension data (re-detect repository and branch)"
              type="button"
              aria-label="Reload extension data"
            >
              <span class="codicon codicon-refresh"></span>
            </button>
          </div>
        </div>
        <div class="repo-info-row">
          <span class="repo-info-label">
            <span class="codicon codicon-repo"></span>
          </span>
          <span
            class="repo-info-value"
            title={repoOwner && repoName ? `${repoOwner}/${repoName}` : 'Repository not configured'}
          >
            {repoName || '(not configured)'}
          </span>
        </div>
        <div class="repo-info-row">
          <span class="repo-info-label" title="Local Git branch">
            <span class="codicon codicon-git-branch"></span>
          </span>
          <span
            class="repo-info-value"
            title={currentBranch
              ? `Local Git branch: ${currentBranch}`
              : 'No local Git branch detected'}
          >
            <span class="branch-type">Local</span>
            {currentBranch || '(no Git branch)'}
          </span>
        </div>
        <div class="repo-info-row">
          <span class="repo-info-label" title="Branch used for workflow runs">
            <span class="codicon codicon-rocket"></span>
          </span>
          <span
            class="repo-info-value"
            title={branch ? `Workflow branch: ${branch}` : 'No workflow branch selected'}
          >
            <span class="branch-type">Workflow</span>
            {branch || '(no branch selected)'}
          </span>
        </div>
      </div>

      <!-- View Run Button -->
      <button class="view-run-button" on:click={openWorkflowRuns} title="View workflow runs">
        <span class="codicon codicon-graph"></span>
        <span>View Workflow Runs</span>
      </button>

      <div class="section-header">
        <h3>Dispatch Workflow</h3>
        <button
          class="info-icon clickable"
          on:click={showHelpModal}
          title="Help & Information"
          type="button"
        >
          <span class="codicon codicon-info"></span>
        </button>
      </div>

      {#if error}
        <div class="error">{error}</div>
      {/if}

      <!-- Searchable Combobox for Workflows -->
      <div class="form-group">
        <label for="workflow-search">Select Workflow</label>
        <div class="combobox-container">
          <div class="combobox-input-wrapper">
            <input
              id="workflow-search"
              type="text"
              placeholder="Select workflow – type to search"
              bind:value={searchQuery}
              on:input={(e) => {
                handleSearchInput(e);
                clearError();
              }}
              on:focus={() => {
                dropdownOpen = true;
                // Show all workflows on open while keeping selected text visible
                const previousQuery = searchQuery;
                searchQuery = '';
                filterWorkflows();
                // Restore the query to preserve the selected workflow name in the input
                searchQuery = previousQuery;
              }}
              disabled={loading}
              autocomplete="off"
            />
            <button
              class="dropdown-toggle"
              on:click={toggleDropdown}
              title={dropdownOpen ? 'Close dropdown' : 'Open dropdown'}
              disabled={loading}
            >
              {dropdownOpen ? '▲' : '▼'}
            </button>
            {#if searchQuery}
              <button class="clear-button" on:click={clearSearch} title="Clear search">✕</button>
            {/if}
          </div>

          {#if dropdownOpen && workflows.length > 0}
            <div class="dropdown-list" transition:slide={{ duration: 200 }}>
              {#if filteredWorkflows.length > 0}
                {#each filteredWorkflows as workflow (workflow.filename)}
                  <div
                    class="dropdown-item"
                    on:click={() => selectWorkflowFromDropdown(workflow)}
                    role="option"
                    aria-selected="false"
                    tabindex="0"
                    on:keypress={(e) => e.key === 'Enter' && selectWorkflowFromDropdown(workflow)}
                  >
                    <div class="workflow-info">
                      <div class="workflow-name">{workflow.name}</div>
                      <div class="workflow-filename">{workflow.filename}</div>
                    </div>
                    <button
                      class="favorite-star"
                      on:click={(e) => toggleWorkflowFavorite(workflow, e)}
                      title={isWorkflowFavorited(workflow.filename)
                        ? 'Remove from favorites'
                        : 'Add to favorites'}
                      aria-label={isWorkflowFavorited(workflow.filename)
                        ? 'Remove from favorites'
                        : 'Add to favorites'}
                    >
                      {isWorkflowFavorited(workflow.filename) ? '★' : '☆'}
                    </button>
                  </div>
                {/each}
              {:else}
                <div class="dropdown-item no-results">
                  No workflows found matching "{searchQuery}"
                </div>
              {/if}
            </div>
          {/if}

          {#if workflows.length > 0}
            <div class="search-results">
              {#if selectedWorkflow}
                Showing 1 of {workflows.length} workflow{workflows.length !== 1 ? 's' : ''}
              {:else if searchQuery}
                Showing {filteredWorkflows.length} of {workflows.length} workflow{workflows.length !==
                1
                  ? 's'
                  : ''}
              {:else}
                {workflows.length} workflow{workflows.length !== 1 ? 's' : ''} available
              {/if}
            </div>
          {/if}
        </div>
      </div>

      {#if selectedWorkflow}
        <div class="workflow-actions">
          <button
            type="button"
            class="icon-button secondary"
            on:click={handleReloadWorkflowInputs}
            disabled={loading || reloadingInputs}
            title="Reload workflow inputs from file"
            aria-label="Reload workflow inputs from file"
          >
            <span class="codicon codicon-refresh"></span>
          </button>
          <button
            type="button"
            class="icon-button secondary"
            on:click={handleOpenWorkflowFile}
            disabled={loading}
            title="Open workflow file in editor"
            aria-label="Open workflow file in editor"
          >
            <span class="codicon codicon-go-to-file"></span>
          </button>
          <button
            type="button"
            class="presets-toggle-button"
            class:expanded={showPresets}
            on:click={() => (showPresets = !showPresets)}
            disabled={loading}
            title={showPresets ? 'Hide presets' : 'Show presets'}
            aria-label={showPresets ? 'Hide presets' : 'Show presets'}
            aria-expanded={showPresets}
          >
            <span class="codicon codicon-bookmark"></span>
            <span class="presets-button-label">Presets</span>
            <span
              class="codicon presets-chevron"
              class:codicon-chevron-down={showPresets}
              class:codicon-chevron-right={!showPresets}
            ></span>
          </button>
        </div>
      {/if}

      <!-- Presets Section (expandable) -->
      {#if selectedWorkflow && showPresets}
        <div class="presets-expandable-section" transition:slide>
          <div class="presets-header">
            <h4>Presets</h4>
            <button
              type="button"
              class="info-icon clickable"
              on:click={showPresetsHelp}
              title="Learn about presets"
            >
              <span class="codicon codicon-info"></span>
            </button>
          </div>
          <div class="presets-content">
            <!-- Row 1: Load dropdown + Save button -->
            <div class="presets-actions">
              <select
                aria-label="Load preset"
                bind:value={selectedTemplateId}
                on:change={onSelectTemplate}
              >
                <option value="">Load preset...</option>
                {#each templates as t (t.id)}
                  <option value={t.id}>{t.name}</option>
                {/each}
              </select>
              <button
                type="button"
                class="secondary"
                on:click={saveCurrentAsTemplate}
                title="Save current inputs as a preset"
              >
                <span class="codicon codicon-save"></span>
                <span>Save preset</span>
              </button>
            </div>
            <!-- Row 2: Manage buttons (only when preset is selected) -->
            {#if selectedTemplateId}
              <div class="preset-manage">
                <button
                  type="button"
                  class="secondary"
                  on:click={renameSelectedTemplate}
                  title="Rename selected preset">📝 Rename</button
                >
                <button
                  type="button"
                  class="secondary"
                  on:click={exportSelectedPreset}
                  title="Export selected preset to JSON file"
                >
                  <span class="codicon codicon-export"></span>
                  <span>Export</span>
                </button>
                <button
                  type="button"
                  class="danger"
                  on:click={deleteSelectedTemplate}
                  title="Delete selected preset">🗑️ Delete</button
                >
              </div>
            {/if}
            <!-- Row 3: Import + Storage Info -->
            <div class="preset-import-section">
              <button
                type="button"
                class="secondary"
                on:click={importPresetFromFile}
                title="Import preset from JSON file"
              >
                <span class="codicon codicon-cloud-download"></span>
                <span>Import from File</span>
              </button>
              <button
                type="button"
                class="secondary"
                on:click={showStorageInfo}
                title="Show where presets are stored"
              >
                <span class="codicon codicon-info"></span>
                <span>Storage Info</span>
              </button>
            </div>
          </div>
        </div>
      {/if}

      {#if selectedWorkflow}
        <div class="form-group">
          <label for="branch">Branch</label>
          <div class="input-with-button">
            <input
              id="branch"
              type="text"
              bind:value={branch}
              on:input={clearError}
              placeholder="e.g., develop, main"
              disabled={loading}
            />
            {#if defaultBranch}
              <button
                type="button"
                class="icon-button secondary branch-helper"
                on:click={() => applyBranchHelper(defaultBranch)}
                disabled={loading}
                title={`Use default branch: ${defaultBranch}`}
                aria-label={`Use default branch: ${defaultBranch}`}
              >
                <span class="codicon codicon-git-branch"></span>
              </button>
            {/if}
            {#if currentBranch && currentBranch !== defaultBranch}
              <button
                type="button"
                class="icon-button secondary branch-helper"
                on:click={() => currentBranch && applyBranchHelper(currentBranch)}
                disabled={loading}
                title={`Use current local branch: ${currentBranch}`}
                aria-label={`Use current local branch: ${currentBranch}`}
              >
                <span class="codicon codicon-git-branch-changes"></span>
              </button>
            {/if}
          </div>
        </div>

        {#if selectedWorkflow.inputs.length > 0}
          <h4>Inputs</h4>
          {#each selectedWorkflow.inputs as input (input.name)}
            <div class="form-group">
              <label for={input.name} class="input-label">
                <span class="input-name">{input.name}</span>
                {#if input.required}
                  <span class="required">*</span>
                {/if}
              </label>
              {#if input.description}
                <p class="description">{input.description}</p>
              {/if}

              {#if input.type === 'boolean'}
                <input
                  id={input.name}
                  type="checkbox"
                  bind:checked={inputs[input.name]}
                  on:change={clearError}
                  disabled={loading}
                />
              {:else if input.type === 'choice' && input.options}
                <select
                  id={input.name}
                  bind:value={inputs[input.name]}
                  on:change={clearError}
                  disabled={loading}
                >
                  {#each input.options as option (option)}
                    <option value={option}>{option}</option>
                  {/each}
                </select>
              {:else if input.type === 'number'}
                <input
                  id={input.name}
                  type="number"
                  bind:value={inputs[input.name]}
                  on:input={clearError}
                  disabled={loading}
                />
              {:else if shouldUseSmartFileInput(input)}
                <!-- SmartFileInput for all string-type inputs -->
                <SmartFileInput
                  inputName={input.name}
                  value={inputs[input.name] || ''}
                  placeholder={input.default ? String(input.default) : ''}
                  disabled={loading}
                  required={input.required}
                  recentFiles={smartFileInputData.get(input.name)?.recentFiles || []}
                  favorites={smartFileInputData.get(input.name)?.favorites || []}
                  suggestions={smartFileInputSuggestions.get(input.name) || []}
                  isLoading={smartFileInputLoading.get(input.name) || false}
                  error={smartFileInputErrors.get(input.name) || null}
                  forceMode={smartFileInputForceMode.get(input.name) || null}
                  on:change={(e) => handleSmartInputChange(input.name, e.detail.value)}
                  on:browseFile={(e) => handleSmartInputBrowse(input.name, e.detail.mode)}
                  on:loadContent={(e) => handleSmartInputLoadContent(input.name, e.detail.path)}
                  on:addFavorite={(e) =>
                    handleSmartInputAddFavorite(input.name, e.detail.path, e.detail.nickname)}
                  on:removeFavorite={(e) => handleSmartInputRemoveFavorite(input.name, e.detail.id)}
                  on:openFile={(e) => handleSmartInputOpenFile(e.detail.path)}
                  on:requestSuggestions={(e) =>
                    handleSmartInputRequestSuggestions(input.name, e.detail.partialPath)}
                  on:trackRecent={(e) =>
                    handleSmartInputTrackRecent(
                      input.name,
                      e.detail.path,
                      undefined,
                      e.detail.mode
                    )}
                  on:showPreview={(e) => handleSmartInputShowPreview(input.name, e.detail.value)}
                  on:reloadFromFile={(e) =>
                    handleSmartInputReloadFromFile(input.name, e.detail.path, e.detail.config)}
                  on:showInfo={(e) => showInfoModal_func(e.detail.title, e.detail.content)}
                />
              {:else}
                <input
                  id={input.name}
                  type="text"
                  bind:value={inputs[input.name]}
                  on:input={clearError}
                  placeholder={input.default ? String(input.default) : ''}
                  disabled={loading}
                />
              {/if}
            </div>
          {/each}
        {/if}

        <!-- Advanced Configuration -->
        {#if selectedWorkflow}
          <div class="advanced-config-section">
            <button
              type="button"
              class="config-toggle"
              on:click={() => (showAdvancedConfig = !showAdvancedConfig)}
              title={showAdvancedConfig
                ? 'Hide advanced configuration'
                : 'Show advanced configuration'}
            >
              <span
                class={`codicon ${
                  showAdvancedConfig ? 'codicon-chevron-down' : 'codicon-chevron-right'
                } config-toggle-icon`}
              ></span>
              <span>
                {showAdvancedConfig ? 'Hide' : 'Show'} Advanced Configuration
              </span>
            </button>

            {#if showAdvancedConfig}
              <div class="config-content" transition:slide>
                <!-- Artifact Pattern Configuration -->
                <div class="form-group">
                  <label for="artifact-pattern">
                    Artifact Pattern for Parameter Recovery
                    <button
                      type="button"
                      class="info-icon clickable"
                      on:click={showArtifactPatternHelp}
                      title="Open help about artifact pattern for parameter recovery"
                    >
                      <span class="codicon codicon-info"></span>
                    </button>
                  </label>
                  <div class="input-with-button">
                    <input
                      id="artifact-pattern"
                      type="text"
                      bind:value={artifactPattern}
                      placeholder="*parameter*"
                      disabled={loading}
                      on:input={() => {
                        // mark dirty on change
                        artifactPatternDirty = artifactPattern !== artifactPatternSavedValue;
                        if (artifactPatternSaveTimeout) {
                          clearTimeout(artifactPatternSaveTimeout);
                        }
                        artifactPatternSaveTimeout = window.setTimeout(() => {
                          if (artifactPatternDirty) {
                            saveArtifactPattern();
                          }
                        }, 800);
                      }}
                    />
                    <button
                      type="button"
                      class="secondary icon-only artifact-pattern-save-button"
                      class:artifact-pattern-saved={artifactPatternJustSaved}
                      on:click={saveArtifactPattern}
                      disabled={loading ||
                        artifactPatternSaving ||
                        !selectedWorkflow ||
                        !artifactPatternDirty}
                      title={artifactPatternSaving
                        ? 'Saving...'
                        : artifactPatternJustSaved
                          ? 'Saved!'
                          : artifactPatternDirty
                            ? 'Save artifact pattern for this workflow'
                            : 'No changes to save'}
                    >
                      {#if artifactPatternJustSaved}
                        <span class="codicon codicon-pass-filled"></span>
                      {:else}
                        <span class="codicon codicon-save"></span>
                      {/if}
                    </button>
                  </div>
                  <p class="hint">
                    Default: <code>*parameter*</code>. Use <code>*</code>
                    as wildcard (e.g., <code>my-params-*</code>) or full regex (e.g.,
                    <code>^workflow-inputs-.*$</code>). Pattern auto-saves after you stop typing.
                  </p>
                </div>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Watch List Checkbox -->
        {#if false}
          <!--
          The watch list opt-in has moved into the extension host
          confirmation modal for dispatch/rerun. This block is kept as a
          placeholder (never rendered) to avoid accidentally reintroducing
          a second, pre-dispatch checkbox in the sidebar UI.
        -->
          <div class="watch-list-checkbox-container">
            <label class="watch-list-checkbox-label">
              <input type="checkbox" disabled />
              <span>Add to watch list</span>
            </label>
          </div>
        {/if}

        <!-- Bottom Button Group -->
        {#if selectedWorkflow && branch}
          <div class="button-group">
            <button class="dispatch-button primary" on:click={handleSubmit} disabled={loading}>
              <span class="codicon codicon-rocket"></span>
              <span>{loading ? 'Dispatching...' : 'Dispatch Workflow'}</span>
            </button>
            <button
              class="clear-fields-button secondary"
              on:click={clearFields}
              disabled={loading}
              title="Reset all fields to default values"
            >
              <span class="codicon codicon-clear-all"></span>
              <span>Clear Fields</span>
            </button>
            <button
              class="view-last-run-button secondary"
              on:click={openLastRun}
              disabled={loading}
              title="View the most recently dispatched workflow run"
            >
              <span class="codicon codicon-eye"></span>
              <span>View Last Run</span>
            </button>
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- FileContentModal for SmartFileInput -->
  {#if showFileContentModal}
    <FileContentModal
      title="Select Content from File"
      filePath={fileContentModalFilePath}
      parsedContent={fileContentModalParsedContent}
      isLoading={fileContentModalLoading}
      error={fileContentModalError}
      preSelectedValues={fileContentModalPreSelectedValues}
      on:close={handleFileContentModalClose}
      on:confirm={(e) => handleFileContentModalConfirm(e.detail.values, e.detail.config)}
      on:changeExtractionMode={(e) =>
        handleFileContentModalExtractionModeChange(e.detail.mode, e.detail.key, e.detail.arrayPath)}
      on:showInfo={(e) => showInfoModal_func(e.detail.title, e.detail.content)}
    />
  {/if}

  <!-- Preview/Edit Modal for SmartFileInput -->
  {#if showPreviewModal}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div
      class="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-modal-title"
      on:click={handlePreviewModalClose}
      on:keydown={(e) => e.key === 'Escape' && handlePreviewModalClose()}
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="modal-content preview-modal" on:click|stopPropagation on:keydown={() => {}}>
        <div class="modal-header">
          <div class="modal-header-text">
            <h3 id="preview-modal-title">Preview/Edit Value</h3>
            <span class="modal-subtitle">{previewModalInputName}</span>
          </div>
          <div class="modal-header-actions">
            <button
              type="button"
              class="modal-info-btn"
              title="Learn more about Preview/Edit Value"
              on:click={() =>
                showInfoModal_func(
                  'Preview/Edit Value',
                  `
<h4>What is this?</h4>
<p>Preview and edit multi-value inputs. This modal helps you work with workflow parameters that contain multiple values.</p>

<h4>Features</h4>
<ul>
  <li><strong>Text Mode:</strong> Edit the raw value directly as text</li>
  <li><strong>List Mode:</strong> View and manage individual items in a list format</li>
  <li><strong>Select/Unselect:</strong> Toggle items on and off</li>
  <li><strong>Favorites:</strong> Save frequently used values for quick access</li>
</ul>

<h4>Supported Delimiters</h4>
<p>Values can be separated by: comma, pipe (|), newline, semicolon, or space.</p>
`
                )}
            >
              <span class="codicon codicon-info"></span>
            </button>
            <button
              type="button"
              class="modal-close-btn"
              on:click={handlePreviewModalClose}
              title="Close (Esc)"
            >
              <span class="codicon codicon-close"></span>
            </button>
          </div>
        </div>

        <!-- Mode toggle buttons - always show for single values too -->
        <div class="preview-mode-toggle">
          <button
            type="button"
            class="mode-btn"
            class:active={previewModalMode === 'text'}
            on:click={handlePreviewModalSwitchToText}
          >
            <span class="codicon codicon-edit"></span> Text
          </button>
          <button
            type="button"
            class="mode-btn"
            class:active={previewModalMode === 'list'}
            on:click={() => (previewModalMode = 'list')}
          >
            <span class="codicon codicon-list-selection"></span> List ({previewModalItems.length})
          </button>
        </div>

        {#if previewModalMode === 'text'}
          <textarea
            class="preview-textarea"
            bind:value={previewModalValue}
            placeholder="Enter value..."
          ></textarea>
          <div class="modal-buttons">
            <button type="button" on:click={() => handlePreviewModalSave(previewModalValue)}
              >Save</button
            >
            <button
              type="button"
              class="secondary"
              on:click={() => {
                previewModalValue = '';
                handlePreviewModalSave('');
              }}>Clear</button
            >
            <button type="button" class="secondary" on:click={handlePreviewModalClose}
              >Cancel</button
            >
          </div>
        {:else}
          <!-- List mode with multi-select -->
          <div class="preview-delimiter-row">
            <span class="delimiter-label">Join with:</span>
            <select
              class="delimiter-select"
              bind:value={previewModalDelimiter}
              on:change={(e) => {
                const selected = DELIMITER_OPTIONS.find(
                  (d) => d.delimiter === e.currentTarget.value
                );
                if (selected) previewModalDelimiterName = selected.name;
              }}
            >
              {#each DELIMITER_OPTIONS as opt (opt.delimiter)}
                <option value={opt.delimiter}>{opt.name} ({opt.display})</option>
              {/each}
            </select>
          </div>

          <!-- Add new item section -->
          <div class="preview-add-item-row">
            <input
              type="text"
              class="add-item-input"
              placeholder="Add new item..."
              bind:value={previewModalNewItemValue}
              on:keydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addPreviewModalItem();
                }
              }}
            />
            <button
              type="button"
              class="add-item-btn"
              on:click={addPreviewModalItem}
              disabled={!previewModalNewItemValue.trim()}
              title="Add new item to the list (Enter)"
            >
              <span class="codicon codicon-plus"></span>
            </button>
            <button
              type="button"
              class="favorites-toggle-btn"
              class:active={previewModalShowFavorites}
              on:click={() => (previewModalShowFavorites = !previewModalShowFavorites)}
              title={previewModalShowFavorites
                ? 'Hide saved favorites'
                : `Show saved favorites (${previewModalValueFavorites.length})`}
            >
              <span class="codicon codicon-star-full"></span>
              {#if previewModalValueFavorites.length > 0}
                <span class="favorites-count">{previewModalValueFavorites.length}</span>
              {/if}
            </button>
          </div>

          <!-- Favorites section (collapsible) -->
          {#if previewModalShowFavorites}
            <div class="preview-favorites-section">
              <div class="favorites-header">
                <span class="favorites-title">⭐ Favorite Values</span>
              </div>
              {#if previewModalValueFavorites.length === 0}
                <div class="favorites-empty">No favorites saved for this input</div>
              {:else}
                <div class="favorites-list">
                  {#each previewModalValueFavorites as fav (fav.value)}
                    {@const alreadyInList = previewModalItems.some(
                      (item) => item.value === fav.value
                    )}
                    <div class="favorite-item">
                      {#if !alreadyInList}
                        <button
                          type="button"
                          class="favorite-add-btn"
                          on:click={() => addFavoriteToList(fav.value)}
                          title="Add to list"
                        >
                          <span class="codicon codicon-plus"></span>
                        </button>
                      {:else}
                        <span class="favorite-in-list-badge" title="Already in list">
                          <span class="codicon codicon-check"></span>
                        </span>
                      {/if}
                      <span class="favorite-value" title={fav.value}>{fav.label || fav.value}</span>
                      <button
                        type="button"
                        class="favorite-remove-btn"
                        on:click={() => removeFromValueFavorites(fav.value)}
                        title="Remove from favorites"
                      >
                        <span class="codicon codicon-trash"></span>
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}

          <div class="preview-list-controls">
            <button
              type="button"
              class="control-btn"
              on:click={selectAllPreviewModalItems}
              disabled={previewModalItems.every((i) => i.selected)}
              title="Select all items in the list"
            >
              <span class="codicon codicon-check-all"></span> Select All
            </button>
            <button
              type="button"
              class="control-btn"
              on:click={unselectAllPreviewModalItems}
              disabled={previewModalItems.every((i) => !i.selected)}
              title="Unselect all items in the list"
            >
              <span class="codicon codicon-close-all"></span> Unselect All
            </button>
            <span class="selection-count">
              {previewModalItems.filter((i) => i.selected).length} of {previewModalItems.length} selected
            </span>
          </div>
          <div class="preview-list-items">
            {#each previewModalItems as item, index (item.value)}
              {@const isFavorite = previewModalValueFavorites.some((f) => f.value === item.value)}
              <div class="preview-list-item" class:selected={item.selected}>
                <input
                  type="checkbox"
                  checked={item.selected}
                  on:change={() => togglePreviewModalItem(index)}
                  title={item.selected ? 'Unselect this item' : 'Select this item'}
                />
                <span class="item-value" title={item.value}>{item.value}</span>
                <div class="item-actions">
                  {#if !isFavorite}
                    <button
                      type="button"
                      class="item-action-btn"
                      on:click={() => addToValueFavorites(item.value)}
                      title="Save to favorites"
                    >
                      <span class="codicon codicon-star-empty"></span>
                    </button>
                  {:else}
                    <span class="item-favorite-badge" title="Already in favorites">
                      <span class="codicon codicon-star-full"></span>
                    </span>
                  {/if}
                  <button
                    type="button"
                    class="item-action-btn delete-btn"
                    on:click={() => removePreviewModalItem(index)}
                    title="Remove this item from the list"
                  >
                    <span class="codicon codicon-trash"></span>
                  </button>
                </div>
              </div>
            {/each}
          </div>
          <div class="modal-buttons">
            <button type="button" on:click={handlePreviewModalSaveList}>Save</button>
            <button type="button" class="secondary" on:click={handlePreviewModalClose}
              >Cancel</button
            >
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Input Modal (replacement for window.prompt) -->
  {#if showInputModal}
    <div class="modal-overlay" on:click={handleInputModalCancel}>
      <div class="modal-content" on:click|stopPropagation>
        <h3>{inputModalTitle}</h3>
        <input
          type="text"
          bind:value={inputModalValue}
          placeholder={inputModalPlaceholder}
          on:keydown={(e) => {
            if (e.key === 'Enter') {
              handleInputModalConfirm();
            }
            if (e.key === 'Escape') {
              handleInputModalCancel();
            }
          }}
          autofocus
        />
        <div class="modal-buttons">
          <button type="button" on:click={handleInputModalConfirm}>OK</button>
          <button type="button" class="secondary" on:click={handleInputModalCancel}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Confirmation Modal -->
  {#if showConfirmModal}
    <div class="modal-overlay" on:click={handleConfirmModalCancel}>
      <div class="modal-content confirm-modal" on:click|stopPropagation>
        <h3>{confirmModalTitle}</h3>
        {#if confirmModalMode === 'dispatch'}
          <div class="modal-subtitle">
            <span>Review parameters before dispatching this workflow.</span>
            {#if dispatchConfirmBranch}
              <span class="modal-branch-pill">
                <span class="codicon codicon-git-branch"></span>
                <span>{dispatchConfirmBranch}</span>
              </span>
            {/if}
          </div>
          {#if Object.keys(dispatchConfirmInputs).length === 0}
            <p class="parameters-empty">This workflow has no inputs.</p>
          {:else}
            <div class="parameters-list">
              {#each Object.entries(dispatchConfirmInputs) as [key, value] (key)}
                <div class="parameter-row">
                  <div class="parameter-key">{key}</div>
                  <div class="parameter-value">
                    <pre>{formatParameterValue(value)}</pre>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
          <div class="modal-buttons">
            <button type="button" class="secondary" on:click={handleConfirmModalCancel}>
              Cancel
            </button>
            <button
              type="button"
              class="secondary"
              on:click={() => {
                vscode.postMessage({
                  type: 'confirmDispatchResult',
                  data: {
                    confirmed: true,
                    addToWatchList: false,
                  },
                });
                showConfirmModal = false;
                confirmModalMode = 'generic';
                dispatchConfirmBranch = '';
                dispatchConfirmInputs = {};
              }}
            >
              Dispatch
            </button>
            <button
              type="button"
              class="primary"
              on:click={() => {
                vscode.postMessage({
                  type: 'confirmDispatchResult',
                  data: {
                    confirmed: true,
                    addToWatchList: true,
                  },
                });
                showConfirmModal = false;
                confirmModalMode = 'generic';
                dispatchConfirmBranch = '';
                dispatchConfirmInputs = {};
              }}
            >
              Dispatch &amp; watch run
            </button>
          </div>
        {:else}
          <p class="confirm-message">{confirmModalMessage}</p>
          <div class="modal-buttons">
            {#each confirmModalButtons as button (button.value)}
              <button
                type="button"
                class={button.primary ? 'primary' : 'secondary'}
                on:click={() => handleConfirmModalClick(button.value)}
              >
                {button.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Info Modal -->
  {#if showInfoModal}
    <div class="modal-overlay" on:click={closeInfoModal}>
      <div class="modal-content info-modal" on:click|stopPropagation>
        <h3>{infoModalTitle}</h3>
        <div class="info-content" on:click={handleInfoModalClick}>
          {@html infoModalContent}
        </div>
        <div class="modal-buttons">
          <button type="button" class="primary" on:click={closeInfoModal}> Got it </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Toast notifications -->
  {#if toasts.length > 0}
    <div class="toast-container">
      {#each toasts as t (t.id)}
        <div
          class="toast toast-{t.type}"
          in:fly={{
            y: reduceMotion ? 0 : -12,
            duration: reduceMotion ? 0 : 220,
          }}
          out:fade={{ duration: reduceMotion ? 0 : 150 }}
        >
          <span class={`toast-icon codicon ${getToastIcon(t.type)} toast-icon--${t.type}`}></span>
          <span class="toast-message">{t.message}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .container {
    padding: 16px;
    height: 100vh;
    overflow-y: auto;
    overflow-x: hidden;
    min-width: 228px;
  }
  .auth-section,
  .workflow-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-bottom: 20px;
  }

  .sr-only {
    border: 0;
    clip: rect(0 0 0 0);
    height: 1px;
    margin: -1px;
    overflow: hidden;
    padding: 0;
    position: absolute;
    width: 1px;
    white-space: nowrap;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .input-with-button {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .input-with-button input {
    flex: 1;
  }

  .input-with-button button {
    flex-shrink: 0;
    height: 32px;
    padding: 6px 12px;
  }

  label {
    font-weight: 600;
    font-size: 13px;
  }

  .input-label {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .input-name {
    display: inline-flex;
    align-items: center;
    font-weight: 600;
    color: var(--vscode-foreground);
    font-size: 13px;
  }

  .required {
    color: var(--vscode-errorForeground);
  }

  .description {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin: 0;
  }

  input,
  select {
    padding: 6px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    transition:
      border-color 0.3s,
      box-shadow 0.3s,
      transform 0.2s;
  }

  input:focus,
  select:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    transform: scale(1.01);
  }

  button {
    padding: 8px 16px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition:
      background-color 0.3s,
      transform 0.2s;
  }

  button .codicon {
    line-height: 1;
  }

  button:hover {
    background: var(--vscode-button-hoverBackground);
    transform: translateY(-1px);
  }

  button:active {
    transform: scale(0.98);
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  /* Watch List Checkbox */
  .watch-list-checkbox-container {
    margin: 12px 0;
    padding: 8px 12px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
  }

  .watch-list-checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
  }

  .watch-list-checkbox-label input[type='checkbox'] {
    cursor: pointer;
    width: 16px;
    height: 16px;
  }

  .watch-list-checkbox-label span {
    flex: 1;
  }

  .watch-list-checkbox-label .info-icon {
    padding: 2px 4px;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    transition: color 0.2s;
  }

  .watch-list-checkbox-label .info-icon:hover {
    color: var(--vscode-textLink-foreground);
  }

  /* Button Group Layout */
  .button-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 16px;
  }

  .button-group button {
    width: 100%;
    padding: 10px 16px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .button-group .primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .button-group .primary:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .button-group .secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
  }

  .button-group .secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .dispatch-button {
    margin-top: 12px;
  }

  .error {
    padding: 8px;
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    color: var(--vscode-errorForeground);
    border-radius: 2px;
    font-size: 12px;
  }

  h3 {
    margin: 0 0 8px 0;
    font-size: 16px;
  }

  h4 {
    margin: 12px 0 8px 0;
    font-size: 14px;
  }

  .view-run-button {
    width: 100%;
    padding: 10px 16px;
    margin-bottom: 16px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    transition:
      background-color 0.3s,
      transform 0.2s,
      box-shadow 0.3s;
  }

  .view-run-button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
    transform: translateY(-1px);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }

  .view-run-button:active {
    transform: scale(0.98);
  }

  .combobox-container {
    position: relative;
  }

  .combobox-input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  .combobox-input-wrapper input {
    flex: 1;
    padding-right: 64px;
  }

  .dropdown-toggle {
    position: absolute;
    right: 32px;
    padding: 4px 8px;
    min-width: auto;
    background: transparent;
    color: var(--vscode-input-foreground);
    font-size: 12px;
    line-height: 1;
    opacity: 0.7;
    border: none;
  }

  .dropdown-toggle:hover {
    background: var(--vscode-inputOption-hoverBackground);
    opacity: 1;
  }

  .clear-button {
    position: absolute;
    right: 4px;
    padding: 4px 8px;
    min-width: auto;
    background: transparent;
    color: var(--vscode-input-foreground);
    font-size: 16px;
    line-height: 1;
    opacity: 0.6;
    border: none;
  }

  .clear-button:hover {
    background: var(--vscode-inputOption-hoverBackground);
    opacity: 1;
  }

  .dropdown-list {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    max-height: 300px;
    overflow-y: auto;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 2px;
    margin-top: 2px;
    z-index: 1000;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }

  .dropdown-item {
    padding: 8px 12px;
    cursor: pointer;
    border-bottom: 1px solid var(--vscode-dropdown-border);
    transition:
      background-color 0.2s,
      transform 0.1s;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }

  .dropdown-item:last-child {
    border-bottom: none;
  }

  .dropdown-item:hover {
    background: var(--vscode-list-hoverBackground);
    transform: translateX(2px);
  }

  .dropdown-item:active {
    transform: scale(0.99);
  }

  .dropdown-item.no-results {
    cursor: default;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .dropdown-item.no-results:hover {
    background: transparent;
  }

  .workflow-info {
    flex: 1;
    min-width: 0;
  }

  .workflow-name {
    font-weight: 600;
    font-size: 13px;
    margin-bottom: 2px;
  }

  .workflow-filename {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .favorite-star {
    flex-shrink: 0;
    background: transparent;
    border: none;
    font-size: 18px;
    line-height: 1;
    padding: 4px;
    cursor: pointer;
    opacity: 0.6;
    transition:
      opacity 0.2s,
      transform 0.2s;
  }

  .favorite-star:hover {
    opacity: 1;
    transform: scale(1.2);
  }

  .favorite-star:active {
    transform: scale(1.1);
  }

  .search-results {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
  }

  /* Loading spinner animation */
  @keyframes spin {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(360deg);
    }
  }

  .spinning-icon {
    animation: spin 0.8s linear infinite;
  }

  button:disabled::before {
    content: '';
    display: inline-block;
    width: 12px;
    height: 12px;
    margin-right: 8px;
    border: 2px solid var(--vscode-button-foreground);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .load-file-button:disabled::before,
  .artifact-pattern-save-button:disabled::before,
  .preview-modal button:disabled::before {
    content: none;
    width: 0;
    height: 0;
    margin-right: 0;
    border: none;
    animation: none;
  }

  /* Fade in animation for error messages */
  .error {
    animation: fadeIn 0.3s ease-in;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Welcome Header */
  .welcome-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px;
    margin-bottom: 20px;
    background: linear-gradient(
      135deg,
      var(--vscode-editor-background) 0%,
      var(--vscode-sideBar-background) 100%
    );
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .welcome-message {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .icon-container {
    position: relative;
    width: 34px;
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .wave-emoji {
    position: absolute;
    font-size: 34px;
    line-height: 1;
    opacity: 1;
    transition: opacity 0.8s ease-in-out;
  }

  .wave-emoji.fade-out {
    opacity: 0;
  }

  .wave-emoji--animated {
    animation: wave 2s ease-in-out;
    transform-origin: 70% 70%;
  }

  @keyframes wave {
    0%,
    100% {
      transform: rotate(0deg);
    }
    10%,
    30% {
      transform: rotate(14deg);
    }
    20%,
    40% {
      transform: rotate(-8deg);
    }
    50% {
      transform: rotate(14deg);
    }
    60% {
      transform: rotate(0deg);
    }
  }

  .github-icon {
    position: absolute;
    font-size: 34px;
    line-height: 1;
    color: var(--vscode-foreground);
    opacity: 0;
    transition: opacity 0.8s ease-in-out;
  }

  .github-icon.fade-in {
    opacity: 0.8;
  }

  .welcome-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .welcome-greeting {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    font-weight: 400;
  }

  .welcome-username {
    font-size: 16px;
    font-weight: 700;
    color: var(--vscode-foreground);
    background: linear-gradient(
      90deg,
      var(--vscode-textLink-foreground),
      var(--vscode-textLink-activeForeground)
    );
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .sign-out-button {
    padding: 8px 14px;
    font-size: 12px;
    background-color: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: all 0.2s ease;
  }

  .sign-out-button:hover {
    background-color: var(--vscode-button-secondaryHoverBackground);
    transform: translateY(-1px);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
  }

  .sign-out-button:active {
    transform: translateY(0);
  }

  /* Repository Information Section (Simplified) */
  .repo-info-section {
    padding: 12px;
    margin-bottom: 16px;
    background-color: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .repo-info-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .repo-info-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.5px;
  }

  .repo-info-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .icon-button-small {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    border-radius: 4px;
    transition: all 0.15s ease;
  }

  .icon-button-small:hover {
    background-color: var(--vscode-toolbar-hoverBackground);
    color: var(--vscode-foreground);
  }

  .icon-button-small:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .icon-button-small .codicon {
    font-size: 14px;
  }

  .reload-button.spinning .codicon {
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

  .repo-info-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .repo-info-label {
    font-size: 16px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
  }

  .repo-info-value {
    font-size: 13px;
    font-weight: 500;
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .branch-type {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    margin-right: 4px;
  }

  .file-warning {
    padding: 6px 8px;
    background: var(--vscode-inputValidation-warningBackground);
    border: 1px solid var(--vscode-inputValidation-warningBorder);
    color: var(--vscode-inputValidation-warningForeground);
    border-radius: 2px;
    font-size: 11px;
  }

  .file-error {
    padding: 6px 8px;
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    color: var(--vscode-errorForeground);
    border-radius: 2px;
    font-size: 11px;
  }

  /* Text Input with File Loader */
  .text-input-with-file-loader {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  .text-input-field {
    flex: 1;
  }

  .load-file-button {
    height: 28px;
    padding: 4px 12px;
    background-color: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
    cursor: pointer;
    font-size: 12px;
    transition: background-color 0.2s;
    flex-shrink: 0;
  }

  .load-file-button:hover:not(:disabled) {
    background-color: var(--vscode-button-secondaryHoverBackground);
  }

  .load-file-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Advanced Configuration Section */
  .advanced-config-section {
    margin-top: 16px;
    margin-bottom: 8px;
  }

  .config-toggle {
    width: 100%;
    padding: 8px 12px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
    border-radius: 2px;
    cursor: pointer;
    font-size: 13px;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 8px;
    transition:
      background-color 0.2s,
      transform 0.1s;
  }

  .config-toggle:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .config-toggle:active {
    transform: scale(0.98);
  }

  .config-toggle-icon {
    font-size: 14px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  /* Ensure chevron Codicons render even if other CSS overrides them (Sidebar) */
  .codicon.codicon-chevron-down::before {
    content: '\eab4' !important;
  }

  .codicon.codicon-chevron-right::before {
    content: '\eab6' !important;
  }

  .config-content {
    margin-top: 12px;
    padding: 12px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
  }

  .info-icon {
    display: inline-block;
    margin-left: 4px;
    font-size: 12px;
    cursor: help;
    opacity: 0.7;
  }

  .hint {
    margin-top: 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.4;
  }

  .hint code {
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px;
    border-radius: 2px;
    font-family: var(--vscode-editor-font-family);
    font-size: 10px;
  }

  .presets-section {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid var(--vscode-panel-border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .presets-section h4 {
    margin: 0 0 12px 0;
    font-size: 13px;
    font-weight: 600;
  }
  .presets-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .presets-actions select {
    flex: 1;
    min-width: 0;
  }

  .presets-actions button {
    height: 28px;
    padding: 4px 12px;
    font-size: 12px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .preset-manage {
    display: flex;
    gap: 8px;
  }

  .preset-manage button {
    height: 28px;
    padding: 4px 12px;
    font-size: 12px;
    flex: 1;
  }

  .preset-import-section {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .preset-import-section button {
    height: 28px;
    padding: 4px 12px;
    font-size: 12px;
    flex: 1;
  }

  /* Input Modal Styles */
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
    z-index: 10000;
    backdrop-filter: blur(2px);
  }

  .modal-content {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 20px;
    min-width: 360px;
    max-width: 550px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }

  .modal-content h3 {
    margin: 0 0 16px 0;
    font-size: 14px;
    font-weight: 600;
  }

  .modal-content input:not(.add-item-input) {
    width: 100%;
    margin-bottom: 16px;
    box-sizing: border-box;
  }

  .modal-buttons {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .modal-buttons button {
    padding: 8px 16px;
    min-width: 80px;
  }

  .modal-buttons button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
  }

  .modal-buttons button.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .modal-buttons button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .modal-buttons button.primary:hover {
    background: var(--vscode-button-hoverBackground);
  }

  /* Preview/Edit Modal Styles */
  .preview-modal {
    min-width: 400px;
    max-width: 600px;
  }

  .preview-modal .modal-header {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 16px;
  }

  .preview-modal .modal-header-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .preview-modal .modal-header h3 {
    margin: 0;
  }

  .preview-modal .modal-subtitle {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
  }

  .modal-header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .modal-info-btn {
    padding: 4px;
    background: transparent;
    border: none;
    cursor: help;
    color: var(--vscode-textLink-foreground);
    opacity: 0.7;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .modal-info-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }

  .modal-close-btn {
    padding: 4px;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--vscode-foreground);
    opacity: 0.7;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .modal-close-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }

  .preview-textarea {
    width: 100%;
    min-height: 200px;
    max-height: 400px;
    padding: 10px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    color: var(--vscode-input-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    resize: vertical;
    margin-bottom: 16px;
    border-radius: 2px;
    box-sizing: border-box;
  }

  .preview-textarea:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
  }

  /* Preview Modal Mode Toggle */
  .preview-mode-toggle {
    display: flex;
    gap: 4px;
    margin-bottom: 12px;
    padding: 4px;
    background: var(--vscode-input-background);
    border-radius: 4px;
  }

  .preview-mode-toggle .mode-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 12px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    border-radius: 3px;
    font-size: 12px;
  }

  .preview-mode-toggle .mode-btn:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .preview-mode-toggle .mode-btn.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  /* Preview List Controls */
  .preview-list-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }

  .preview-list-controls .control-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: transparent;
    border: 1px solid var(--vscode-input-border);
    color: var(--vscode-foreground);
    cursor: pointer;
    border-radius: 3px;
    font-size: 11px;
  }

  .preview-list-controls .control-btn:hover:not(:disabled) {
    background: var(--vscode-list-hoverBackground);
  }

  .preview-list-controls .control-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .preview-list-controls .selection-count {
    margin-left: auto;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  /* Delimiter selector row */
  .preview-delimiter-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    padding: 8px 12px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
  }

  .preview-delimiter-row .delimiter-label {
    font-size: 12px;
    color: var(--vscode-foreground);
    white-space: nowrap;
  }

  .preview-delimiter-row .delimiter-select {
    flex: 1;
    max-width: 200px;
    padding: 4px 8px;
    font-size: 12px;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 3px;
    cursor: pointer;
  }

  .preview-delimiter-row .delimiter-select:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  /* Preview Add Item Row */
  .preview-add-item-row {
    display: flex;
    gap: 4px;
    margin-bottom: 12px;
    align-items: center;
  }

  .add-item-input {
    flex: 1;
    padding: 6px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    font-size: 12px;
    box-sizing: border-box;
    line-height: 1.4;
    height: 28px;
  }

  .add-item-input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .add-item-btn,
  .favorites-toggle-btn {
    padding: 0 8px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    box-sizing: border-box;
    height: 28px;
    line-height: 1;
    font-size: 13px;
    flex-shrink: 0;
  }

  .add-item-btn .codicon,
  .favorites-toggle-btn .codicon {
    font-size: 14px;
    line-height: 1;
  }

  .add-item-btn:hover,
  .favorites-toggle-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .add-item-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .favorites-toggle-btn.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .favorites-count {
    font-size: 9px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 0 4px;
    border-radius: 6px;
    min-width: 14px;
    height: 14px;
    line-height: 14px;
    text-align: center;
    display: inline-block;
  }

  /* Preview Favorites Section */
  .preview-favorites-section {
    margin-bottom: 12px;
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    background: var(--vscode-editor-background);
  }

  .favorites-header {
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-widget-border);
    background: var(--vscode-sideBarSectionHeader-background);
  }

  .favorites-title {
    font-size: 12px;
    font-weight: 500;
  }

  .favorites-empty {
    padding: 12px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    font-style: italic;
  }

  .favorites-list {
    max-height: 120px;
    overflow-y: auto;
  }

  .favorite-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-widget-border);
  }

  .favorite-item:last-child {
    border-bottom: none;
  }

  .favorite-add-btn,
  .favorite-remove-btn {
    padding: 2px 4px;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--vscode-foreground);
    opacity: 0.7;
    border-radius: 3px;
  }

  .favorite-add-btn:hover,
  .favorite-remove-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }

  .favorite-add-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .favorite-remove-btn:hover {
    color: var(--vscode-errorForeground);
  }

  .favorite-value {
    flex: 1;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Preview List Items */
  .preview-list-items {
    max-height: 300px;
    overflow-y: auto;
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    margin-bottom: 16px;
    background: var(--vscode-input-background);
  }

  .preview-list-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-widget-border);
    color: var(--vscode-foreground);
    font-size: 12px;
  }

  .preview-list-item:last-child {
    border-bottom: none;
  }

  .preview-list-item:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .preview-list-item.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }

  .preview-list-item input[type='checkbox'] {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    margin: 0;
    cursor: pointer;
  }

  .preview-list-item .item-value {
    flex: 1;
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    word-break: break-all;
    color: inherit;
    text-align: left;
  }

  .preview-list-item .item-actions {
    display: flex;
    gap: 4px;
    opacity: 0.6;
  }

  .preview-list-item:hover .item-actions {
    opacity: 1;
  }

  .item-action-btn {
    padding: 2px 4px;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--vscode-foreground);
    border-radius: 3px;
  }

  .item-action-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }

  .item-action-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .item-action-btn.delete-btn:hover {
    color: var(--vscode-errorForeground);
  }

  .item-favorite-badge,
  .favorite-in-list-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px 4px;
    color: var(--vscode-charts-yellow, #cca700);
    opacity: 0.8;
  }

  .favorite-in-list-badge {
    color: var(--vscode-charts-green, #89d185);
  }

  /* Confirmation Modal Styles */
  .confirm-modal {
    max-width: 450px;
  }

  .confirm-message {
    margin: 0 0 20px 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--vscode-foreground);
  }

  .confirm-modal .modal-buttons {
    justify-content: flex-end;
    gap: 8px;
  }

  .confirm-modal .modal-buttons button {
    min-width: 90px;
  }

  /* Dispatch confirmation parameter layout - mirrors Workflow Runs panel */
  .modal-subtitle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 12px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .modal-branch-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 11px;
  }

  .parameters-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 16px;
  }

  .parameter-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px 0;
    border-bottom: 1px dashed var(--vscode-panel-border);
  }

  .parameter-row:last-child {
    border-bottom: none;
  }

  .parameter-key {
    flex: 0 0 160px;
    font-weight: 600;
    font-size: 12px;
    color: var(--vscode-foreground);
    word-break: break-word;
  }

  .parameter-value {
    flex: 1;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .parameter-value pre {
    margin: 0;
    white-space: pre-wrap;
  }

  .parameters-empty {
    margin: 0 0 16px 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  /* Info Modal Styles */
  .info-modal {
    max-width: 600px;
    max-height: 80vh;
    overflow-y: auto;
  }

  .info-content {
    margin: 0 0 20px 0;
    font-size: 13px;
    line-height: 1.6;
    color: var(--vscode-foreground);
  }

  .info-content h4 {
    margin: 16px 0 8px 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--vscode-textLink-foreground);
  }

  .info-content h4:first-child {
    margin-top: 0;
  }

  .info-content p {
    margin: 8px 0;
  }

  .info-content ul,
  .info-content ol {
    margin: 8px 0;
    padding-left: 24px;
  }

  .info-content li {
    margin: 4px 0;
  }

  .info-content code {
    background: var(--vscode-textCodeBlock-background);
    padding: 2px 6px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
  }

  .info-content strong {
    font-weight: 600;
    color: var(--vscode-textLink-foreground);
  }

  /* Clickable Info Icon */
  .info-icon.clickable {
    background: transparent;
    border: none;
    padding: 0 4px;
    margin-left: 4px;
    cursor: pointer;
    font-size: 14px;
    opacity: 0.7;
    transition:
      opacity 0.2s,
      transform 0.2s;
    vertical-align: middle;
  }

  .info-icon.clickable:hover {
    opacity: 1;
    transform: scale(1.2);
  }

  .info-icon.clickable:active {
    transform: scale(1);
  }

  /* Icon Button (for quick actions) */
  .icon-button {
    min-width: 32px;
    height: 32px;
    padding: 4px 8px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
    border-radius: 2px;
    cursor: pointer;
    font-size: 14px;
    transition:
      background-color 0.2s,
      transform 0.1s;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .icon-button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .icon-button:active {
    transform: scale(0.95);
  }

  .icon-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Branch helper buttons: align with text inputs and file loader buttons */
  .input-with-button .branch-helper {
    height: 28px;
    padding: 4px 12px;
    font-size: 12px;
  }

  /* Artifact pattern saved state */
  .artifact-pattern-saved {
    background: var(--vscode-testing-iconPassed, #73c991) !important;
    color: var(--vscode-button-foreground) !important;
    border-color: var(--vscode-testing-iconPassed, #73c991) !important;
  }

  /* Section Header with Help Button */
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .section-header h3 {
    margin: 0;
    flex: 1;
  }

  /* Workflow actions */
  .workflow-actions {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }

  .workflow-actions .icon-button {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 6px 12px;
    height: 32px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .workflow-actions .icon-button:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .workflow-actions .icon-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .workflow-actions .icon-button .codicon {
    font-size: 16px;
  }

  .workflow-actions .icon-button.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .workflow-actions .icon-button.active:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }

  /* Presets Toggle Button - More prominent expandable control */
  .workflow-actions .presets-toggle-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    height: 32px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.2s ease;
  }

  .workflow-actions .presets-toggle-button:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
    border-color: var(--vscode-focusBorder);
  }

  .workflow-actions .presets-toggle-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .workflow-actions .presets-toggle-button .codicon {
    font-size: 14px;
  }

  .workflow-actions .presets-toggle-button .presets-button-label {
    font-weight: 500;
  }

  .workflow-actions .presets-toggle-button .presets-chevron {
    font-size: 12px;
    opacity: 0.8;
    transition: transform 0.2s ease;
  }

  .workflow-actions .presets-toggle-button.expanded {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
  }

  .workflow-actions .presets-toggle-button.expanded:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
    border-color: var(--vscode-button-hoverBackground);
  }

  .workflow-actions .presets-toggle-button.expanded .presets-chevron {
    transform: rotate(0deg);
  }

  .workflow-actions .presets-toggle-button:not(.expanded) .presets-chevron {
    transform: rotate(0deg);
  }

  /* Presets Expandable Section */
  .presets-expandable-section {
    margin-bottom: 16px;
    padding: 12px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
  }

  .presets-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }

  .presets-header h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }

  .presets-content {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .presets-content .presets-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .presets-content .presets-actions select {
    flex: 1;
    min-width: 0;
  }

  .presets-content .presets-actions button {
    height: 28px;
    padding: 4px 12px;
    font-size: 12px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .presets-content .preset-manage {
    display: flex;
    gap: 8px;
  }

  .presets-content .preset-manage button {
    height: 28px;
    padding: 4px 12px;
    font-size: 12px;
    flex: 1;
  }

  .presets-content .preset-import-section {
    display: flex;
    gap: 8px;
  }

  .presets-content .preset-import-section button {
    height: 28px;
    padding: 4px 12px;
    font-size: 12px;
    flex: 1;
  }

  /* Toast notifications */
  .toast-container {
    position: fixed;
    top: 12px;
    right: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 1000;
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--vscode-editorWidget-background);
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-editorWidget-border);
    border-left-width: 4px;
    padding: 8px 12px;
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    pointer-events: auto;
    max-width: 320px;
  }

  .toast-icon {
    font-size: 14px;
    line-height: 1;
  }

  .toast-icon--success {
    color: var(--vscode-charts-green);
  }

  .toast-icon--error {
    color: var(--vscode-charts-red);
  }

  .toast-icon--warning {
    color: var(--vscode-charts-yellow);
  }

  .toast-icon--info {
    color: var(--vscode-charts-blue);
  }

  .toast-message {
    font-size: 12px;
  }

  .toast-success {
    border-left-color: #2ea043;
  }

  .toast-error {
    border-left-color: #f85149;
  }

  .toast-warning {
    border-left-color: #d29922;
  }

  .toast-info {
    border-left-color: #58a6ff;
  }
</style>
