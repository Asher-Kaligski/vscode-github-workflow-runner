/**
 * Utility functions for building and laying out the job dependency graph
 * Implements GitHub-style horizontal left-to-right layout with stage grouping
 */

import type {
  WorkflowRunStatus,
  WorkflowRunConclusion,
  JobGraphNode,
  JobGraphEdge,
  JobDependencyGraph,
  GraphDisplayMode,
  WorkflowJobDefinition,
} from '../../src/types/workflow-types';

/**
 * Strip GitHub Actions template expressions from a name
 * Converts names like "${{ matrix.stage.name }}" to "matrix jobs" for display
 */
function stripTemplateExpressions(name: string): string {
  // Replace template expressions like ${{ matrix.* }} with a clean version
  let cleaned = name.replace(/\$\{\{\s*matrix\.[^}]+\}\}/g, '').trim();
  // Remove any remaining template expressions
  cleaned = cleaned.replace(/\$\{\{[^}]+\}\}/g, '').trim();
  // Clean up any resulting double spaces or leading/trailing hyphens/underscores
  cleaned = cleaned
    .replace(/\s+/g, ' ')
    .replace(/^[-_\s]+|[-_\s]+$/g, '')
    .trim();
  // If the result is empty, use a fallback
  return cleaned || 'matrix jobs';
}

// Layout constants matching GitHub's styling
export const GRAPH_CONSTANTS = {
  NODE_WIDTH: 300, // Increased from 250px to accommodate longer job names
  MATRIX_GROUP_WIDTH: 332, // Width for matrix groups: NODE_WIDTH + padding (24px) + border (2px) + buffer
  NODE_HEIGHT: 44, // Height including padding
  STAGE_GAP: 56, // Gap between stages (mr-6 = 56px)
  NODE_GAP: 12, // Vertical gap between nodes in same stage
  PADDING: 20, // Container padding
  CONNECTOR_Y_CENTER: 22, // Y position for horizontal connectors (center of node)
};

/**
 * Step data from API response
 */
export interface StepData {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped';
  number: number;
  started_at?: string;
  completed_at?: string;
}

/**
 * Simplified job data from API response
 */
export interface JobData {
  id: number;
  name: string;
  status: WorkflowRunStatus;
  conclusion: WorkflowRunConclusion;
  started_at?: string;
  completed_at?: string;
  steps?: StepData[];
  /** Workflow job key from YAML - used for accurate dependency matching */
  workflow_job_key?: string;
}

/**
 * Matrix job group for collapsible display
 */
export interface MatrixJobGroup {
  baseKey: string;
  baseName: string;
  jobs: JobGraphNode[];
  status: WorkflowRunStatus;
  conclusion: WorkflowRunConclusion;
  expanded: boolean;
  level: number;
}

/**
 * Build a job dependency graph from runtime job data
 * Primary approach: Use runtime jobs from API as the source of truth
 * Falls back to job definitions only if no runtime jobs available
 * @param jobDefinitions - Job definitions parsed from workflow YAML (used for dependencies)
 * @param runtimeJobs - Runtime job data from GitHub API (primary source)
 * @returns Complete job dependency graph
 */
export function buildJobDependencyGraph(
  jobDefinitions: WorkflowJobDefinition[],
  runtimeJobs: JobData[]
): JobDependencyGraph {
  const nodes: JobGraphNode[] = [];
  const edges: JobGraphEdge[] = [];
  const nodeMap = new Map<string, JobGraphNode>();

  // Build a dependency map from YAML definitions for reference
  const dependencyMap = new Map<string, string[]>();
  const jobNameToKey = new Map<string, string>();
  for (const jobDef of jobDefinitions) {
    const needs = normalizeNeeds(jobDef.needs);
    dependencyMap.set(jobDef.key.toLowerCase(), needs);
    if (jobDef.name) {
      jobNameToKey.set(jobDef.name.toLowerCase(), jobDef.key);
    }
    jobNameToKey.set(jobDef.key.toLowerCase(), jobDef.key);
  }

  // PRIMARY: Create nodes from runtime jobs (actual jobs from GitHub API)
  if (runtimeJobs.length > 0) {
    for (const job of runtimeJobs) {
      // Find the base job key using workflow_job_key or by parsing name
      const baseJobKey = extractBaseJobKey(job, jobDefinitions);
      const nodeId = `runtime-${job.id}`;

      // Get dependencies from YAML for this base job
      const deps = dependencyMap.get(baseJobKey.toLowerCase()) || [];

      // Convert steps to JobNodeStep format
      const steps = job.steps?.map((step) => ({
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        number: step.number,
        startedAt: step.started_at,
        completedAt: step.completed_at,
        duration:
          step.started_at && step.completed_at
            ? new Date(step.completed_at).getTime() - new Date(step.started_at).getTime()
            : undefined,
      }));

      const node: JobGraphNode = {
        id: nodeId,
        name: job.name,
        jobId: job.id,
        status: job.status,
        conclusion: job.conclusion,
        dependencies: [], // Will be populated after all nodes are created
        dependents: [],
        position: { x: 0, y: 0 },
        level: 0,
        isActive: job.status === 'in_progress',
        isMatrix: (job.name.includes('(') && job.name.includes(')')) || job.name.includes(' / '),
        startedAt: job.started_at,
        completedAt: job.completed_at,
        steps,
      };

      // Store internal properties for dependency resolution (not part of type)
      (node as any)._baseJobKey = baseJobKey;
      (node as any)._yamlDeps = deps;

      if (job.started_at && job.completed_at) {
        node.duration = new Date(job.completed_at).getTime() - new Date(job.started_at).getTime();
      }

      nodes.push(node);
      nodeMap.set(nodeId, node);
    }

    // Build edges based on YAML dependencies
    // For each node, find other nodes that its base job depends on
    for (const node of nodes) {
      const yamlDeps = (node as any)._yamlDeps as string[];
      for (const depKey of yamlDeps) {
        // Find all nodes that match this dependency (could be multiple matrix instances)
        for (const [otherId, otherNode] of nodeMap) {
          const otherBaseKey = (otherNode as any)._baseJobKey as string;
          if (otherBaseKey.toLowerCase() === depKey.toLowerCase() && otherId !== node.id) {
            node.dependencies.push(otherId);
            otherNode.dependents.push(node.id);
            edges.push({
              from: otherId,
              to: node.id,
              type: 'dependency',
            });
          }
        }
      }
    }
  } else if (jobDefinitions.length > 0) {
    // FALLBACK: Use job definitions if no runtime jobs available
    for (const jobDef of jobDefinitions) {
      const node: JobGraphNode = {
        id: jobDef.key,
        name: jobDef.name || jobDef.key,
        jobId: undefined,
        status: 'queued',
        conclusion: null,
        dependencies: normalizeNeeds(jobDef.needs),
        dependents: [],
        position: { x: 0, y: 0 },
        level: 0,
        isActive: false,
        isMatrix: !!jobDef.matrix,
      };

      nodes.push(node);
      nodeMap.set(jobDef.key, node);
    }

    // Build edges from definitions
    for (const node of nodes) {
      for (const depKey of node.dependencies) {
        const depNode = nodeMap.get(depKey);
        if (depNode) {
          depNode.dependents.push(node.id);
          edges.push({
            from: depKey,
            to: node.id,
            type: 'dependency',
          });
        }
      }
    }
  }

  // Apply transitive reduction to remove redundant edges
  // This matches GitHub's visualization behavior where only direct dependencies are shown
  const reducedEdges = computeTransitiveReduction(nodes, edges);

  // Update node dependencies/dependents to match reduced edges
  updateNodeDependenciesAfterReduction(nodes, reducedEdges);

  // Calculate levels using topological sort
  const levels = calculateLevels(nodes, nodeMap);

  // Calculate positions based on levels
  calculatePositions(nodes, levels);

  // Find active job IDs
  const activeJobIds = nodes.filter((n) => n.isActive).map((n) => n.id);

  // Clean up internal properties
  for (const node of nodes) {
    delete (node as any)._baseJobKey;
    delete (node as any)._yamlDeps;
  }

  return {
    nodes,
    edges: reducedEdges,
    maxDepth: levels.length,
    totalJobs: nodes.length,
    activeJobIds,
    levels,
  };
}

