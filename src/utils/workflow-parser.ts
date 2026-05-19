/**
 * Parse GitHub Actions workflow files to extract workflow_dispatch definitions
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type {
  WorkflowDefinition,
  WorkflowInput,
  WorkflowInputType,
  WorkflowJobDefinition,
} from '../types/workflow-types';

/**
 * Parse a single workflow file
 */
export async function parseWorkflowFile(
  filepath: string,
  includeNonDispatch = false,
  contentOverride?: string,
  workspacePath?: string
): Promise<WorkflowDefinition | null> {
  try {
    const content = contentOverride ?? fs.readFileSync(filepath, 'utf8');
    const doc = yaml.load(content) as any;

    if (!doc) {
      return null;
    }

    // Check if workflow has workflow_dispatch trigger
    const hasWorkflowDispatch =
      doc.on &&
      (doc.on === 'workflow_dispatch' ||
        (typeof doc.on === 'object' && 'workflow_dispatch' in doc.on));

    if (!hasWorkflowDispatch && !includeNonDispatch) {
      return null;
    }

    // Extract workflow name
    const name = doc.name || path.basename(filepath, path.extname(filepath));

    // Extract description (from run-name or name)
    const description = doc['run-name'] || doc.name;

    // Extract inputs
    const inputs: WorkflowInput[] = [];
    const workflowDispatchConfig = typeof doc.on === 'object' ? doc.on.workflow_dispatch : {};

    if (workflowDispatchConfig && workflowDispatchConfig.inputs) {
      for (const [inputName, inputConfig] of Object.entries(
        workflowDispatchConfig.inputs as Record<string, any>
      )) {
        const input: WorkflowInput = {
          name: inputName,
          description: inputConfig.description || '',
          required: inputConfig.required === true,
          type: normalizeInputType(inputConfig.type),
          default: inputConfig.default,
        };

        // Add options for choice type
        if (inputConfig.type === 'choice' && inputConfig.options) {
          input.options = inputConfig.options;
        }

        inputs.push(input);
      }
    }

    // Detect file path parameters
    const detectedInputs = detectFilePathParameters(inputs);

    // Determine workspace-relative path for file (normalize to forward slashes)
    const workspaceRoot =
      workspacePath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const relativeFilepath = workspaceRoot ? path.relative(workspaceRoot, filepath) : filepath;
    const normalizedFilepath = relativeFilepath.split(path.sep).join('/');

    return {
      name,
      filename: path.basename(filepath),
      filepath: normalizedFilepath,
      description,
      inputs: detectedInputs,
      hasWorkflowDispatch,
    };
  } catch (error) {
    console.error(`Failed to parse workflow file ${filepath}:`, error);
    return null;
  }
}

/**
 * Normalize input type to supported types
 */
function normalizeInputType(type: string | undefined): WorkflowInputType {
  if (!type) {
    return 'string';
  }

  const normalized = type.toLowerCase();
  switch (normalized) {
    case 'choice':
      return 'choice';
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'environment':
      return 'environment';
    default:
      return 'string';
  }
}

/**
 * Get all workflow files from .github/workflows directory
 */
export async function getWorkflowFiles(workspacePath?: string): Promise<string[]> {
  try {
    const root =
      workspacePath ??
      (vscode.workspace.workspaceFolders?.length
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : undefined);

    if (!root) {
      return [];
    }

    const workflowsDir = path.join(root, '.github', 'workflows');

    if (!fs.existsSync(workflowsDir)) {
      return [];
    }

    const files = fs.readdirSync(workflowsDir);
    const workflowFiles = files
      .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
      .map((file) => path.join(workflowsDir, file));

    return workflowFiles;
  } catch (error) {
    console.error('Failed to get workflow files:', error);
    return [];
  }
}

/**
 * Parse all workflow files and return those with workflow_dispatch
 */
export async function getAllWorkflowDefinitions(
  excludePatterns: string[] = [],
  workspacePath?: string
): Promise<WorkflowDefinition[]> {
  try {
    const workflowFiles = await getWorkflowFiles(workspacePath);
    const definitions: WorkflowDefinition[] = [];

    for (const filepath of workflowFiles) {
      const definition = await parseWorkflowFile(filepath);
      if (definition && definition.hasWorkflowDispatch) {
        // Check if workflow should be excluded
        const shouldExclude = excludePatterns.some((pattern) => {
          const regex = new RegExp(pattern.replace(/\*/g, '.*'));
          return regex.test(definition.name) || regex.test(definition.filename);
        });

        if (!shouldExclude) {
          definitions.push(definition);
        }
      }
    }

    // Sort by name
    definitions.sort((a, b) => a.name.localeCompare(b.name));

    return definitions;
  } catch (error) {
    console.error('Failed to get all workflow definitions:', error);
    return [];
  }
}

