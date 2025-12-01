# Workflow Rerun Logic - Technical Documentation

## Overview

This document explains how the VS Code GitHub Workflow Runner extension handles workflow reruns, specifically how it retrieves and pre-populates input parameters from previous workflow executions.

## User Experience Flow

When a user clicks the rerun button on a workflow run, they are presented with two options:

1. **"Re-run now"** - Directly reruns the workflow using GitHub's rerun API (no parameter modification)
2. **"Modify inputs…"** - Opens the dispatch form with pre-populated parameters from the previous run

## Parameter Retrieval Strategy

The extension uses a **3-tier priority system** to retrieve previous workflow input parameters:

### Priority 1: Local Persistence (Storage)

**Source**: VS Code's `globalState` storage (local to the extension)

**How it works**:

- Every time a workflow is dispatched, the extension saves the parameters to local storage
- Stored in: `workflowHistory` key in VS Code's global state
- Maximum 100 history entries are kept (oldest are removed)

**Code Location**: `src/utils/storage.ts`

```typescript
// When workflow is dispatched, parameters are saved
static async addToHistory(entry: Omit<WorkflowHistoryEntry, 'id' | 'dispatchedAt'>): Promise<void> {
    const history = await this.getHistory();
    const newEntry: WorkflowHistoryEntry = {
        ...entry,
        id: this.generateId(),
        dispatchedAt: new Date().toISOString()
    };
    history.unshift(newEntry);
    if (history.length > MAX_HISTORY_ENTRIES) {
        history.splice(MAX_HISTORY_ENTRIES);
    }
    await this.context.globalState.update(HISTORY_KEY, history);
}

// When rerunning, retrieve the most recent dispatch for this workflow
static async getHistoryForWorkflow(workflowFilename: string, limit?: number): Promise<WorkflowHistoryEntry[]> {
    const history = await this.getHistory();
    const filtered = history.filter((h) => h.workflowFilename === workflowFilename);
    return limit ? filtered.slice(0, limit) : filtered;
}
```

**Advantages**:

- ✅ Fast - no API calls needed
- ✅ Works even if artifacts are expired or deleted
- ✅ Persists across VS Code sessions

**Limitations**:

- ❌ Only available if the workflow was dispatched from THIS extension instance
- ❌ Lost if VS Code's global state is cleared
- ❌ Not available if workflow was triggered from GitHub UI or another machine

### Priority 2: Artifact-Based Recovery

**Source**: Workflow run artifacts uploaded during execution

**How it works**:

- The extension looks for artifacts with names matching a configurable pattern
- **Default pattern**: `build-parameters-*`
- **Custom patterns**: Can be configured per workflow or per preset
- Downloads the artifact (ZIP file) and extracts JSON files
- Parses the JSON to extract the input parameters

**Pattern Resolution Priority**:

1. Check latest template/preset for this workflow (if `artifactPattern` is set)
2. Check workflow-specific configuration (if set in Advanced Configuration)
3. Use default pattern: `build-parameters-*`

**Code Location**: `src/providers/workflow-runs-panel.ts` (lines 1004-1061)

```typescript
// Priority 2: Artifact-based recovery (build-parameters-*)
const artifacts = await getWorkflowRunArtifacts(
  repoInfo.owner,
  repoInfo.name,
  runId
);
const paramArtifact = (artifacts || []).find(
  (a) => /^build-parameters-/i.test(a.name) && !a.expired
);

if (paramArtifact) {
  const buf = await downloadArtifact(
    repoInfo.owner,
    repoInfo.name,
    paramArtifact.id
  );
  if (buf) {
    const zip = new AdmZip(Buffer.from(buf));
    const entries = zip.getEntries();
    let parsedInputs: Record<string, string> | null = null;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const lc = entry.entryName.toLowerCase();
      if (lc.endsWith('.json')) {
        const txt = zip.readAsText(entry);
        const obj = JSON.parse(txt);
        if (obj && typeof obj === 'object') {
          parsedInputs = obj as Record<string, string>;
          break;
        }
      }
    }

    if (parsedInputs) {
      // Pre-fill the dispatch form with these inputs
      await vscode.commands.executeCommand(
        'github-workflow-runner.prefillDispatch',
        {
          workflowFilename,
          branch,
          inputs: parsedInputs,
        }
      );
      return;
    }
  }
}
```