/**
 * Build a collapsed job dependency graph with matrix jobs grouped together
 * This creates a simpler view similar to GitHub's native UI where matrix jobs
 * are collapsed into single nodes showing status summary
 * @param jobDefinitions - Job definitions parsed from workflow YAML
 * @param runtimeJobs - Runtime job data from GitHub API
 * @returns Collapsed job dependency graph with grouped matrix jobs
 */
export function buildCollapsedJobDependencyGraph(
  jobDefinitions: WorkflowJobDefinition[],
  runtimeJobs: JobData[]
): JobDependencyGraph {
  const nodes: JobGraphNode[] = [];
  const edges: JobGraphEdge[] = [];
  const nodeMap = new Map<string, JobGraphNode>();

  // Build a dependency map from YAML definitions
  const dependencyMap = new Map<string, string[]>();
  const jobNameToKey = new Map<string, string>();
  for (const jobDef of jobDefinitions) {
    const needs = normalizeNeeds(jobDef.needs);
    dependencyMap.set(jobDef.key.toLowerCase(), needs);
    if (jobDef.name) {
      jobNameToKey.set(jobDef.name.toLowerCase(), jobDef.key);
    }
    jobNameToKey.set(jobDef.key.toLowerCase(), jobDef.key);
  }

  if (runtimeJobs.length > 0) {
    // Group jobs by their base key (collapse matrix jobs)
    const jobGroups = new Map<
      string,
      { jobs: JobData[]; baseKey: string; baseName: string; isMatrix: boolean }
    >();

    // Create context for reusable workflow grouping
    const reusableCallers = jobDefinitions.filter((d) => d.uses);
    const groupContext: ReusableWorkflowGroupContext = {
      callers: reusableCallers,
      assignedJobIds: new Map(),
    };

    for (const job of runtimeJobs) {
      const baseKey = extractBaseJobKey(job, jobDefinitions, runtimeJobs, groupContext);
      // Matrix jobs can have two patterns:
      // 1. "job-name (matrix-params)" - traditional matrix
      // 2. "matrix-value / job-name" - reusable workflow with matrix
      const hasParenPattern = job.name.includes(' (') && job.name.includes(')');
      const hasSlashPattern = job.name.includes(' / ');
      const isMatrix = hasParenPattern || hasSlashPattern;
      // Extract base name for display, stripping any template expressions
      let baseName: string;
      if (hasSlashPattern) {
        // For reusable workflow pattern, find the job definition name
        const jobDef = jobDefinitions.find((d) => d.key === baseKey);
        baseName = stripTemplateExpressions(jobDef?.name || baseKey);
      } else if (hasParenPattern) {
        baseName = stripTemplateExpressions(job.name.substring(0, job.name.indexOf(' (')));
      } else {
        baseName = stripTemplateExpressions(job.name);
      }

      if (!jobGroups.has(baseKey)) {
        jobGroups.set(baseKey, { jobs: [], baseKey, baseName, isMatrix: false });
      }
      const group = jobGroups.get(baseKey)!;
      group.jobs.push(job);
      if (isMatrix) group.isMatrix = true;
    }

    // Create one node per job group
    for (const [baseKey, group] of jobGroups) {
      const deps = dependencyMap.get(baseKey.toLowerCase()) || [];
      const nodeId = `group-${baseKey}`;

      // Calculate aggregated status and conclusion
      const { status, conclusion } = calculateGroupStatus(group.jobs);
      const completedCount = group.jobs.filter((j) => j.status === 'completed').length;
      const successCount = group.jobs.filter(
        (j) => j.status === 'completed' && j.conclusion === 'success'
      ).length;
      const failedCount = group.jobs.filter(
        (j) => j.status === 'completed' && j.conclusion === 'failure'
      ).length;

      // Get representative job for steps (first completed with steps, or first job)
      const representativeJob =
        group.jobs.find((j) => j.status === 'completed' && j.steps && j.steps.length > 0) ||
        group.jobs[0];
      const steps = representativeJob?.steps?.map((step) => ({
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        number: step.number,
        startedAt: step.started_at,
        completedAt: step.completed_at,
        duration:
          step.started_at && step.completed_at
            ? new Date(step.completed_at).getTime() - new Date(step.started_at).getTime()
            : undefined,
      }));

      // Create individual matrix job nodes for expandable display
      const matrixJobNodes: JobGraphNode[] = group.isMatrix
        ? group.jobs.map((job) => ({
            id: `runtime-${job.id}`,
            name: job.name,
            jobId: job.id,
            status: job.status,
            conclusion: job.conclusion,
            dependencies: [],
            dependents: [],
            position: { x: 0, y: 0 },
            level: 0,
            isActive: job.status === 'in_progress',
            isMatrix: false,
            startedAt: job.started_at,
            completedAt: job.completed_at,
            duration:
              job.started_at && job.completed_at
                ? new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()
                : undefined,
            steps: job.steps?.map((step) => ({
              name: step.name,
              status: step.status,
              conclusion: step.conclusion,
              number: step.number,
              startedAt: step.started_at,
              completedAt: step.completed_at,
              duration:
                step.started_at && step.completed_at
                  ? new Date(step.completed_at).getTime() - new Date(step.started_at).getTime()
                  : undefined,
            })),
          }))
        : [];

      const node: JobGraphNode = {
        id: nodeId,
        name: group.isMatrix ? `Matrix: ${group.baseName}` : group.baseName,
        jobId: representativeJob?.id,
        status,
        conclusion,
        dependencies: [],
        dependents: [],
        position: { x: 0, y: 0 },
        level: 0,
        isActive: status === 'in_progress',
        isMatrix: group.isMatrix,
        matrixTotal: group.isMatrix ? group.jobs.length : undefined,
        matrixCompleted: group.isMatrix ? completedCount : undefined,
        matrixJobs: group.isMatrix ? matrixJobNodes : undefined,
        steps,
      };

      // Store internal properties for dependency resolution
      (node as any)._baseJobKey = baseKey;
      (node as any)._yamlDeps = deps;
      (node as any)._groupJobs = group.jobs;

      // Calculate duration from earliest start to latest end
      const startTimes = group.jobs
        .filter((j) => j.started_at)
        .map((j) => new Date(j.started_at!).getTime());
      const endTimes = group.jobs
        .filter((j) => j.completed_at)
        .map((j) => new Date(j.completed_at!).getTime());

      if (startTimes.length > 0) {
        node.startedAt = new Date(Math.min(...startTimes)).toISOString();
      }
      if (endTimes.length > 0 && endTimes.length === group.jobs.length) {
        node.completedAt = new Date(Math.max(...endTimes)).toISOString();
        if (node.startedAt) {
          node.duration = new Date(node.completedAt).getTime() - new Date(node.startedAt).getTime();
        }
      }

      nodes.push(node);
      nodeMap.set(nodeId, node);
    }

    // Build edges based on YAML dependencies (between groups)
    for (const node of nodes) {
      const yamlDeps = (node as any)._yamlDeps as string[];
      for (const depKey of yamlDeps) {
        // Find the group node for this dependency
        for (const [otherId, otherNode] of nodeMap) {
          const otherBaseKey = (otherNode as any)._baseJobKey as string;
          if (otherBaseKey.toLowerCase() === depKey.toLowerCase() && otherId !== node.id) {
            node.dependencies.push(otherId);
            otherNode.dependents.push(node.id);
            edges.push({
              from: otherId,
              to: node.id,
              type: 'dependency',
            });
            break; // Only add one edge per dependency (groups)
          }
        }
      }
    }
  } else if (jobDefinitions.length > 0) {
    // Fallback: Use job definitions
    for (const jobDef of jobDefinitions) {
      const node: JobGraphNode = {
        id: jobDef.key,
        name: jobDef.name || jobDef.key,
        jobId: undefined,
        status: 'queued',
        conclusion: null,
        dependencies: normalizeNeeds(jobDef.needs),
        dependents: [],
        position: { x: 0, y: 0 },
        level: 0,
        isActive: false,
        isMatrix: !!jobDef.matrix,
      };
      nodes.push(node);
      nodeMap.set(jobDef.key, node);
    }

    // Build edges from definitions
    for (const node of nodes) {
      for (const depKey of node.dependencies) {
        const depNode = nodeMap.get(depKey);
        if (depNode) {
          depNode.dependents.push(node.id);
          edges.push({
            from: depKey,
            to: node.id,
            type: 'dependency',
          });
        }
      }
    }
  }

  // Apply transitive reduction to remove redundant edges
  // This matches GitHub's visualization behavior where only direct dependencies are shown
  const reducedEdges = computeTransitiveReduction(nodes, edges);

  // Update node dependencies/dependents to match reduced edges
  updateNodeDependenciesAfterReduction(nodes, reducedEdges);

  // Calculate levels
  const levels = calculateLevels(nodes, nodeMap);
  calculatePositions(nodes, levels);

  const activeJobIds = nodes.filter((n) => n.isActive).map((n) => n.id);

  // Clean up internal properties
  for (const node of nodes) {
    delete (node as any)._baseJobKey;
    delete (node as any)._yamlDeps;
    delete (node as any)._groupJobs;
  }

  return {
    nodes,
    edges: reducedEdges,
    maxDepth: levels.length,
    totalJobs: nodes.length,
    activeJobIds,
    levels,
  };
}

