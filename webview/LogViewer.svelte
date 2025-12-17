<script lang="ts">
  /**
   * LogViewer - Interactive log viewer with collapsible groups
   * Mimics GitHub's native log viewing UI with expand/collapse functionality
   */

  // VSCode webview API - cast from window
  const vscode = (window as any).vscode as {
    postMessage: (message: unknown) => void;
    getState: () => unknown;
    setState: (state: unknown) => void;
  };

  /**
   * Step data from GitHub API for duration, status, and timestamp-based grouping
   */
  interface StepData {
    number: number;
    name: string;
    status: 'queued' | 'in_progress' | 'completed';
    conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped';
    duration?: number; // Duration in milliseconds
    startedAt?: string; // ISO timestamp
    completedAt?: string; // ISO timestamp
  }

  interface LogGroup {
    id: string;
    name: string;
    lines: string[];
    children: LogGroup[];
    expanded: boolean;
    isNested: boolean;
    stepIndex: number; // Display index (1-based sequential)
    duration?: number; // Duration in milliseconds
    conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped';
    isOrphaned?: boolean; // True if this is the orphaned logs section
  }

  interface ParsedLogs {
    groups: LogGroup[];
    rawLines: string[];
  }

  let loading = true;
  let error: string | null = null;
  let jobName = '';
  let jobId: number | undefined = undefined;
  let stepNumber: number | undefined = undefined;
  let stepName: string | undefined = undefined;
  let parsedLogs: ParsedLogs = { groups: [], rawLines: [] };
  let targetGroupId: string | null = null;
  let rawLogs = ''; // Store raw logs for timestamps and download
  let showTimestamps = false; // Toggle for showing timestamps
  let stepsData: StepData[] = []; // Step data from API

  // Search functionality
  let searchQuery = '';
  let searchMatches: { groupId: string; lineIndex: number }[] = [];
  let currentSearchIndex = -1;
  let showSearch = false;
  let caseSensitiveSearch = false;
  let regexSearch = false;
  let regexError: string | null = null;

  // Disclaimer banner state
  let showDisclaimer = true;

  // Handle messages from extension
  function handleMessage(event: MessageEvent) {
    const message = event.data;
    switch (message.type) {
      case 'logsLoaded':
        loading = false;
        error = null;
        jobName = message.data.jobName || '';
        jobId = message.data.jobId;
        stepNumber = message.data.stepNumber;
        stepName = message.data.stepName;
        rawLogs = message.data.logs || '';
        stepsData = message.data.steps || [];
        parsedLogs = parseLogs(rawLogs, stepNumber, stepName, stepsData);

        // Scroll to target step after render
        if (targetGroupId) {
          setTimeout(() => {
            scrollToGroup(targetGroupId!);
            targetGroupId = null;
          }, 50);
        }
        break;
      case 'error':
        loading = false;
        error = message.data.message;
        break;
    }
  }

  // Subscribe to messages on mount
  if (typeof window !== 'undefined') {
    window.addEventListener('message', handleMessage);
  }

  /**
   * Format duration in milliseconds to human readable string
   */
  function formatDuration(ms: number): string {
    if (ms < 1000) {
      return '<1s';
    }
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
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
   * Parse raw logs into structured groups using HYBRID approach
   *
   * Strategy:
   * 1. Parse ##[group]/##[endgroup] markers to get the nested structure
   * 2. Use timestamps to assign groups to the correct API steps
   * 3. Build final structure with API step names as top-level, containing nested groups as children
   *
   * All groups are collapsed by default, with optional auto-expand for specific step
   */
  function parseLogs(
    rawLogs: string,
    targetStep?: number,
    targetName?: string,
    steps?: StepData[]
  ): ParsedLogs {
    const lines = rawLogs.split('\n');
    const timestampRegex = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s?/;

    // If no steps data, return empty groups with raw lines
    if (!steps || steps.length === 0) {
      return { groups: [], rawLines: lines };
    }

    // ============================================
    // PHASE 1: Parse ##[group] structure with timestamps
    // ============================================
    interface RawGroup {
      name: string;
      lines: string[];
      children: RawGroup[];
      firstTimestamp?: number; // ms timestamp of first line in group
    }

    const allGroups: RawGroup[] = [];
    const groupStack: RawGroup[] = [];
    let currentLines: string[] = [];
    let currentFirstTimestamp: number | undefined = undefined;
    let ungroupedLines: { line: string; timestamp?: number }[] = []; // Lines outside any group

    /**
     * Extract timestamp from a log line
     */
    function getLineTimestamp(line: string): number | undefined {
      const match = line.match(timestampRegex);
      return match ? new Date(match[1]).getTime() : undefined;
    }

    /**
     * Process a line for display (strip timestamp if needed, strip ANSI codes)
     */
    function processLineForDisplay(line: string): string {
      const lineContent = showTimestamps ? line : line.replace(timestampRegex, '');
      return stripAnsiCodes(lineContent);
    }

    for (const line of lines) {
      const cleanLineForParsing = line.replace(timestampRegex, '');
      const lineTs = getLineTimestamp(line);

      if (cleanLineForParsing.includes('##[group]')) {
        // Save pending lines to current group
        if (groupStack.length > 0 && currentLines.length > 0) {
          groupStack[groupStack.length - 1].lines.push(...currentLines);
          if (currentFirstTimestamp && !groupStack[groupStack.length - 1].firstTimestamp) {
            groupStack[groupStack.length - 1].firstTimestamp = currentFirstTimestamp;
          }
        } else if (groupStack.length === 0 && currentLines.length > 0) {
          // Lines before any group - add as ungrouped
          currentLines.forEach((l, i) => {
            ungroupedLines.push({
              line: l,
              timestamp: i === 0 ? currentFirstTimestamp : undefined,
            });
          });
        }
        currentLines = [];
        currentFirstTimestamp = lineTs;

        const groupName = cleanLineForParsing.replace(/.*##\[group\]/, '').trim();
        const newGroup: RawGroup = {
          name: groupName,
          lines: [],
          children: [],
          firstTimestamp: lineTs,
        };

        // "Run ..." groups should always be treated as top-level siblings,
        // not nested children. This matches GitHub's UI where all "Run ..." commands
        // are displayed as sibling collapsible sections within a step.
        const isRunGroup = groupName.startsWith('Run ');

        if (groupStack.length > 0 && !isRunGroup) {
          // Nested group (non-Run groups can be nested)
          groupStack[groupStack.length - 1].children.push(newGroup);
          groupStack.push(newGroup);
        } else {
          // Top-level group OR a "Run ..." group (always top-level)
          // If we were inside another group, close it implicitly
          if (isRunGroup && groupStack.length > 0) {
            // Close all open groups - "Run ..." starts a new top-level section
            groupStack.length = 0;
          }
          allGroups.push(newGroup);
          groupStack.push(newGroup);
        }
      } else if (cleanLineForParsing.includes('##[endgroup]')) {
        if (groupStack.length > 0 && currentLines.length > 0) {
          groupStack[groupStack.length - 1].lines.push(...currentLines);
          if (currentFirstTimestamp && !groupStack[groupStack.length - 1].firstTimestamp) {
            groupStack[groupStack.length - 1].firstTimestamp = currentFirstTimestamp;
          }
        }
        currentLines = [];
        currentFirstTimestamp = undefined;
        groupStack.pop();
      } else {
        const processed = processLineForDisplay(line);
        if (processed.trim()) {
          if (groupStack.length > 0) {
            currentLines.push(processed);
            if (!currentFirstTimestamp) {
              currentFirstTimestamp = lineTs;
            }
          } else {
            // Lines outside any group
            ungroupedLines.push({ line: processed, timestamp: lineTs });
          }
        }
      }
    }

    // Handle remaining lines
    if (groupStack.length > 0 && currentLines.length > 0) {
      groupStack[groupStack.length - 1].lines.push(...currentLines);
    } else if (currentLines.length > 0) {
      currentLines.forEach((l) => ungroupedLines.push({ line: l }));
    }

    // ============================================
    // PHASE 2: Build step time ranges from API data
    // ============================================
    interface StepBucket {
      step: StepData;
      displayIndex: number;
      startMs: number;
      endMs: number;
      groups: RawGroup[];
      ungroupedLines: string[];
    }

    const stepBuckets: StepBucket[] = steps.map((step, idx) => ({
      step,
      displayIndex: idx + 1,
      startMs: step.startedAt ? new Date(step.startedAt).getTime() : 0,
      endMs: step.completedAt ? new Date(step.completedAt).getTime() : Infinity,
      groups: [],
      ungroupedLines: [],
    }));

    // Sort by start time
    stepBuckets.sort((a, b) => a.startMs - b.startMs);

    /**
     * Find the step bucket that contains a given timestamp.
     *
     * Due to GitHub API timestamp granularity (seconds vs milliseconds in logs),
     * we use this heuristic:
     * 1. Collect all steps that contain the timestamp (with 999ms buffer on end)
     * 2. Prefer steps where timestamp is in the CORE (unadjusted) range
     * 3. Prefer the step with smallest displayIndex (preserve step order)
     */
    function findStepForTimestamp(ts: number | undefined): StepBucket | undefined {
      if (ts === undefined) {
        return undefined;
      }

      const matches: { bucket: StepBucket; isCore: boolean }[] = [];
      for (const bucket of stepBuckets) {
        const adjustedEndMs = bucket.endMs + 999;
        if (ts >= bucket.startMs && ts <= adjustedEndMs) {
          const isCore = ts >= bucket.startMs && ts <= bucket.endMs;
          matches.push({ bucket, isCore });
        }
      }

      if (matches.length === 0) {
        // Fallback: find the MOST RECENT step that started before this timestamp
        let mostRecent: StepBucket | undefined;
        let mostRecentStart = -Infinity;
        for (const bucket of stepBuckets) {
          if (bucket.startMs <= ts && bucket.startMs > mostRecentStart) {
            mostRecentStart = bucket.startMs;
            mostRecent = bucket;
          }
        }
        return mostRecent;
      }

      if (matches.length === 1) {
        return matches[0].bucket;
      }

      // Prefer core matches
      const coreMatches = matches.filter((m) => m.isCore);
      if (coreMatches.length >= 1) {
        coreMatches.sort((a, b) => a.bucket.displayIndex - b.bucket.displayIndex);
        return coreMatches[0].bucket;
      }

      // No core matches - use smallest displayIndex
      matches.sort((a, b) => a.bucket.displayIndex - b.bucket.displayIndex);
      return matches[0].bucket;
    }

    // ============================================
    // PHASE 3: Assign groups to steps based on timestamps + name heuristics
    // ============================================

    // Known groups that belong to "Set up job" / "Set up runner" step (GitHub Actions standard)
    const setupJobGroups = new Set([
      'Runner Image Provisioner',
      'Operating System',
      'Runner Image',
      'GITHUB_TOKEN Permissions',
      'Secret source',
      'Prepare workflow directory',
      'Prepare all required actions',
      'Getting action download info',
      'EC2', // Self-hosted runner EC2 info
    ]);

    /**
     * Check if a group name is related to setup (Set up job/runner).
     * This includes known group names and self-hosted runner hook scripts.
     */
    function isSetupRelatedGroup(groupName: string): boolean {
      if (setupJobGroups.has(groupName)) {
        return true;
      }
      // Self-hosted runner hook scripts
      if (groupName.match(/^Run '\/opt\/actions-runner\/hook_.*\.sh'$/)) {
        return true;
      }
      // Numbered hook sub-scripts (e.g., "##-script_name.sh")
      if (groupName.match(/^\d+-\w+\.sh$/)) {
        return true;
      }
      return false;
    }

    // Known groups that belong to checkout actions
    const checkoutGroups = new Set([
      'Getting Git version info',
      'Initializing the repository',
      'Disabling automatic garbage collection',
      'Setting up auth',
      'Fetching the repository',
      'Determining the checkout info',
      'Checking out the ref',
    ]);

    // Find special buckets - handle both "Set up job" and "Set up runner" (self-hosted)
    const setupJobBucket = stepBuckets.find(
      (b) => b.step.name === 'Set up job' || b.step.name === 'Set up runner'
    );
    const checkoutBuckets = stepBuckets.filter(
      (b) =>
        b.step.name.toLowerCase().includes('checkout') &&
        !b.step.name.toLowerCase().includes('post')
    );

    const orphanedGroups: RawGroup[] = [];

    for (const group of allGroups) {
      // Special case: known "Set up job" / "Set up runner" groups
      if (setupJobBucket && isSetupRelatedGroup(group.name)) {
        setupJobBucket.groups.push(group);
        continue;
      }

      // Special case: checkout-related groups
      if (checkoutBuckets.length > 0 && checkoutGroups.has(group.name)) {
        let bestBucket = checkoutBuckets[0];
        if (group.firstTimestamp !== undefined) {
          for (const bucket of checkoutBuckets) {
            if (bucket.startMs <= group.firstTimestamp) {
              bestBucket = bucket;
            }
          }
        }
        bestBucket.groups.push(group);
        continue;
      }

      // Special case: "Run actions/checkout@..." groups
      if (checkoutBuckets.length > 0 && group.name.startsWith('Run actions/checkout')) {
        let bestBucket = checkoutBuckets[0];
        if (group.firstTimestamp !== undefined) {
          for (const bucket of checkoutBuckets) {
            if (bucket.startMs <= group.firstTimestamp) {
              bestBucket = bucket;
            }
          }
        }
        bestBucket.groups.push(group);
        continue;
      }

      // Special case: "Run actions/upload-artifact@..." groups
      if (group.name.startsWith('Run actions/upload-artifact')) {
        const uploadBucket = stepBuckets.find((b) => b.step.name.toLowerCase().includes('upload'));
        if (uploadBucket) {
          uploadBucket.groups.push(group);
          continue;
        }
      }

      // Try to match "Run <command>" groups to steps by command content
      if (group.name.startsWith('Run ')) {
        const groupCommand = group.name.slice(4).toLowerCase();
        let matchedBucket: StepBucket | null = null;

        for (const bucket of stepBuckets) {
          const stepNameLower = bucket.step.name.toLowerCase();

          // Match "Run ./.github/actions/<action-name>" to step containing that action name
          if (groupCommand.startsWith('./.github/actions/')) {
            const actionName = groupCommand.slice('./.github/actions/'.length).split('/')[0];
            const actionNameNormalized = actionName.replace(/-/g, ' ').replace(/_/g, ' ');
            if (
              stepNameLower.includes(actionNameNormalized) ||
              stepNameLower.replace(/-/g, ' ').replace(/_/g, ' ').includes(actionNameNormalized)
            ) {
              matchedBucket = bucket;
              break;
            }
          }

          // Match variable assignments like "Run IDENTIFIER=..." to steps with related names
          if (groupCommand.match(/^[a-z_][a-z0-9_]*=/i)) {
            const varName = groupCommand.split('=')[0].toLowerCase();
            if (stepNameLower.includes(varName)) {
              matchedBucket = bucket;
              break;
            }
          }

          // e.g., "mkdir -p reports" matches "Generate security report"
          if (
            groupCommand.includes('mkdir') &&
            stepNameLower.includes('report') &&
            stepNameLower.includes('generate')
          ) {
            matchedBucket = bucket;
            break;
          }
          // e.g., "echo "# 🔒 Security Scan Results"" matches "Generate security summary"
          if (
            groupCommand.includes('summary') ||
            (groupCommand.includes('security') &&
              groupCommand.includes('scan') &&
              groupCommand.includes('results'))
          ) {
            if (stepNameLower.includes('summary')) {
              matchedBucket = bucket;
              break;
            }
          }
        }

        if (matchedBucket) {
          matchedBucket.groups.push(group);
          continue;
        }

        // If no special match found for "Run <command>" groups:
        // These are typically shell commands that represent actual step execution.
        // If timestamp would assign to setup step but this is NOT a setup-related command,
        // it likely belongs to the next step in order.
        const timestampBucket = findStepForTimestamp(group.firstTimestamp);
        const isSetupStep =
          timestampBucket?.step.name === 'Set up job' ||
          timestampBucket?.step.name === 'Set up runner';
        if (timestampBucket && isSetupStep && !isSetupRelatedGroup(group.name)) {
          // Find the next step after setup by displayIndex
          const nextStep = stepBuckets.find((b) => b.displayIndex > timestampBucket.displayIndex);
          if (nextStep) {
            nextStep.groups.push(group);
            continue;
          }
        }

        // Fall through to default timestamp assignment below
      }

      // Default: use timestamp-based assignment
      const bucket = findStepForTimestamp(group.firstTimestamp);
      if (bucket) {
        bucket.groups.push(group);
      } else {
        orphanedGroups.push(group);
      }
    }

    // Assign ungrouped lines to steps
    // Strategy:
    // 1. Use content-based heuristics for special patterns (Post job cleanup, etc.)
    // 2. Then check if the line falls within a step's API time range
    // 3. Fall back to surrounding groups
    const orphanedLines: string[] = [];

    // Build a sorted list of (timestamp, bucket) pairs from groups
    const groupTimestampBuckets: { ts: number; bucket: StepBucket }[] = [];
    for (const bucket of stepBuckets) {
      for (const group of bucket.groups) {
        if (group.firstTimestamp !== undefined) {
          groupTimestampBuckets.push({ ts: group.firstTimestamp, bucket });
        }
      }
    }
    groupTimestampBuckets.sort((a, b) => a.ts - b.ts);

    // Find special steps by name
    const postCheckoutStep = stepBuckets.find((b) =>
      b.step.name.toLowerCase().includes('post checkout')
    );
    const completeJobStep = stepBuckets.find((b) => b.step.name.toLowerCase() === 'complete job');

    // Track when we've seen special markers
    let inPostCleanup = false;
    let inCompleteJob = false;

    for (const item of ungroupedLines) {
      let assignedBucket: StepBucket | undefined = undefined;
      const lineContent = item.line.toLowerCase();

      // Content-based heuristics for special patterns
      if (lineContent.includes('post job cleanup')) {
        inPostCleanup = true;
        inCompleteJob = false;
      } else if (lineContent.includes('cleaning up orphan processes')) {
        inCompleteJob = true;
        inPostCleanup = false;
      }

      // Assign based on current state
      if (inCompleteJob && completeJobStep) {
        assignedBucket = completeJobStep;
      } else if (inPostCleanup && postCheckoutStep) {
        assignedBucket = postCheckoutStep;
      }

      // Special handling for action preparation lines
      // "Prepare all required actions" and "Getting action download info" appear:
      // 1. At the start of workflow (before any Run group) - these go to "Set up job"
      // 2. Between steps (after a Run group ends) - these go to the NEXT step
      const isActionPrepLine =
        lineContent === 'prepare all required actions' ||
        lineContent === 'getting action download info' ||
        lineContent.startsWith('download action repository');

      if (!assignedBucket && isActionPrepLine && item.timestamp !== undefined) {
        // Find the previous group that ended before this line
        let prevGroupEntry: { ts: number; bucket: StepBucket } | undefined = undefined;
        for (const entry of groupTimestampBuckets) {
          if (entry.ts <= item.timestamp) {
            prevGroupEntry = entry;
          } else {
            break;
          }
        }

        // Check if there's a previous "Run ..." group - if so, assign to NEXT step
        // If no previous "Run ..." group, these are initial setup lines for "Set up job"
        const hasPreviousRunGroup =
          prevGroupEntry !== undefined &&
          prevGroupEntry.bucket.groups.some((g) => g.name.startsWith('Run '));

        if (hasPreviousRunGroup) {
          // Find the next log group and assign to its step
          for (const entry of groupTimestampBuckets) {
            if (entry.ts > item.timestamp) {
              assignedBucket = entry.bucket;
              break;
            }
          }
        }
        // If no previous Run group, let the normal timestamp-based assignment handle it
        // (it will assign to Set up job based on the timestamp)
      }

      // If not assigned by heuristics, use timestamp-based matching
      if (!assignedBucket && item.timestamp !== undefined) {
        // Find previous and next group relative to this line
        let prevGroupEntry: { ts: number; bucket: StepBucket } | undefined = undefined;
        let nextGroupEntry: { ts: number; bucket: StepBucket } | undefined = undefined;
        for (const entry of groupTimestampBuckets) {
          if (entry.ts <= item.timestamp) {
            prevGroupEntry = entry;
          } else if (!nextGroupEntry) {
            nextGroupEntry = entry;
            break;
          }
        }

        // Find all steps whose API time range contains this timestamp
        const matchingSteps = stepBuckets.filter((bucket) => {
          const bufferMs = 999;
          return (
            item.timestamp !== undefined &&
            item.timestamp >= bucket.startMs &&
            item.timestamp <= bucket.endMs + bufferMs
          );
        });

        if (matchingSteps.length === 1) {
          assignedBucket = matchingSteps[0];
        } else if (matchingSteps.length > 1) {
          // Multiple steps match - use surrounding groups to decide
          if (prevGroupEntry && matchingSteps.includes(prevGroupEntry.bucket)) {
            assignedBucket = prevGroupEntry.bucket;
          } else if (nextGroupEntry && matchingSteps.includes(nextGroupEntry.bucket)) {
            assignedBucket = nextGroupEntry.bucket;
          } else {
            // Fall back to the step with the smallest displayIndex
            assignedBucket = matchingSteps.reduce((a, b) =>
              a.displayIndex < b.displayIndex ? a : b
            );
          }
        } else {
          // No step matches by time - use surrounding groups
          if (prevGroupEntry) {
            assignedBucket = prevGroupEntry.bucket;
          } else if (nextGroupEntry) {
            assignedBucket = nextGroupEntry.bucket;
          }
        }

        // Final fallback
        if (!assignedBucket) {
          assignedBucket = findStepForTimestamp(item.timestamp);
        }
      }

      if (assignedBucket) {
        assignedBucket.ungroupedLines.push(item.line);
      } else {
        orphanedLines.push(item.line);
      }
    }

    // ============================================
    // PHASE 4: Build final LogGroup structure
    // ============================================
    let groupIdCounter = 0;
    const finalGroups: LogGroup[] = [];

    /**
     * Convert RawGroup to LogGroup recursively
     */
    function convertRawGroup(raw: RawGroup, shouldExpand: boolean): LogGroup {
      groupIdCounter++;
      return {
        id: `group-${groupIdCounter}`,
        name: raw.name,
        lines: raw.lines,
        children: raw.children.map((child) => convertRawGroup(child, shouldExpand)),
        expanded: shouldExpand,
        isNested: true,
        stepIndex: 0,
      };
    }

    // Re-sort buckets by display index for final output
    stepBuckets.sort((a, b) => a.displayIndex - b.displayIndex);

    for (const bucket of stepBuckets) {
      const shouldExpand =
        (targetStep !== undefined && targetStep === bucket.step.number) ||
        (targetName !== undefined &&
          bucket.step.name.toLowerCase().includes(targetName.toLowerCase()));

      groupIdCounter++;
      const stepGroupId = `group-step-${bucket.displayIndex}`;

      if (shouldExpand && !targetGroupId) {
        targetGroupId = stepGroupId;
      }

      // Convert nested groups to children
      const children = bucket.groups.map((g) => convertRawGroup(g, shouldExpand));

      finalGroups.push({
        id: stepGroupId,
        name: bucket.step.name,
        lines: bucket.ungroupedLines, // Ungrouped lines go directly under the step
        children,
        expanded: shouldExpand,
        isNested: false,
        stepIndex: bucket.displayIndex,
        duration: bucket.step.duration,
        conclusion: bucket.step.conclusion,
      });
    }

    // Add orphaned content if any
    if (orphanedGroups.length > 0 || orphanedLines.length > 0) {
      const orphanedChildren = orphanedGroups.map((g) => convertRawGroup(g, false));
      finalGroups.push({
        id: 'group-orphaned',
        name: '⚠️ Unmatched Logs',
        lines:
          orphanedLines.length > 0
            ? [
                '--- These logs could not be matched to a specific step based on timestamps. ---',
                '',
                ...orphanedLines,
              ]
            : [],
        children: orphanedChildren,
        expanded: false,
        isNested: false,
        stepIndex: -1,
        isOrphaned: true,
      });
    }

    return { groups: finalGroups, rawLines: lines };
  }

  /**
   * Strip ANSI escape codes
   */
  function stripAnsiCodes(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\[\d+(?:;\d+)*m/g, '');
  }

  /**
   * Toggle group expansion
   */
  function toggleGroup(group: LogGroup) {
    group.expanded = !group.expanded;
    parsedLogs = parsedLogs; // Trigger reactivity
  }

  /**
   * Expand all groups recursively
   */
  function expandAll() {
    function expand(groups: LogGroup[]) {
      for (const g of groups) {
        g.expanded = true;
        expand(g.children);
      }
    }
    expand(parsedLogs.groups);
    parsedLogs = parsedLogs;
  }

  /**
   * Collapse all groups recursively
   */
  function collapseAll() {
    function collapse(groups: LogGroup[]) {
      for (const g of groups) {
        g.expanded = false;
        collapse(g.children);
      }
    }
    collapse(parsedLogs.groups);
    parsedLogs = parsedLogs;
  }

  /**
   * Scroll to a specific group by ID
   */
  function scrollToGroup(groupId: string) {
    const element = document.getElementById(groupId);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Add highlight effect
      element.classList.add('highlight');
      setTimeout(() => element.classList.remove('highlight'), 2000);
    }
  }

  /**
   * Refresh logs
   */
  function refresh() {
    loading = true;
    vscode.postMessage({ type: 'refresh' });
  }

  /**
   * Toggle timestamps visibility
   */
  function toggleTimestamps() {
    showTimestamps = !showTimestamps;
    // Re-parse logs with/without timestamps
    parsedLogs = parseLogs(rawLogs, stepNumber, stepName, stepsData);
  }

  /**
   * Download logs as text file
   */
  function downloadLogs() {
    vscode.postMessage({ type: 'downloadLogs' });
  }

  /**
   * Open an external URL in the user's default browser
   */
  function openUrl(url: string) {
    vscode.postMessage({ type: 'openUrl', url });
  }

  /**
   * Format a log line with error highlighting and clickable URLs
   * Returns an object indicating if it's an error line and the formatted parts
   */
  interface FormattedLine {
    isError: boolean;
    parts: Array<{ type: 'text' | 'url' | 'error-prefix'; content: string }>;
  }

  function formatLogLine(line: string): FormattedLine {
    // Check for ##[error] marker
    const errorMatch = line.match(/^##\[error\](.*)$/);
    const isError = errorMatch !== null;
    const cleanedLine = isError ? errorMatch[1] : line;

    // URL regex pattern
    // eslint-disable-next-line no-useless-escape
    const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/g;

    const parts: FormattedLine['parts'] = [];

    // Add error prefix if this is an error line
    if (isError) {
      parts.push({ type: 'error-prefix', content: 'Error: ' });
    }

    // Split the line by URLs and create parts
    let lastIndex = 0;
    let match;

    while ((match = urlRegex.exec(cleanedLine)) !== null) {
      // Add text before the URL
      if (match.index > lastIndex) {
        parts.push({ type: 'text', content: cleanedLine.slice(lastIndex, match.index) });
      }
      // Add the URL
      parts.push({ type: 'url', content: match[0] });
      lastIndex = match.index + match[0].length;
    }

    // Add remaining text after the last URL
    if (lastIndex < cleanedLine.length) {
      parts.push({ type: 'text', content: cleanedLine.slice(lastIndex) });
    }

    // If no parts were added (empty line), add empty text
    if (parts.length === 0 || (parts.length === 1 && parts[0].type === 'error-prefix')) {
      parts.push({ type: 'text', content: '' });
    }

    return { isError, parts };
  }

  /**
   * Open raw logs in VSCode text editor
   */
  function viewRawLogs() {
    vscode.postMessage({ type: 'viewRawLogs' });
  }

  /**
   * Toggle search panel visibility
   */
  function toggleSearch() {
    showSearch = !showSearch;
    if (showSearch) {
      // Focus search input after render
      setTimeout(() => {
        const input = document.querySelector('.search-input') as HTMLInputElement;
        input?.focus();
      }, 50);
    } else {
      clearSearch();
    }
  }

  /**
   * Clear search state
   */
  function clearSearch() {
    searchQuery = '';
    searchMatches = [];
    currentSearchIndex = -1;
  }

  /**
   * Perform search in all log lines
   * Supports case-sensitive and regex search modes
   */
  function performSearch() {
    regexError = null;

    if (!searchQuery.trim()) {
      searchMatches = [];
      currentSearchIndex = -1;
      return;
    }

    const matches: { groupId: string; lineIndex: number }[] = [];

    // Build the matcher function based on search options
    let matchLine: (line: string) => boolean;

    if (regexSearch) {
      try {
        const flags = caseSensitiveSearch ? 'g' : 'gi';
        const regex = new RegExp(searchQuery, flags);
        matchLine = (line: string) => regex.test(line);
      } catch (e) {
        regexError = e instanceof Error ? e.message : 'Invalid regex pattern';
        searchMatches = [];
        currentSearchIndex = -1;
        return;
      }
    } else {
      // Plain text search
      const query = caseSensitiveSearch ? searchQuery : searchQuery.toLowerCase();
      matchLine = caseSensitiveSearch
        ? (line: string) => line.includes(query)
        : (line: string) => line.toLowerCase().includes(query);
    }

    function searchInGroup(group: LogGroup) {
      group.lines.forEach((line, lineIndex) => {
        if (matchLine(line)) {
          matches.push({ groupId: group.id, lineIndex });
        }
      });
      group.children.forEach(searchInGroup);
    }

    parsedLogs.groups.forEach(searchInGroup);
    searchMatches = matches;
    currentSearchIndex = matches.length > 0 ? 0 : -1;

    // Navigate to first match
    if (currentSearchIndex >= 0) {
      navigateToMatch(currentSearchIndex);
    }
  }

  /**
   * Toggle case-sensitive search
   */
  function toggleCaseSensitive() {
    caseSensitiveSearch = !caseSensitiveSearch;
    performSearch();
  }

  /**
   * Toggle regex search mode
   */
  function toggleRegex() {
    regexSearch = !regexSearch;
    performSearch();
  }

  /**
   * Navigate to a specific search match
   */
  function navigateToMatch(index: number) {
    if (index < 0 || index >= searchMatches.length) {
      return;
    }

    const match = searchMatches[index];
    const group = findGroupById(match.groupId);
    if (group) {
      // Expand the group and all ancestors
      expandGroupAndAncestors(group.id);
      // Scroll to the group
      setTimeout(() => scrollToGroup(match.groupId), 100);
    }
  }

  /**
   * Find a group by ID recursively
   */
  function findGroupById(id: string): LogGroup | null {
    function search(groups: LogGroup[]): LogGroup | null {
      for (const g of groups) {
        if (g.id === id) {
          return g;
        }
        const found = search(g.children);
        if (found) {
          return found;
        }
      }
      return null;
    }
    return search(parsedLogs.groups);
  }

  /**
   * Expand a group and all its ancestors
   */
  function expandGroupAndAncestors(targetId: string) {
    function expandPath(groups: LogGroup[]): boolean {
      for (const g of groups) {
        if (g.id === targetId) {
          g.expanded = true;
          return true;
        }
        if (expandPath(g.children)) {
          g.expanded = true;
          return true;
        }
      }
      return false;
    }
    expandPath(parsedLogs.groups);
    parsedLogs = parsedLogs; // Trigger reactivity
  }

  /**
   * Go to next search match
   */
  function nextMatch() {
    if (searchMatches.length === 0) {
      return;
    }
    currentSearchIndex = (currentSearchIndex + 1) % searchMatches.length;
    navigateToMatch(currentSearchIndex);
  }

  /**
   * Go to previous search match
   */
  function prevMatch() {
    if (searchMatches.length === 0) {
      return;
    }
    currentSearchIndex =
      currentSearchIndex <= 0 ? searchMatches.length - 1 : currentSearchIndex - 1;
    navigateToMatch(currentSearchIndex);
  }

  /**
   * Handle search input keydown
   * Supports keyboard shortcuts for search options
   */
  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      toggleSearch();
    } else if (event.key === 'Enter') {
      if (event.shiftKey) {
        prevMatch();
      } else {
        nextMatch();
      }
    } else if (event.altKey && (event.key === 'c' || event.key === 'C')) {
      // Alt+C: Toggle case-sensitive search
      event.preventDefault();
      toggleCaseSensitive();
    } else if (event.altKey && (event.key === 'r' || event.key === 'R')) {
      // Alt+R: Toggle regex search
      event.preventDefault();
      toggleRegex();
    }
  }

  /**
   * Jump to the first failed step
   */
  function jumpToFailed() {
    const failedGroup = parsedLogs.groups.find((g) => g.conclusion === 'failure');
    if (failedGroup) {
      failedGroup.expanded = true;
      parsedLogs = parsedLogs; // Trigger reactivity
      setTimeout(() => scrollToGroup(failedGroup.id), 100);
    }
  }

  /**
   * Copy all logs to clipboard
   */
  function copyAllLogs() {
    navigator.clipboard.writeText(rawLogs).then(
      () => {
        // Show brief feedback (would need toast notification in real implementation)
        console.log('Logs copied to clipboard');
      },
      (err) => {
        console.error('Failed to copy logs:', err);
      }
    );
  }

  /**
   * Check if line matches current search query
   * Respects case-sensitive and regex search options
   */
  function lineMatchesSearch(line: string): boolean {
    if (!searchQuery.trim()) {
      return false;
    }

    if (regexSearch) {
      try {
        const flags = caseSensitiveSearch ? 'g' : 'gi';
        const regex = new RegExp(searchQuery, flags);
        return regex.test(line);
      } catch {
        return false;
      }
    }

    return caseSensitiveSearch
      ? line.includes(searchQuery)
      : line.toLowerCase().includes(searchQuery.toLowerCase());
  }