**GitHub API Endpoint Used**:

- `GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts` - List artifacts
- `GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip` - Download artifact

**Advantages**:

- ✅ Works across different machines/VS Code instances
- ✅ Works even if workflow was triggered from GitHub UI
- ✅ Reliable if workflows follow the convention of uploading parameter artifacts

**Limitations**:

- ❌ Requires workflows to upload a `build-parameters-*` artifact
- ❌ Artifacts expire after retention period (default 90 days, configurable)
- ❌ Requires API calls to download artifacts

**Artifact Naming Convention**:
The extension looks for artifacts with names matching the configured pattern (default: `build-parameters-*`, case-insensitive).

**Configuring Custom Patterns**:

1. **Per-Workflow Configuration**: Click "⚙️ Show Advanced Configuration" in the sidebar and set the artifact pattern
2. **Per-Preset Configuration**: The artifact pattern is automatically saved with each preset

**Pattern Syntax**:

- **Simple wildcards**: `my-params-*` (matches `my-params-123`, `my-params-test`, etc.)
- **Full regex**: `^workflow-inputs-.*$` (for advanced pattern matching)
- Auto-detection: The extension automatically detects whether you're using wildcards or regex

**Example from test workflows**:

```yaml
# In test-success-with-artifacts.yml
- name: Upload build parameters
  uses: actions/upload-artifact@v4
  with:
    name: build-parameters # ✅ Matches default pattern 'build-parameters-*'
    path: build-parameters.json
    retention-days: ${{ fromJSON(inputs.artifact_retention_days) }}

# In test-mixed-results.yml
- name: Upload workflow parameters
  uses: actions/upload-artifact@v4
  with:
    name: workflow-parameters # ✅ Matches custom pattern 'workflow-parameters-*'
    path: workflow-parameters.json
```

### Priority 3: Direct Rerun (Fallback)

**Source**: GitHub's workflow rerun API

**How it works**:

- If neither local storage nor artifacts are available, the extension falls back to GitHub's native rerun API
- This reruns the workflow with the **exact same parameters** as the original run
- **No parameter modification is possible** in this mode

**Code Location**: `src/api/workflow-monitor.ts` (lines 598-624)

```typescript
export async function rerunWorkflow(
  owner: string,
  repo: string,
  runId: number,
  failedJobsOnly: boolean = false
): Promise<{ success: boolean; error?: string }> {
  const token = await TokenManager.getGithubToken();
  if (!token) {
    return { success: false, error: 'Not authenticated' };
  }

  const endpoint = failedJobsOnly
    ? `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`
    : `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/rerun`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  // ... error handling
}
```

**GitHub API Endpoints Used**:

- `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun` - Rerun all jobs
- `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs` - Rerun only failed jobs

**Advantages**:

- ✅ Always works (no dependencies on local storage or artifacts)
- ✅ Simple and fast

**Limitations**:

- ❌ Cannot modify input parameters
- ❌ User has no visibility into what parameters will be used

## Complete Rerun Flow Diagram

```
User clicks "Rerun" button
         ↓
    Show dialog:
    - "Re-run now"
    - "Modify inputs…"
         ↓
    User selects "Modify inputs…"
         ↓
    Try Priority 1: Local Storage
         ↓
    Found? → YES → Pre-fill form with stored inputs → DONE
         ↓ NO
    Try Priority 2: Artifacts
         ↓
    Fetch artifacts from GitHub API
         ↓
    Find "build-parameters-*" artifact?
         ↓ YES
    Download & extract JSON
         ↓
    Parse inputs from JSON
         ↓
    Found valid inputs? → YES → Pre-fill form → DONE
         ↓ NO
    Priority 3: Direct Rerun (Fallback)
         ↓
    Call GitHub rerun API
         ↓
    Workflow reruns with original parameters
         ↓
    DONE (no parameter modification possible)
```

## GitHub API Endpoints Summary