/**
 * Calculate aggregated status for a group of jobs
 */
function calculateGroupStatus(jobs: JobData[]): {
  status: WorkflowRunStatus;
  conclusion: WorkflowRunConclusion;
} {
  const hasInProgress = jobs.some((j) => j.status === 'in_progress');
  const hasQueued = jobs.some((j) => j.status === 'queued' || j.status === 'waiting');
  const allCompleted = jobs.every((j) => j.status === 'completed');
  const hasFailed = jobs.some((j) => j.conclusion === 'failure');
  const hasCancelled = jobs.some((j) => j.conclusion === 'cancelled');
  const allSuccess = jobs.every((j) => j.conclusion === 'success');

  let status: WorkflowRunStatus = 'queued';
  let conclusion: WorkflowRunConclusion = null;

  if (hasInProgress) {
    status = 'in_progress';
  } else if (allCompleted) {
    status = 'completed';
    if (hasFailed) {
      conclusion = 'failure';
    } else if (hasCancelled) {
      conclusion = 'cancelled';
    } else if (allSuccess) {
      conclusion = 'success';
    }
  } else if (hasQueued) {
    status = 'queued';
  }

  return { status, conclusion };
}

/**
 * Context for grouping reusable workflow jobs.
 * Tracks which caller has been assigned to which job ID ranges.
 */