</script>

<div class="log-viewer">
  <div class="header">
    <div class="title">
      <span class="codicon codicon-output"></span>
      <h2>{stepName || jobName}</h2>
    </div>
    <div class="actions">
      <button
        class="icon-button"
        class:active={showSearch}
        on:click={toggleSearch}
        title="Search (Ctrl+F)"
      >
        <span class="codicon codicon-search"></span>
      </button>
      <button
        class="icon-button"
        class:active={showTimestamps}
        on:click={toggleTimestamps}
        title={showTimestamps ? 'Hide Timestamps' : 'Show Timestamps'}
      >
        <span class="codicon codicon-clock"></span>
      </button>
      <div class="separator"></div>
      {#if parsedLogs.groups.some((g) => g.conclusion === 'failure')}
        <button class="icon-button failed-indicator" on:click={jumpToFailed} title="Jump to Failed">
          <span class="codicon codicon-error"></span>
        </button>
      {/if}
      <button class="icon-button" on:click={expandAll} title="Expand All">
        <span class="codicon codicon-expand-all"></span>
      </button>
      <button class="icon-button" on:click={collapseAll} title="Collapse All">
        <span class="codicon codicon-collapse-all"></span>
      </button>
      <div class="separator"></div>
      <button class="icon-button" on:click={copyAllLogs} title="Copy All Logs">
        <span class="codicon codicon-copy"></span>
      </button>
      <button class="icon-button" on:click={downloadLogs} title="Download Logs">
        <span class="codicon codicon-cloud-download"></span>
      </button>
      <button class="icon-button" on:click={viewRawLogs} title="View Raw Logs in Editor">
        <span class="codicon codicon-go-to-file"></span>
      </button>
      <button class="icon-button" on:click={refresh} title="Refresh" disabled={loading}>
        <span class="codicon codicon-refresh" class:spinning={loading}></span>
      </button>
    </div>
  </div>

  <!-- Search Bar -->
  {#if showSearch}
    <div class="search-bar">
      <div class="search-input-wrapper">
        <input
          type="text"
          class="search-input"
          class:regex-error={regexError}
          placeholder={regexSearch ? 'Search with regex...' : 'Search logs...'}
          bind:value={searchQuery}
          on:input={performSearch}
          on:keydown={handleSearchKeydown}
        />
        <div class="search-options">
          <button
            class="search-option-button"
            class:active={caseSensitiveSearch}
            on:click={toggleCaseSensitive}
            title="Match Case (Alt+C)"
          >
            Aa
          </button>
          <button
            class="search-option-button"
            class:active={regexSearch}
            on:click={toggleRegex}
            title="Use Regular Expression (Alt+R)"
          >
            .*
          </button>
        </div>
      </div>
      <span class="search-count">
        {#if regexError}
          <span class="search-error" title={regexError}>Invalid regex</span>
        {:else if searchMatches.length > 0}
          {currentSearchIndex + 1} of {searchMatches.length}
        {:else if searchQuery.trim()}
          No results
        {/if}
      </span>
      <button
        class="search-nav-button"
        on:click={prevMatch}
        disabled={searchMatches.length === 0}
        title="Previous Match (Shift+Enter)"
      >
        <span class="codicon codicon-arrow-up"></span>
      </button>
      <button
        class="search-nav-button"
        on:click={nextMatch}
        disabled={searchMatches.length === 0}
        title="Next Match (Enter)"
      >
        <span class="codicon codicon-arrow-down"></span>
      </button>
      <button class="search-nav-button" on:click={toggleSearch} title="Close Search (Esc)">
        <span class="codicon codicon-close"></span>
      </button>
    </div>
  {/if}

  <!-- Disclaimer Banner -->
  {#if showDisclaimer && !loading && !error}
    <div class="disclaimer-banner">
      <span class="codicon codicon-info"></span>
      <span class="disclaimer-text"
        ><strong>[Beta]</strong> Log groups may appear in wrong steps.
        <button class="inline-link" on:click={viewRawLogs} title="View Raw Logs"
          >View Raw Logs</button
        > to verify exact output.</span
      >
      <button
        class="dismiss-button"
        on:click={() => (showDisclaimer = false)}
        title="Dismiss"
        aria-label="Dismiss disclaimer"
      >
        <span class="codicon codicon-close"></span>
      </button>
    </div>
  {/if}

  <div class="content">
    {#if loading}
      <div class="loading">
        <span class="codicon codicon-loading spinning"></span>
        <span>Loading logs...</span>
      </div>
    {:else if error}
      <div class="error">
        <span class="codicon codicon-error"></span>
        <span>{error}</span>
      </div>
    {:else if parsedLogs.groups.length === 0}
      <div class="empty">
        <span class="codicon codicon-info"></span>
        <span>No logs available</span>
      </div>
    {:else}
      <div class="groups">
        {#each parsedLogs.groups as group (group.id)}
          <div
            id={group.id}
            class="group"
            class:nested={group.isNested}
            class:failed={group.conclusion === 'failure'}
            class:orphaned={group.isOrphaned}
          >
            <button class="group-header" on:click={() => toggleGroup(group)}>
              <span
                class="chevron codicon codicon-{group.expanded ? 'chevron-down' : 'chevron-right'}"
              ></span>
              {#if group.conclusion === 'failure'}
                <span class="status-icon failed" title="Failed">
                  <span class="codicon codicon-error"></span>
                </span>
              {:else if group.isOrphaned}
                <span class="status-icon warning" title="Unmatched Logs">
                  <span class="codicon codicon-warning"></span>
                </span>
              {/if}
              <span class="group-name">{group.name}</span>
              {#if group.duration !== undefined}
                <span class="step-duration">{formatDuration(group.duration)}</span>
              {/if}
            </button>
            {#if group.expanded}
              <div class="group-content">
                {#if group.isOrphaned}
                  <div class="orphaned-actions">
                    <button on:click={viewRawLogs} title="View raw logs in text editor">
                      <span class="codicon codicon-file-code"></span>
                      View Raw Logs
                    </button>
                  </div>
                {/if}
                <!-- Render children groups FIRST (matches GitHub UI order) -->
                {#each group.children as child (child.id)}
                  <div id={child.id} class="group nested-child">
                    <button class="group-header" on:click={() => toggleGroup(child)}>
                      <span
                        class="chevron codicon codicon-{child.expanded
                          ? 'chevron-down'
                          : 'chevron-right'}"
                      ></span>
                      <span class="group-name">{child.name}</span>
                    </button>
                    {#if child.expanded}
                      <div class="group-content">
                        {#each child.lines as childLine, childIdx (childIdx)}
                          {@const childFormatted = formatLogLine(childLine)}
                          <pre
                            class="log-line"
                            class:search-match={lineMatchesSearch(childLine)}
                            class:error-line={childFormatted.isError}>{#each childFormatted.parts as part, partIdx (partIdx)}{#if part.type === 'error-prefix'}<span
                                  class="error-prefix">{part.content}</span
                                >{:else if part.type === 'url'}<button
                                  class="log-url"
                                  on:click={() => openUrl(part.content)}
                                  title="Open in browser: {part.content}">{part.content}</button
                                >{:else}{part.content}{/if}{/each}</pre>
                        {/each}
                        <!-- Render deeply nested groups (level 2+) -->
                        {#each child.children as grandchild (grandchild.id)}
                          <div id={grandchild.id} class="group nested-child">
                            <button class="group-header" on:click={() => toggleGroup(grandchild)}>
                              <span
                                class="chevron codicon codicon-{grandchild.expanded
                                  ? 'chevron-down'
                                  : 'chevron-right'}"
                              ></span>
                              <span class="group-name">{grandchild.name}</span>
                            </button>
                            {#if grandchild.expanded}
                              <div class="group-content">
                                {#each grandchild.lines as grandLine, grandIdx (grandIdx)}
                                  {@const grandFormatted = formatLogLine(grandLine)}
                                  <pre
                                    class="log-line"
                                    class:search-match={lineMatchesSearch(grandLine)}
                                    class:error-line={grandFormatted.isError}>{#each grandFormatted.parts as part, gPartIdx (gPartIdx)}{#if part.type === 'error-prefix'}<span
                                          class="error-prefix">{part.content}</span
                                        >{:else if part.type === 'url'}<button
                                          class="log-url"
                                          on:click={() => openUrl(part.content)}
                                          title="Open in browser: {part.content}"
                                          >{part.content}</button
                                        >{:else}{part.content}{/if}{/each}</pre>
                                {/each}
                              </div>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
                <!-- Render ungrouped lines AFTER children groups (matches GitHub UI order) -->
                {#each group.lines as line, lineIdx (lineIdx)}
                  {@const formatted = formatLogLine(line)}
                  <pre
                    class="log-line"
                    class:search-match={lineMatchesSearch(line)}
                    class:error-line={formatted.isError}>{#each formatted.parts as part, pIdx (pIdx)}{#if part.type === 'error-prefix'}<span
                          class="error-prefix">{part.content}</span
                        >{:else if part.type === 'url'}<button
                          class="log-url"
                          on:click={() => openUrl(part.content)}
                          title="Open in browser: {part.content}">{part.content}</button
                        >{:else}{part.content}{/if}{/each}</pre>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .log-viewer {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
  }

  .title {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .title h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .separator {
    width: 1px;
    height: 16px;
    background: var(--vscode-panel-border);
    margin: 0 4px;
  }

  .icon-button {
    background: transparent;
    border: none;
    color: var(--vscode-foreground);
    padding: 4px 8px;
    cursor: pointer;
    border-radius: 4px;
    opacity: 0.8;
  }

  .icon-button.failed-indicator {
    color: var(--vscode-testing-iconFailed, #f85149);
    opacity: 1;
  }

  /* Search bar styles */
  .search-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .search-input-wrapper {
    flex: 1;
    display: flex;
    align-items: center;
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    background: var(--vscode-input-background);
    overflow: hidden;
  }

  .search-input-wrapper:focus-within {
    border-color: var(--vscode-focusBorder);
  }

  .search-input {
    flex: 1;
    padding: 6px 10px;
    border: none;
    background: transparent;
    color: var(--vscode-input-foreground);
    font-size: 13px;
    outline: none;
  }

  .search-input.regex-error {
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground));
  }

  .search-options {
    display: flex;
    gap: 2px;
    padding: 2px 4px;
    border-left: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
  }

  .search-option-button {
    background: transparent;
    border: 1px solid transparent;
    color: var(--vscode-descriptionForeground);
    padding: 2px 6px;
    cursor: pointer;
    border-radius: 3px;
    font-size: 12px;
    font-weight: 600;
    font-family: var(--vscode-font-family);
    opacity: 0.7;
    transition: all 0.15s ease;
  }

  .search-option-button:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }

  .search-option-button.active {
    opacity: 1;
    color: var(--vscode-inputOption-activeForeground, var(--vscode-button-foreground));
    background: var(--vscode-inputOption-activeBackground, var(--vscode-button-background));
    border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
  }

  .search-count {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    min-width: 80px;
    text-align: center;
  }

  .search-error {
    color: var(--vscode-errorForeground, #f85149);
    font-size: 11px;
  }

  .search-nav-button {
    background: transparent;
    border: none;
    color: var(--vscode-foreground);
    padding: 4px 6px;
    cursor: pointer;
    border-radius: 4px;
    opacity: 0.8;
  }

  .search-nav-button:hover:not(:disabled) {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }

  .search-nav-button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Disclaimer banner styles - subtle informational message */
  .disclaimer-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    background: transparent;
    border-bottom: 1px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    line-height: 1.4;
  }

  .disclaimer-banner > .codicon-info {
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
    opacity: 0.7;
  }

  .disclaimer-text {
    flex: 1;
  }

  .disclaimer-banner .inline-link {
    background: transparent;
    border: none;
    color: var(--vscode-textLink-foreground, #3794ff);
    cursor: pointer;
    padding: 0;
    margin: 0;
    font-size: inherit;
    font-family: inherit;
    text-decoration: underline;
  }

  .disclaimer-banner .inline-link:hover {
    color: var(--vscode-textLink-activeForeground, #3794ff);
  }

  .dismiss-button {
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 2px;
    border-radius: 3px;
    opacity: 0.5;
    flex-shrink: 0;
  }

  .dismiss-button:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
  }

  .icon-button:hover:not(:disabled) {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }

  .icon-button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .icon-button.active {
    opacity: 1;
    background: var(--vscode-toolbar-activeBackground, rgba(255, 255, 255, 0.1));
    color: var(--vscode-focusBorder, #007acc);
  }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }

  .loading,
  .error,
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 32px;
    color: var(--vscode-descriptionForeground);
  }

  .error {
    color: var(--vscode-errorForeground);
  }

  .groups {
    padding: 0 8px;
  }

  .group {
    margin-bottom: 2px;
  }

  /* Top-level nested groups (e.g., when parsedLogs has nested structure) */
  .group.nested {
    margin-left: 16px;
  }

  /* Nested child groups within group-content - no extra indentation needed */
  /* They align with log lines since group-content already has padding */
  .group.nested-child {
    margin-left: 0;
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 6px 8px;
    background: var(--vscode-list-hoverBackground);
    border: none;
    border-radius: 4px;
    color: var(--vscode-foreground);
    cursor: pointer;
    text-align: left;
    font-size: 13px;
  }

  .group-header:hover {
    background: var(--vscode-list-activeSelectionBackground);
  }

  .chevron {
    flex-shrink: 0;
    font-size: 12px;
  }

  .group-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .step-duration {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    flex-shrink: 0;
    margin-left: 8px;
  }

  .status-icon {
    flex-shrink: 0;
    font-size: 14px;
    margin-right: 4px;
  }

  .status-icon.failed {
    color: var(--vscode-testing-iconFailed, #f85149);
  }

  .status-icon.warning {
    color: var(--vscode-editorWarning-foreground, #cca700);
  }

  /* Failed group styling */
  .group.failed > .group-header {
    background: color-mix(in srgb, var(--vscode-testing-iconFailed, #f85149) 10%, transparent);
    border-left: 3px solid var(--vscode-testing-iconFailed, #f85149);
  }

  .group.failed > .group-header:hover {
    background: color-mix(in srgb, var(--vscode-testing-iconFailed, #f85149) 15%, transparent);
  }

  /* Orphaned/unmatched logs styling */
  .group.orphaned > .group-header {
    background: color-mix(
      in srgb,
      var(--vscode-editorWarning-foreground, #cca700) 10%,
      transparent
    );
    border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
  }

  .group.orphaned > .group-header:hover {
    background: color-mix(
      in srgb,
      var(--vscode-editorWarning-foreground, #cca700) 15%,
      transparent
    );
  }

  .orphaned-actions {
    display: flex;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
    margin-bottom: 8px;
  }

  .orphaned-actions button {
    padding: 4px 12px;
    font-size: 11px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .orphaned-actions button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .group-content {
    padding: 4px 0 4px 24px;
    border-left: 1px solid var(--vscode-panel-border);
    margin-left: 10px;
  }

  .log-line {
    margin: 0;
    padding: 1px 4px;
    font-family: var(--vscode-editor-font-family), monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .log-line.search-match {
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 200, 0, 0.4));
    border-left: 2px solid var(--vscode-editor-findMatchBorder, #f0a000);
    padding-left: 2px;
  }

  /* Error line styling - matches GitHub's red error display */
  .log-line.error-line {
    color: var(--vscode-testing-iconFailed, #f85149);
  }

  .error-prefix {
    color: var(--vscode-testing-iconFailed, #f85149);
    font-weight: 600;
  }

  /* Clickable URL styling */
  .log-url {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font-family: inherit;
    font-size: inherit;
    color: var(--vscode-textLink-foreground, #3794ff);
    cursor: pointer;
    text-decoration: underline;
  }

  .log-url:hover {
    color: var(--vscode-textLink-activeForeground, #3794ff);
    text-decoration: underline;
  }

  .spinning {
    animation: spin 1.5s linear infinite;
  }

  /* Highlight animation for scrolled-to groups */
  .group.highlight > .group-header {
    animation: highlightPulse 2s ease-out;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes highlightPulse {
    0% {
      background: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 200, 0, 0.4));
    }
    100% {
      background: var(--vscode-list-hoverBackground);
    }
  }
</style>