### Used for Parameter Retrieval:

1. **Get Workflow Run Details**

   - Endpoint: `GET /repos/{owner}/{repo}/actions/runs/{run_id}`
   - Purpose: Get workflow_id, branch, and basic run information
   - Returns: `WorkflowRun` object (does NOT include input parameters)

2. **Get Workflow Metadata**

   - Endpoint: `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}`
   - Purpose: Get workflow file path from workflow_id
   - Returns: `{ id, name, path }`

3. **List Workflow Run Artifacts**

   - Endpoint: `GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts`
   - Purpose: Find `build-parameters-*` artifacts
   - Returns: Array of artifact metadata

4. **Download Artifact**

   - Endpoint: `GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip`
   - Purpose: Download artifact ZIP file
   - Returns: Binary ZIP data

5. **Rerun Workflow**
   - Endpoint: `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun`
   - Purpose: Rerun workflow with original parameters
   - Returns: Success/failure status

## Important Notes

### GitHub API Limitation

⚠️ **The GitHub API does NOT expose workflow input parameters in the workflow run object.**

The `WorkflowRun` object returned by the API includes:

- ✅ `id`, `run_number`, `name`, `workflow_id`
- ✅ `status`, `conclusion`, `head_branch`, `head_sha`
- ✅ `actor`, `created_at`, `updated_at`
- ❌ **NO `inputs` field**

This is why the extension must use alternative methods (local storage or artifacts) to retrieve parameters.

### Why the Artifact Pattern Matters

For workflows like `test-success-with-artifacts.yml` with multiple parameters:

```yaml
inputs:
  build_type: 'debug'
  version: '1.0.0'
  include_tests: true
  artifact_retention_days: 7
  custom_tag: 'test-build'
  build_components: 'api,frontend,backend'
```

**Without the `build-parameters` artifact**, the extension cannot retrieve these values unless:

1. The workflow was dispatched from this extension instance (local storage available)
2. The user manually re-enters all parameters

**With the `build-parameters` artifact**, the extension can:

1. Download the artifact from any workflow run
2. Extract the JSON file containing all input parameters
3. Pre-populate the dispatch form with the exact values used in the previous run

## Recommendations for Workflow Authors

To ensure the best rerun experience, workflows should:

1. **Upload a parameters artifact** in a job named `save-build-parameters`:

   ```yaml
   jobs:
     save-build-parameters:
       name: Save Build Parameters
       runs-on: ubuntu-latest
       steps:
         - name: Create parameters JSON
           run: |
             cat > build-parameters.json << EOF
             {
               "build_type": "${{ inputs.build_type }}",
               "version": "${{ inputs.version }}",
               "include_tests": "${{ inputs.include_tests }}",
               "custom_tag": "${{ inputs.custom_tag }}",
               "build_components": "${{ inputs.build_components }}"
             }
             EOF

         - name: Upload build parameters
           uses: actions/upload-artifact@v4
           with:
             name: build-parameters
             path: build-parameters.json
             retention-days: 90
   ```

2. **Use the naming pattern** `build-parameters-*` for the artifact name

3. **Store inputs as a flat JSON object** (not nested under an `inputs` key)

4. **Set appropriate retention days** to balance storage costs with rerun needs

## Code References

- **Rerun Logic**: `src/providers/workflow-runs-panel.ts` (lines 246-264, 896-1068)
- **Storage Management**: `src/utils/storage.ts`
- **API Calls**: `src/api/workflow-monitor.ts`
- **Prefill Command**: `src/extension.ts` (lines 213-238)
- **Sidebar Prefill Handling**: `webview/Sidebar.svelte` (lines 275-302)

## Testing with Your Workflows

Your test workflows already implement the artifact pattern correctly:

1. **✅ test-success-with-artifacts.yml**

   - Has `save-build-parameters` job
   - Uploads `build-parameters` artifact
   - Includes all inputs in the JSON

2. **✅ test-mixed-results.yml**
   - Has `save-build-parameters` job
   - Uploads `workflow-parameters` artifact
   - Includes all inputs in the JSON

Both workflows will support the "Modify inputs…" rerun option via artifact-based recovery!