interface ReusableWorkflowGroupContext {
  callers: WorkflowJobDefinition[];
  assignedJobIds: Map<string, number[]>; // callerKey -> job IDs assigned to it
}

/**
 * Extract base job key from a runtime job
 * Uses workflow_job_key from API when available (most accurate)
 * Falls back to parsing job name for matrix jobs like "build (ubuntu-latest, 18)" -> "build"
 * Also handles reusable workflow pattern: "stage-name / job-name" -> caller job key
 */
function extractBaseJobKey(
  job: JobData,
  jobDefinitions: WorkflowJobDefinition[],
  allJobs?: JobData[],
  groupContext?: ReusableWorkflowGroupContext
): string {
  // Prefer workflow_job_key from GitHub API (most accurate)
  if (job.workflow_job_key) {
    return job.workflow_job_key;
  }

  const jobName = job.name;

  // Check for reusable workflow pattern: "matrix-value / job-name" or "job-name / nested-job"
  // This is used when a job calls a reusable workflow with matrix strategy
  const slashIndex = jobName.indexOf(' / ');
  if (slashIndex > 0) {
    // For reusable workflows, we need to find which job in the parent workflow calls this
    // Look for job definitions that use 'uses' (reusable workflow callers)
    const reusableCallers = jobDefinitions.filter((d) => d.uses);

    if (reusableCallers.length === 1) {
      // Simple case: only one reusable workflow caller
      return reusableCallers[0].key;
    }

    if (reusableCallers.length > 1 && allJobs && groupContext) {
      // Multiple reusable workflow callers - use job ID clustering
      // Jobs from the same caller have consecutive IDs because GitHub creates them in order
      return assignToCallerByIdCluster(job, reusableCallers, allJobs, groupContext);
    }

    if (reusableCallers.length > 1) {
      // Multiple callers but no context - fall back to a unique key per job
      // This prevents incorrect grouping
      return `reusable-${job.id}`;
    }

    // Fallback: use the part after slash as indicator
    const afterSlash = jobName.substring(slashIndex + 3).trim();
    return `reusable-workflow-${afterSlash}`;
  }

  // Check for matrix suffix pattern "job-name (params)"
  const parenIndex = jobName.indexOf(' (');
  if (parenIndex > 0) {
    const baseName = jobName.substring(0, parenIndex);
    // Try to find matching job definition
    const matchingDef = jobDefinitions.find(
      (d) =>
        d.key.toLowerCase() === baseName.toLowerCase() ||
        (d.name && d.name.toLowerCase() === baseName.toLowerCase())
    );
    if (matchingDef) {
      return matchingDef.key;
    }
    return baseName;
  }

  // Try exact match with job definitions
  const exactMatch = jobDefinitions.find(
    (d) =>
      d.key.toLowerCase() === jobName.toLowerCase() ||
      (d.name && d.name.toLowerCase() === jobName.toLowerCase())
  );
  if (exactMatch) {
    return exactMatch.key;
  }

  return jobName;
}

/** Debug flag for logging clustering decisions */
const DEBUG_CLUSTERING = true;

/** Cache for clustering results to avoid recomputing for each job */
let clusteringCache: {
  runId: string;
  jobAssignments: Map<number, string>;
} | null = null;

/**
 * Assign a reusable workflow job to a caller based on job start time clustering.
 *
 * Strategy: Jobs from serial stages start and complete sequentially BEFORE
 * parallel stages start. So we use start time to determine which batch a job belongs to.
 */
function assignToCallerByIdCluster(
  job: JobData,
  callers: WorkflowJobDefinition[],
  allJobs: JobData[],
  _context: ReusableWorkflowGroupContext
): string {
  // Find all jobs with the reusable workflow pattern (contain " / ")
  const reusableJobs = allJobs.filter((j) => j.name.includes(' / '));

  if (reusableJobs.length === 0 || callers.length === 0) {
    return callers[0]?.key || 'unknown';
  }

  // Create a cache key from job IDs
  const cacheKey = reusableJobs
    .map((j) => j.id)
    .sort()
    .join(',');

  // Check if we already computed assignments for this set of jobs
  if (clusteringCache && clusteringCache.runId === cacheKey) {
    const cachedAssignment = clusteringCache.jobAssignments.get(job.id);
    if (cachedAssignment) {
      if (DEBUG_CLUSTERING) {
        console.log(`[Clustering] Using cached assignment for "${job.name}": ${cachedAssignment}`);
      }
      return cachedAssignment;
    }
  }

  // Sort callers by their dependency chain
  const callersByOrder = sortCallersByDependencyChain(callers);

  if (DEBUG_CLUSTERING) {
    console.log('[Clustering] Computing new assignments...');
    console.log('[Clustering] Total reusable jobs:', reusableJobs.length);
    console.log(
      '[Clustering] Callers sorted by dependency:',
      callersByOrder.map((c) => c.key)
    );
  }

  // Compute assignments for all jobs using time-based clustering
  const assignments = computeTimeBasedAssignments(reusableJobs, callersByOrder);

  // Cache the results
  clusteringCache = {
    runId: cacheKey,
    jobAssignments: assignments,
  };

  const assignment = assignments.get(job.id) || callersByOrder[callersByOrder.length - 1].key;

  if (DEBUG_CLUSTERING) {
    console.log(`[Clustering] Assigned "${job.name}" to "${assignment}"`);
  }

  return assignment;
}

/**
 * Compute job assignments using time-based clustering.
 * Jobs that started earlier belong to the first caller (serial stages),
 * jobs that started later belong to subsequent callers (parallel stages).
 */