/**
 * Get a specific workflow definition by filename
 */
export async function getWorkflowDefinition(
  filename: string,
  workspacePath?: string
): Promise<WorkflowDefinition | null> {
  try {
    const root =
      workspacePath ??
      (vscode.workspace.workspaceFolders?.length
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : undefined);

    if (!root) {
      return null;
    }

    const filepath = path.join(root, '.github', 'workflows', filename);

    if (!fs.existsSync(filepath)) {
      return null;
    }

    // Prefer unsaved in-memory content when the workflow file is open.
    const openDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === filepath);
    if (openDoc) {
      return await parseWorkflowFile(filepath, false, openDoc.getText(), workspacePath);
    }

    return await parseWorkflowFile(filepath, false, undefined, workspacePath);
  } catch (error) {
    console.error(`Failed to get workflow definition for ${filename}:`, error);
    return null;
  }
}

/**
 * Validate workflow inputs against definition
 */
export function validateWorkflowInputs(
  definition: WorkflowDefinition,
  inputs: Record<string, string>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required inputs

  for (const input of definition.inputs) {
    if (input.required && !inputs[input.name]) {
      errors.push(`Required input "${input.name}" is missing`);
    }

    // Validate input type
    if (inputs[input.name]) {
      const value = inputs[input.name];

      switch (input.type) {
        case 'number':
          if (isNaN(Number(value))) {
            errors.push(`Input "${input.name}" must be a number`);
          }
          break;
        case 'boolean':
          if (value !== 'true' && value !== 'false') {
            errors.push(`Input "${input.name}" must be true or false`);
          }
          break;
        case 'choice':
          if (input.options && !input.options.includes(value)) {
            errors.push(`Input "${input.name}" must be one of: ${input.options.join(', ')}`);
          }
          break;
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Watch workflow directory for changes
 */
export function watchWorkflowDirectory(callback: () => void): vscode.Disposable | null {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }

    const workflowsDir = path.join(workspaceFolders[0].uri.fsPath, '.github', 'workflows');

    if (!fs.existsSync(workflowsDir)) {
      return null;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workflowsDir, '*.{yml,yaml}')
    );

    watcher.onDidCreate(callback);
    watcher.onDidChange(callback);
    watcher.onDidDelete(callback);

    return watcher;
  } catch (error) {
    console.error('Failed to watch workflow directory:', error);
    return null;
  }
}

/**
 * Get workflow file content for display/editing
 */
export async function getWorkflowFileContent(filename: string): Promise<string | null> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }

    const filepath = path.join(workspaceFolders[0].uri.fsPath, '.github', 'workflows', filename);

    if (!fs.existsSync(filepath)) {
      return null;
    }

    return fs.readFileSync(filepath, 'utf8');
  } catch (error) {
    console.error(`Failed to get workflow file content for ${filename}:`, error);
    return null;
  }
}

/**
 * Check if an input parameter is likely a file path
 */
export function isFilePathParameter(input: WorkflowInput, keywords: string[] = []): boolean {
  const defaultKeywords = [
    'path',
    'file',
    'config',
    'script',
    'template',
    'yaml',
    'json',
    'dockerfile',
    'manifest',
  ];
  const allKeywords = keywords.length > 0 ? keywords : defaultKeywords;

  const desc = (input.description || '').toLowerCase();
  const name = input.name.toLowerCase();

  return allKeywords.some((keyword) => desc.includes(keyword) || name.includes(keyword));
}

/**
 * Detect and mark file path parameters in workflow inputs
 */
export function detectFilePathParameters(inputs: WorkflowInput[]): WorkflowInput[] {
  const config = vscode.workspace.getConfiguration('githubWorkflowRunner');
  const enabled = config.get<boolean>('filePathDetection.enabled', true);

  if (!enabled) {
    return inputs;
  }

  const keywords = config.get<string[]>('filePathDetection.keywords', []);

  return inputs.map((input) => ({
    ...input,
    isFilePath: isFilePathParameter(input, keywords),
    filePickerEnabled: isFilePathParameter(input, keywords),
  }));
}