---

## 🆕 Configurable Artifact Pattern Feature

### Overview

As of the latest update, the extension now supports **configurable artifact name patterns** for workflow parameter recovery. This allows you to work with workflows that use different artifact naming conventions without modifying the extension code.

### How to Configure

#### Option 1: Per-Workflow Configuration

1. Select a workflow in the sidebar
2. Click **"⚙️ Show Advanced Configuration"**
3. Enter your custom artifact pattern in the **"Artifact Pattern for Parameter Recovery"** field
4. The pattern is **auto-saved after 1 second** of no changes

#### Option 2: Per-Preset Configuration

1. Configure your workflow inputs and artifact pattern
2. Click **"💾 Save preset"**
3. The artifact pattern is automatically saved with the preset
4. When you load the preset, the artifact pattern is restored

### Pattern Syntax

The extension supports two pattern types with **auto-detection**:

#### Simple Wildcards

Use `*` as a wildcard character:

- `build-parameters-*` → Matches `build-parameters-123`, `build-parameters-test`, etc.
- `my-params-*` → Matches `my-params-dev`, `my-params-prod`, etc.
- `workflow-inputs-*` → Matches `workflow-inputs-v1`, `workflow-inputs-v2`, etc.

#### Full Regex

Use standard regex patterns:

- `^build-parameters-.*$` → Matches any artifact starting with `build-parameters-`
- `^workflow-(inputs|params)-.*$` → Matches `workflow-inputs-*` or `workflow-params-*`
- `.*-parameters$` → Matches any artifact ending with `-parameters`

**Auto-detection**: The extension automatically detects whether you're using simple wildcards or full regex based on the presence of regex metacharacters.

### Pattern Resolution Priority

When rerunning a workflow, the extension resolves the artifact pattern in this order:

1. **Latest Template/Preset** (if `artifactPattern` is set)
2. **Workflow-Specific Configuration** (set in Advanced Configuration)
3. **Default Pattern**: `build-parameters-*`

### Example Use Cases

#### Use Case 1: Different Naming Convention

Your workflow uploads artifacts named `workflow-parameters-*`:

```yaml
- name: Upload workflow parameters
  uses: actions/upload-artifact@v4
  with:
    name: workflow-parameters-${{ github.run_id }}
    path: parameters.json
```

**Solution**: Set artifact pattern to `workflow-parameters-*`

#### Use Case 2: Multiple Parameter Artifacts

Your workflow uploads different parameter sets:

```yaml
- name: Upload build parameters
  uses: actions/upload-artifact@v4
  with:
    name: build-params-${{ matrix.os }}
    path: build-params.json

- name: Upload test parameters
  uses: actions/upload-artifact@v4
  with:
    name: test-params-${{ matrix.os }}
    path: test-params.json
```

**Solution**: Set artifact pattern to `^(build|test)-params-.*$` (regex)

#### Use Case 3: Per-Environment Presets

You have different presets for dev, staging, and prod:

- **Dev Preset**: Uses `dev-parameters-*` artifacts
- **Staging Preset**: Uses `staging-parameters-*` artifacts
- **Prod Preset**: Uses `prod-parameters-*` artifacts

**Solution**: Save each preset with its corresponding artifact pattern

### Implementation Details

**Files Modified**:

- `src/types/workflow-types.ts`: Added `artifactPattern` field to `WorkflowTemplate` and `WorkflowConfig` interfaces
- `src/utils/storage.ts`: Added methods to store/retrieve workflow configurations
- `src/providers/workflow-runs-panel.ts`: Updated rerun logic to use configurable patterns
- `src/providers/sidebar-provider.ts`: Added message handlers for workflow configuration
- `webview/Sidebar.svelte`: Added UI for advanced configuration and fixed template loading reactivity

**Code Location**: `src/providers/workflow-runs-panel.ts` (lines 1138-1195)

### Backward Compatibility

✅ **Fully backward compatible**:

- Existing templates without `artifactPattern` continue to work
- Default pattern `build-parameters-*` is used when no custom pattern is set
- No breaking changes to existing workflows or configurations