function computeTimeBasedAssignments(
  jobs: JobData[],
  callersByOrder: WorkflowJobDefinition[]
): Map<number, string> {
  const assignments = new Map<number, string>();

  // Sort jobs by start time
  const jobsByStartTime = [...jobs].sort((a, b) => {
    if (!a.started_at && !b.started_at) return a.id - b.id;
    if (!a.started_at) return 1;
    if (!b.started_at) return -1;
    return new Date(a.started_at).getTime() - new Date(b.started_at).getTime();
  });

  if (DEBUG_CLUSTERING) {
    console.log(
      '[TimeClustering] Jobs sorted by start time:',
      jobsByStartTime.map((j) => ({
        id: j.id,
        name: j.name,
        started_at: j.started_at,
      }))
    );
  }

  if (callersByOrder.length === 1) {
    // Simple case: all jobs go to the single caller
    for (const job of jobs) {
      assignments.set(job.id, callersByOrder[0].key);
    }
    return assignments;
  }

  // Find time-based clusters
  // Strategy: Look for gaps in start times that indicate batch transitions
  const clusters = findTimeClusters(jobsByStartTime, callersByOrder.length);

  if (DEBUG_CLUSTERING) {
    console.log(
      '[TimeClustering] Found clusters:',
      clusters.map((c, i) => ({
        callerIndex: i,
        caller: callersByOrder[i]?.key,
        jobCount: c.length,
        jobs: c.map((j) => j.name),
      }))
    );
  }

  // Assign jobs to callers based on clusters
  for (let i = 0; i < clusters.length && i < callersByOrder.length; i++) {
    const callerKey = callersByOrder[i].key;
    for (const job of clusters[i]) {
      assignments.set(job.id, callerKey);
    }
  }

  // Handle any remaining unassigned jobs (assign to last caller)
  const lastCallerKey = callersByOrder[callersByOrder.length - 1].key;
  for (const job of jobs) {
    if (!assignments.has(job.id)) {
      assignments.set(job.id, lastCallerKey);
    }
  }

  return assignments;
}

/**
 * Find time-based clusters by detecting gaps in job start times.
 * Returns an array of job arrays, where each array is a cluster.
 */
function findTimeClusters(jobsByStartTime: JobData[], numCallers: number): JobData[][] {
  if (jobsByStartTime.length === 0) return [];
  if (numCallers <= 1) return [jobsByStartTime];

  // Calculate time gaps between consecutive jobs
  const gaps: Array<{ afterIndex: number; gapMs: number }> = [];

  for (let i = 0; i < jobsByStartTime.length - 1; i++) {
    const job = jobsByStartTime[i];
    const nextJob = jobsByStartTime[i + 1];

    if (job.started_at && nextJob.started_at) {
      const gapMs = new Date(nextJob.started_at).getTime() - new Date(job.started_at).getTime();
      gaps.push({ afterIndex: i, gapMs });
    }
  }

  if (DEBUG_CLUSTERING) {
    console.log(
      '[TimeClusters] Time gaps:',
      gaps.map((g) => ({
        afterJob: jobsByStartTime[g.afterIndex].name,
        beforeJob: jobsByStartTime[g.afterIndex + 1].name,
        gapSeconds: Math.round(g.gapMs / 1000),
      }))
    );
  }

  // Sort gaps by size (largest first) and take top (numCallers - 1)
  const sortedGaps = [...gaps].sort((a, b) => b.gapMs - a.gapMs);
  const boundaryIndices = sortedGaps
    .slice(0, numCallers - 1)
    .map((g) => g.afterIndex + 1)
    .sort((a, b) => a - b);

  if (DEBUG_CLUSTERING) {
    console.log('[TimeClusters] Boundary indices:', boundaryIndices);
  }

  // Split jobs into clusters based on boundaries
  const clusters: JobData[][] = [];
  let startIdx = 0;

  for (const boundaryIdx of boundaryIndices) {
    clusters.push(jobsByStartTime.slice(startIdx, boundaryIdx));
    startIdx = boundaryIdx;
  }
  clusters.push(jobsByStartTime.slice(startIdx));

  return clusters;
}

/**
 * Sort callers by their dependency chain.
 * Callers that depend on other callers come later in the order.
 */
function sortCallersByDependencyChain(callers: WorkflowJobDefinition[]): WorkflowJobDefinition[] {
  const callerKeys = new Set(callers.map((c) => c.key));

  return [...callers].sort((a, b) => {
    const aDeps = normalizeNeeds(a.needs);
    const bDeps = normalizeNeeds(b.needs);

    // Check if A depends on B (A comes after B)
    const aDependsOnB = aDeps.some((dep) => dep === b.key || callerKeys.has(dep));
    // Check if B depends on A (B comes after A)
    const bDependsOnA = bDeps.some((dep) => dep === a.key || callerKeys.has(dep));

    if (aDependsOnB && !bDependsOnA) return 1; // A comes after B
    if (bDependsOnA && !aDependsOnB) return -1; // B comes after A

    // Secondary sort: fewer dependencies = earlier
    return aDeps.length - bDeps.length;
  });
}

/**
 * Find natural batch boundaries by detecting significant ID gaps.
 * When one batch of jobs finishes and another starts, there's usually a gap in IDs.
 */