/**
 * Parse all workflow files and return definitions regardless of workflow_dispatch
 */
export async function getAllWorkflowDefinitionsIncludingNonDispatch(
  excludePatterns: string[] = []
): Promise<WorkflowDefinition[]> {
  try {
    const workflowFiles = await getWorkflowFiles();
    const definitions: WorkflowDefinition[] = [];

    for (const filepath of workflowFiles) {
      const definition = await parseWorkflowFile(filepath, true);
      if (definition) {
        // Check if workflow should be excluded
        const shouldExclude = excludePatterns.some((pattern) => {
          const regex = new RegExp(pattern.replace(/\*/g, '.*'));
          return regex.test(definition.name) || regex.test(definition.filename);
        });

        if (!shouldExclude) {
          definitions.push(definition);
        }
      }
    }

    // Sort by name
    definitions.sort((a, b) => a.name.localeCompare(b.name));

    return definitions;
  } catch (error) {
    console.error('Failed to get all workflow definitions (including non-dispatch):', error);
    return [];
  }
}

/**
 * Parse job dependencies from a workflow YAML file
 * Extracts job keys, names, and 'needs' dependencies
 */
export async function parseJobDependencies(workflowPath: string): Promise<WorkflowJobDefinition[]> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return [];
    }

    // Handle both absolute and relative paths
    let filepath = workflowPath;
    if (!path.isAbsolute(workflowPath)) {
      filepath = path.join(workspaceFolders[0].uri.fsPath, workflowPath);
    }

    // Also check if the path starts with .github/workflows
    if (!fs.existsSync(filepath) && !workflowPath.startsWith('.github')) {
      filepath = path.join(workspaceFolders[0].uri.fsPath, '.github', 'workflows', workflowPath);
    }

    if (!fs.existsSync(filepath)) {
      console.warn(`Workflow file not found: ${filepath}`);
      return [];
    }

    // Prefer unsaved in-memory content when the workflow file is open
    const openDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === filepath);
    const content = openDoc ? openDoc.getText() : fs.readFileSync(filepath, 'utf8');

    const doc = yaml.load(content) as Record<string, unknown>;
    if (!doc || !doc.jobs) {
      return [];
    }

    const jobs = doc.jobs as Record<string, Record<string, unknown>>;
    const jobDefinitions: WorkflowJobDefinition[] = [];

    for (const [jobKey, jobConfig] of Object.entries(jobs)) {
      if (!jobConfig || typeof jobConfig !== 'object') {
        continue;
      }

      const jobDef: WorkflowJobDefinition = {
        key: jobKey,
        name: (jobConfig.name as string) || jobKey,
      };

      // Extract 'needs' dependencies
      if (jobConfig.needs !== undefined) {
        // 'needs' can be a single string or an array of strings
        if (typeof jobConfig.needs === 'string') {
          jobDef.needs = [jobConfig.needs];
        } else if (Array.isArray(jobConfig.needs)) {
          jobDef.needs = jobConfig.needs.filter((n): n is string => typeof n === 'string');
        }
      }

      // Extract matrix strategy if present
      if (jobConfig.strategy && typeof jobConfig.strategy === 'object') {
        const strategy = jobConfig.strategy as Record<string, unknown>;
        if (strategy.matrix && typeof strategy.matrix === 'object') {
          jobDef.matrix = strategy.matrix as WorkflowJobDefinition['matrix'];
        }
      }

      // Extract 'uses' for reusable workflows (helps identify matrix job grouping)
      if (jobConfig.uses && typeof jobConfig.uses === 'string') {
        jobDef.uses = jobConfig.uses;
      }

      jobDefinitions.push(jobDef);
    }

    return jobDefinitions;
  } catch (error) {
    console.error(`Failed to parse job dependencies from ${workflowPath}:`, error);
    return [];
  }
}

/**
 * Get job dependencies map from workflow path
 * Returns a map of jobKey -> array of dependency jobKeys
 */
export async function getJobDependenciesMap(workflowPath: string): Promise<Map<string, string[]>> {
  const jobDefinitions = await parseJobDependencies(workflowPath);
  const dependenciesMap = new Map<string, string[]>();

  for (const job of jobDefinitions) {
    // Normalize needs to always be an array
    const needs = job.needs ? (Array.isArray(job.needs) ? job.needs : [job.needs]) : [];
    dependenciesMap.set(job.key, needs);
  }

  return dependenciesMap;
}
