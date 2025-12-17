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
  } from '../src/types/workflow-types';

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
  <li><strong>Favorites System:</strong> Quick access to frequently used workflows</li>
  <li><strong>Artifact Management:</strong> Download and view workflow artifacts</li>
  <li><strong>Parameter Recovery:</strong> Automatically recover inputs from previous runs</li>
  <li><strong>Logs & Jobs:</strong> View detailed logs and job information</li>
</ul>

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
          if (paramName) {
            // Check if this is a "load contents" request
            if (paramName.startsWith('__loadContents_')) {
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
              // Regular file path selection
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
    for (const input of selectedWorkflow.inputs) {
      if (input.default !== undefined) {
        inputs[input.name] = String(input.default);
      } else {
        inputs[input.name] = '';
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
              {:else if input.isFilePath && input.filePickerEnabled}
                <div class="text-input-with-file-loader">
                  <input
                    id={input.name}
                    type="text"
                    bind:value={inputs[input.name]}
                    on:input={clearError}
                    placeholder={input.description || 'Enter file path'}
                    disabled={loading}
                    class="text-input-field"
                  />
                  <button
                    type="button"
                    on:click={() => loadFileContents(input.name)}
                    disabled={loading || filePickerStates.get(input.name)?.isLoading}
                    class="load-file-button"
                    title="Load contents from file"
                  >
                    {#if filePickerStates.get(input.name)?.isLoading}
                      <span class="codicon codicon-loading spinning-icon"></span>
                    {:else}
                      <span class="codicon codicon-file-text"></span>
                    {/if}
                  </button>
                </div>
                {#if filePickerStates.get(input.name)?.warning}
                  <div class="file-warning" transition:fade>
                    ⚠️ {filePickerStates.get(input.name)?.warning}
                  </div>
                {/if}
                {#if filePickerStates.get(input.name)?.error}
                  <div class="file-error" transition:fade>
                    ❌ {filePickerStates.get(input.name)?.error}
                  </div>
                {/if}
              {:else if shouldShowFileLoader(input)}
                <div class="text-input-with-file-loader">
                  <input
                    id={input.name}
                    type="text"
                    bind:value={inputs[input.name]}
                    on:input={clearError}
                    placeholder={input.default ? String(input.default) : ''}
                    disabled={loading}
                    class="text-input-field"
                  />
                  <button
                    type="button"
                    on:click={() => loadFileContents(input.name)}
                    disabled={loading || filePickerStates.get(input.name)?.isLoading}
                    class="load-file-button"
                    title="Load contents from file"
                  >
                    {#if filePickerStates.get(input.name)?.isLoading}
                      <span class="codicon codicon-loading spinning-icon"></span>
                    {:else}
                      <span class="codicon codicon-file-text"></span>
                    {/if}
                  </button>
                </div>
                {#if filePickerStates.get(input.name)?.warning}
                  <div class="file-warning" transition:fade>
                    ⚠️ {filePickerStates.get(input.name)?.warning}
                  </div>
                {/if}
                {#if filePickerStates.get(input.name)?.error}
                  <div class="file-error" transition:fade>
                    ❌ {filePickerStates.get(input.name)?.error}
                  </div>
                {/if}
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
  .artifact-pattern-save-button:disabled::before {
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

  .modal-content input {
    width: 100%;
    margin-bottom: 16px;
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