function findBatchBoundaries(jobs: JobData[], numCallers: number): number[] {
  if (jobs.length <= 1 || numCallers <= 1) {
    return [];
  }

  // Calculate ID gaps between consecutive jobs
  const gaps: Array<{ index: number; gap: number; timeGap: number; jobNames: string }> = [];

  for (let i = 1; i < jobs.length; i++) {
    const prevJob = jobs[i - 1];
    const currJob = jobs[i];

    const idGap = currJob.id - prevJob.id;

    // Also check time gap if available (jobs from different callers start at different times)
    let timeGap = 0;
    if (prevJob.started_at && currJob.started_at) {
      const prevStart = new Date(prevJob.started_at).getTime();
      const currStart = new Date(currJob.started_at).getTime();
      timeGap = currStart - prevStart;
    }

    gaps.push({
      index: i,
      gap: idGap,
      timeGap,
      jobNames: `${prevJob.name} -> ${currJob.name}`,
    });
  }

  // Find the average ID gap
  const avgGap = gaps.reduce((sum, g) => sum + g.gap, 0) / gaps.length;

  if (DEBUG_CLUSTERING) {
    console.log('[Boundaries] Average ID gap:', avgGap);
    console.log('[Boundaries] All gaps:', gaps);
  }

  // Find significant gaps (much larger than average)
  // A significant gap indicates a batch boundary
  const significantGaps = gaps
    .filter((g) => {
      // Gap is significant if it's more than 2x average, or there's a time gap > 30 seconds
      const isSignificant = g.gap > avgGap * 2 || g.timeGap > 30000;
      if (DEBUG_CLUSTERING && isSignificant) {
        console.log(`[Boundaries] Significant gap found at index ${g.index}:`, g);
      }
      return isSignificant;
    })
    .sort((a, b) => {
      // Sort by gap size (largest first) to find the most significant boundaries
      const aScore = a.gap / avgGap + a.timeGap / 60000;
      const bScore = b.gap / avgGap + b.timeGap / 60000;
      return bScore - aScore;
    });

  if (DEBUG_CLUSTERING) {
    console.log('[Boundaries] Significant gaps (sorted):', significantGaps);
  }

  // Take the top (numCallers - 1) boundaries
  const boundaries = significantGaps
    .slice(0, numCallers - 1)
    .map((g) => g.index)
    .sort((a, b) => a - b);

  if (DEBUG_CLUSTERING) {
    console.log('[Boundaries] Final boundaries:', boundaries);
  }

  // If we didn't find enough boundaries, try a different strategy:
  // Look for time-based boundaries (when jobs from different callers start)
  if (boundaries.length < numCallers - 1 && jobs[0].started_at) {
    if (DEBUG_CLUSTERING) {
      console.log('[Boundaries] Not enough boundaries, trying time-based approach...');
    }
    return findTimeBoundaries(jobs, numCallers);
  }

  return boundaries;
}

/**
 * Find batch boundaries based on job start times.
 * Jobs from serial stages all start and complete before parallel stages start.
 */
function findTimeBoundaries(jobs: JobData[], numCallers: number): number[] {
  if (jobs.length <= 1 || numCallers <= 1) {
    return [];
  }

  // Group jobs by approximate start time windows
  const timeWindows: Array<{ startTime: number; jobs: number[] }> = [];
  const windowThreshold = 60000; // 1 minute window

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (!job.started_at) continue;

    const startTime = new Date(job.started_at).getTime();

    // Find existing window or create new one
    const existingWindow = timeWindows.find(
      (w) => Math.abs(w.startTime - startTime) < windowThreshold
    );

    if (existingWindow) {
      existingWindow.jobs.push(i);
    } else {
      timeWindows.push({ startTime, jobs: [i] });
    }
  }

  // Sort windows by start time
  timeWindows.sort((a, b) => a.startTime - b.startTime);

  // Return boundary indices (first job of each window after the first)
  const boundaries: number[] = [];
  for (let i = 1; i < timeWindows.length && boundaries.length < numCallers - 1; i++) {
    const firstJobInWindow = Math.min(...timeWindows[i].jobs);
    boundaries.push(firstJobInWindow);
  }

  return boundaries;
}

/**
 * Normalize the 'needs' field to an array of strings
 */
function normalizeNeeds(needs: string | string[] | undefined): string[] {
  if (!needs) return [];
  return Array.isArray(needs) ? needs : [needs];
}

/**
 * Compute transitive reduction of a directed acyclic graph (DAG).
 * Removes edges that can be inferred through other paths.
 *
 * This matches GitHub's visualization behavior where only "direct" dependencies
 * are shown - if A → B → C exists, the edge A → C is removed because it's
 * redundant (C is already reachable from A through B).
 *
 * Algorithm: For each edge (u → v), check if v is reachable from u through
 * any other path. If so, the edge is redundant and should be removed.
 *
 * @param nodes - Graph nodes with dependencies
 * @param edges - All edges in the graph
 * @returns Reduced set of edges with transitive edges removed
 */
function computeTransitiveReduction(nodes: JobGraphNode[], edges: JobGraphEdge[]): JobGraphEdge[] {
  if (edges.length === 0) return edges;

  // Build adjacency list for efficient traversal
  const adjacencyList = new Map<string, Set<string>>();
  for (const node of nodes) {
    adjacencyList.set(node.id, new Set());
  }
  for (const edge of edges) {
    adjacencyList.get(edge.from)?.add(edge.to);
  }

  /**
   * Check if 'target' is reachable from 'source' without using the direct edge.
   * Uses BFS to find alternative paths.
   */
  function isReachableWithoutDirectEdge(source: string, target: string): boolean {
    const visited = new Set<string>();
    const queue: string[] = [];

    // Start BFS from all neighbors of source EXCEPT the target
    const neighbors = adjacencyList.get(source);
    if (!neighbors) return false;

    for (const neighbor of neighbors) {
      if (neighbor !== target) {
        queue.push(neighbor);
        visited.add(neighbor);
      }
    }

    // BFS to find if we can reach target through other paths
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === target) {
        return true; // Found alternative path
      }

      const currentNeighbors = adjacencyList.get(current);
      if (currentNeighbors) {
        for (const neighbor of currentNeighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }

    return false; // No alternative path found
  }

  // Filter out redundant edges
  const reducedEdges: JobGraphEdge[] = [];

  for (const edge of edges) {
    if (!isReachableWithoutDirectEdge(edge.from, edge.to)) {
      // This edge is NOT redundant - keep it
      reducedEdges.push(edge);
    }
  }

  return reducedEdges;
}

/**
 * Update node dependencies and dependents arrays after transitive reduction.
 * This ensures the node properties are consistent with the reduced edges.
 *
 * @param nodes - Graph nodes to update
 * @param reducedEdges - Edges after transitive reduction
 */
function updateNodeDependenciesAfterReduction(
  nodes: JobGraphNode[],
  reducedEdges: JobGraphEdge[]
): void {
  // Build sets for quick lookup
  const outgoingEdges = new Map<string, Set<string>>();
  const incomingEdges = new Map<string, Set<string>>();

  for (const node of nodes) {
    outgoingEdges.set(node.id, new Set());
    incomingEdges.set(node.id, new Set());
  }

  for (const edge of reducedEdges) {
    outgoingEdges.get(edge.from)?.add(edge.to);
    incomingEdges.get(edge.to)?.add(edge.from);
  }

  // Update each node's dependencies and dependents
  for (const node of nodes) {
    const incoming = incomingEdges.get(node.id);
    const outgoing = outgoingEdges.get(node.id);

    node.dependencies = incoming ? Array.from(incoming) : [];
    node.dependents = outgoing ? Array.from(outgoing) : [];
  }
}

/**
 * Calculate levels for each node using topological sort (Kahn's algorithm)
 */
function calculateLevels(
  nodes: JobGraphNode[],
  nodeMap: Map<string, JobGraphNode>
): JobGraphNode[][] {
  const levels: JobGraphNode[][] = [];
  const inDegree = new Map<string, number>();
  const assigned = new Set<string>();

  // Initialize in-degree
  for (const node of nodes) {
    inDegree.set(node.id, node.dependencies.length);
  }

  // Process nodes level by level
  while (assigned.size < nodes.length) {
    const currentLevel: JobGraphNode[] = [];

    for (const node of nodes) {
      if (assigned.has(node.id)) continue;

      const deg = inDegree.get(node.id) || 0;
      if (deg === 0) {
        node.level = levels.length;
        currentLevel.push(node);
        assigned.add(node.id);
      }
    }

    // Reduce in-degree for dependents
    for (const node of currentLevel) {
      for (const depId of node.dependents) {
        const currentDeg = inDegree.get(depId) || 0;
        inDegree.set(depId, currentDeg - 1);
      }
    }

    if (currentLevel.length > 0) {
      levels.push(currentLevel);
    } else {
      // Cycle detected or no progress - assign remaining to last level
      for (const node of nodes) {
        if (!assigned.has(node.id)) {
          node.level = levels.length;
          currentLevel.push(node);
        }
      }
      if (currentLevel.length > 0) {
        levels.push(currentLevel);
      }
      break;
    }
  }

  return levels;
}

/**
 * Calculate node positions based on levels
 * Uses a HORIZONTAL left-to-right layout (GitHub-style)
 * Each level is a vertical column (stage), jobs in same stage stack vertically
 */
function calculatePositions(nodes: JobGraphNode[], levels: JobGraphNode[][]): void {
  const { NODE_WIDTH, NODE_HEIGHT, STAGE_GAP, NODE_GAP, PADDING } = GRAPH_CONSTANTS;

  // Calculate positions - horizontal layout (levels go right)
  for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
    const levelNodes = levels[levelIdx];
    const stageX = PADDING + levelIdx * (NODE_WIDTH + STAGE_GAP);

    for (let nodeIdx = 0; nodeIdx < levelNodes.length; nodeIdx++) {
      const node = levelNodes[nodeIdx];
      // Position nodes: x increases per stage, y increases per node in stage
      node.position = {
        x: stageX,
        y: PADDING + nodeIdx * (NODE_HEIGHT + NODE_GAP),
      };
    }
  }
}

/**
 * Determine display mode based on container width and total jobs
 * Uses unique job count (after matrix grouping) for better decisions
 * @param containerWidth - Available width in pixels
 * @param totalJobs - Total number of unique job types in the graph (after matrix grouping)
 * @returns Appropriate display mode
 */
export function calculateDisplayMode(containerWidth: number, totalJobs: number): GraphDisplayMode {
  // Always show at least something if we have jobs
  if (totalJobs === 0) {
    return 'button';
  }

  // Only use button mode for very constrained spaces
  if (containerWidth < 150) {
    return 'button';
  }

  // Use minimal mode for small spaces or very many unique job types
  if (containerWidth < 250 || totalJobs > 25) {
    return 'minimal';
  }

  // Use focused mode for medium spaces or many jobs
  if (containerWidth < 400 || totalJobs > 15) {
    return 'focused';
  }

  // Full mode for larger spaces with reasonable job count
  return 'full';
}

/**
 * Get nodes for focused display mode (prev → current → next)
 * @param graph - Full dependency graph
 * @returns Subset of nodes for focused display
 */
export function getFocusedNodes(graph: JobDependencyGraph): JobGraphNode[] {
  const { nodes, activeJobIds } = graph;

  // If no active jobs, show first incomplete job and its context
  let focusJobId = activeJobIds[0];
  if (!focusJobId) {
    const firstIncomplete = nodes.find((n) => n.status !== 'completed');
    focusJobId = firstIncomplete?.id || nodes[0]?.id;
  }

  if (!focusJobId) return nodes;

  const focusNode = nodes.find((n) => n.id === focusJobId);
  if (!focusNode) return nodes;

  const focusedIds = new Set<string>();
  focusedIds.add(focusJobId);

  // Add direct dependencies (previous)
  for (const depId of focusNode.dependencies) {
    focusedIds.add(depId);
  }

  // Add direct dependents (next)
  for (const depId of focusNode.dependents) {
    focusedIds.add(depId);
  }

  return nodes.filter((n) => focusedIds.has(n.id));
}

/**
 * Get the currently active/in-progress node
 */
export function getActiveNode(graph: JobDependencyGraph): JobGraphNode | undefined {
  return graph.nodes.find((n) => n.isActive);
}

/**
 * Calculate total graph width and height for SVG viewport
 * Returns dimensions that ensure all nodes fit within the viewport
 * Optimized for horizontal layout
 */
export function calculateGraphDimensions(nodes: JobGraphNode[]): {
  width: number;
  height: number;
  minX: number;
  minY: number;
} {
  if (nodes.length === 0) {
    return { width: 200, height: 100, minX: 0, minY: 0 };
  }

  const { NODE_WIDTH, NODE_HEIGHT, PADDING } = GRAPH_CONSTANTS;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    // Node position is at left edge (horizontal layout)
    const left = node.position.x;
    const right = node.position.x + NODE_WIDTH;
    const top = node.position.y;
    const bottom = node.position.y + NODE_HEIGHT;

    minX = Math.min(minX, left);
    maxX = Math.max(maxX, right);
    minY = Math.min(minY, top);
    maxY = Math.max(maxY, bottom);
  }

  return {
    width: maxX - minX + PADDING * 2,
    height: maxY - minY + PADDING * 2,
    minX: minX - PADDING,
    minY: minY - PADDING,
  };
}

/**
 * Format duration in milliseconds to human readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Get status color based on job status and conclusion
 */
export function getStatusColor(
  status: WorkflowRunStatus,
  conclusion: WorkflowRunConclusion
): string {
  if (status === 'completed') {
    switch (conclusion) {
      case 'success':
        return 'var(--vscode-testing-iconPassed, #73c991)';
      case 'failure':
        return 'var(--vscode-testing-iconFailed, #f14c4c)';
      case 'cancelled':
        return 'var(--vscode-disabledForeground, #969696)';
      case 'skipped':
        return 'var(--vscode-disabledForeground, #969696)';
      default:
        return 'var(--vscode-foreground, #cccccc)';
    }
  }
  if (status === 'in_progress') {
    return 'var(--vscode-progressBar-background, #0e70c0)';
  }
  if (status === 'queued' || status === 'waiting') {
    return 'var(--vscode-disabledForeground, #969696)';
  }
  return 'var(--vscode-foreground, #cccccc)';
}

/**
 * Get codicon name for job status
 */
export function getStatusIcon(
  status: WorkflowRunStatus,
  conclusion: WorkflowRunConclusion
): string {
  if (status === 'completed') {
    switch (conclusion) {
      case 'success':
        return 'pass';
      case 'failure':
        return 'error';
      case 'cancelled':
        return 'circle-slash';
      case 'skipped':
        return 'debug-step-over';
      default:
        return 'question';
    }
  }
  if (status === 'in_progress') {
    return 'sync';
  }
  if (status === 'queued' || status === 'waiting') {
    return 'clock';
  }
  return 'circle-outline';
}

/**
 * Group matrix jobs by their base job key
 * Returns groups for collapsible display
 */
export function groupMatrixJobs(nodes: JobGraphNode[]): MatrixJobGroup[] {
  const groups = new Map<string, MatrixJobGroup>();

  for (const node of nodes) {
    if (!node.isMatrix) continue;

    const baseKey = (node as any)._baseJobKey || extractBaseNameFromDisplay(node.name);

    if (!groups.has(baseKey)) {
      groups.set(baseKey, {
        baseKey,
        baseName: extractBaseNameFromDisplay(node.name),
        jobs: [],
        status: 'queued',
        conclusion: null,
        expanded: false,
        level: node.level,
      });
    }

    const group = groups.get(baseKey)!;
    group.jobs.push(node);

    // Update group status based on job statuses
    if (node.status === 'in_progress') {
      group.status = 'in_progress';
    } else if (node.status === 'completed' && group.status !== 'in_progress') {
      group.status = 'completed';
      // Update conclusion (worst case wins)
      if (node.conclusion === 'failure') {
        group.conclusion = 'failure';
      } else if (node.conclusion === 'cancelled' && group.conclusion !== 'failure') {
        group.conclusion = 'cancelled';
      } else if (group.conclusion === null) {
        group.conclusion = node.conclusion;
      }
    }
  }

  return Array.from(groups.values());
}

/**
 * Extract base name from a matrix job display name
 * "build (ubuntu, 18)" -> "build"
 */
function extractBaseNameFromDisplay(name: string): string {
  const parenIndex = name.indexOf(' (');
  return parenIndex > 0 ? name.substring(0, parenIndex) : name;
}

/**
 * Calculate horizontal connector paths between stages (GitHub-style)
 * Returns simple horizontal line segments at the center Y position
 */
export function calculateConnectorPaths(
  edges: JobGraphEdge[],
  nodes: JobGraphNode[],
  offsetX: number,
  offsetY: number
): { d: string; from: string; to: string; isHighlight?: boolean }[] {
  if (!edges || edges.length === 0 || !nodes || nodes.length === 0) return [];

  const { NODE_WIDTH, NODE_HEIGHT } = GRAPH_CONSTANTS;
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const paths: { d: string; from: string; to: string }[] = [];

  // Group edges by their stage transitions
  const stageConnections = new Map<string, { fromX: number; toX: number; y: number }>();

  for (const edge of edges) {
    const fromNode = nodeMap.get(edge.from);
    const toNode = nodeMap.get(edge.to);
    if (!fromNode || !toNode) continue;

    // Calculate connection points (right edge of source, left edge of target)
    const fromX = fromNode.position.x + NODE_WIDTH - offsetX;
    const toX = toNode.position.x - offsetX;
    const fromY = fromNode.position.y + NODE_HEIGHT / 2 - offsetY;
    const toY = toNode.position.y + NODE_HEIGHT / 2 - offsetY;

    // Create horizontal path with vertical adjustment if needed
    // GitHub uses simple horizontal lines; we'll add slight curves for non-aligned nodes
    if (Math.abs(fromY - toY) < 5) {
      // Same Y level - simple horizontal line
      paths.push({
        d: `M ${fromX} ${fromY} H ${toX}`,
        from: edge.from,
        to: edge.to,
      });
    } else {
      // Different Y levels - use a curved path
      const midX = (fromX + toX) / 2;
      paths.push({
        d: `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`,
        from: edge.from,
        to: edge.to,
      });
    }
  }

  return paths;
}

/**
 * Get stage information for flexbox-based layout
 * Returns nodes grouped by their level (stage)
 */
export function getStages(graph: JobDependencyGraph): JobGraphNode[][] {
  if (!graph || !graph.levels) return [];
  return graph.levels;
}

/**
 * Calculate scale factor to fit graph in container
 */
export function calculateScaleFactor(
  graphWidth: number,
  graphHeight: number,
  containerWidth: number,
  containerHeight: number,
  minScale = 0.3,
  maxScale = 1.0
): number {
  const scaleX = containerWidth / graphWidth;
  const scaleY = containerHeight / graphHeight;
  const scale = Math.min(scaleX, scaleY);
  return Math.max(minScale, Math.min(maxScale, scale));
}
