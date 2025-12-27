<script lang="ts">
  /**
   * LogViewer - Interactive log viewer with collapsible groups
   * Mimics GitHub's native log viewing UI with expand/collapse functionality
   */
  import LogGroupComponent from './components/LogGroup.svelte';

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
    stepIndex?: number; // Display index (1-based sequential)
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
   * Parse raw logs into structured groups using SEQUENTIAL BOUNDARY approach
   *
   * Strategy:
   * 1. Parse ##[group]/##[endgroup] markers preserving proper nesting (depth tracking)
   * 2. Categorize API steps into setup/main/post categories
   * 3. Identify top-level "Run ..." groups as step boundaries
   * 4. Match steps to groups sequentially (not by timestamp)
   * 5. Use timestamps only as fallback for ungrouped lines
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
    // Supports ISO timestamps with or without milliseconds, and offset timezones
    const timestampRegex =
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s?/;

    // If no steps data, return empty groups with raw lines
    if (!steps || steps.length === 0) {
      return { groups: [], rawLines: lines };
    }

    // ============================================
    // PHASE 1: Parse ##[group] structure with PROPER NESTING
    // ============================================

    // Parsing depth cap (security/performance safety)
    // 50 is plenty for real logs; deeper nesting is rare and usually indicates
    // malformed logs or intentional spam
    const MAX_PARSE_DEPTH = 50;
    let depthCapWarningLogged = false;
    // Track ignored ##[group] opens so we don't pop the wrong groups on ##[endgroup]
    let ignoredGroupDepth = 0;

    interface RawGroup {
      name: string;
      lines: string[];
      children: RawGroup[];
      firstTimestamp?: number;
      lastTimestamp?: number;
      depth: number; // Nesting depth (0 = top-level)
      topLevelIndex?: number; // Stable index for top-level groups (used for bucket mapping)
    }

    interface UngroupedLine {
      line: string;
      timestamp?: number;
      afterGroupIndex: number; // Index of the last top-level group before this line (-1 if before all)
    }

    const topLevelGroups: RawGroup[] = [];
    const groupStack: RawGroup[] = [];
    let currentLines: string[] = [];
    let currentFirstTimestamp: number | undefined = undefined;
    let currentLastTimestamp: number | undefined = undefined;
    const ungroupedLines: UngroupedLine[] = [];

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
        // ============================================
        // DEPTH CAP: Treat deep ##[group] markers as plain text
        // ============================================
        if (groupStack.length >= MAX_PARSE_DEPTH) {
          // Too deep - track this ignored open so we don't pop wrong stack on endgroup
          ignoredGroupDepth++;
          if (!depthCapWarningLogged) {
            console.warn(
              `[LogParser] Max parsing depth (${MAX_PARSE_DEPTH}) reached. ` +
                `Further ##[group] markers will be treated as plain text.`
            );
            depthCapWarningLogged = true;
          }
          const processed = processLineForDisplay(line);
          if (processed.trim()) {
            if (groupStack.length > 0) {
              currentLines.push(processed);
              if (!currentFirstTimestamp) {
                currentFirstTimestamp = lineTs;
              }
              if (lineTs) {
                currentLastTimestamp = lineTs;
              }
            } else {
              ungroupedLines.push({
                line: processed,
                timestamp: lineTs,
                afterGroupIndex: topLevelGroups.length - 1,
              });
            }
          }
          continue;
        }

        // Save pending lines to current group or as ungrouped
        if (groupStack.length > 0 && currentLines.length > 0) {
          groupStack[groupStack.length - 1].lines.push(...currentLines);
          if (currentFirstTimestamp && !groupStack[groupStack.length - 1].firstTimestamp) {
            groupStack[groupStack.length - 1].firstTimestamp = currentFirstTimestamp;
          }
          if (currentLastTimestamp) {
            groupStack[groupStack.length - 1].lastTimestamp = currentLastTimestamp;
          }
        } else if (groupStack.length === 0 && currentLines.length > 0) {
          currentLines.forEach((l, i) => {
            ungroupedLines.push({
              line: l,
              timestamp: i === 0 ? currentFirstTimestamp : undefined,
              afterGroupIndex: topLevelGroups.length - 1,
            });
          });
        }
        currentLines = [];
        currentFirstTimestamp = lineTs;
        currentLastTimestamp = lineTs;

        const groupName = cleanLineForParsing.replace(/.*##\[group\]/, '').trim();
        const currentDepth = groupStack.length;
        const newGroup: RawGroup = {
          name: groupName,
          lines: [],
          children: [],
          firstTimestamp: lineTs,
          depth: currentDepth,
        };

        if (groupStack.length > 0) {
          // Nested group - add as child of current group
          groupStack[groupStack.length - 1].children.push(newGroup);
        } else {
          // Top-level group - assign stable index for bucket mapping
          newGroup.topLevelIndex = topLevelGroups.length;
          topLevelGroups.push(newGroup);
        }
        groupStack.push(newGroup);
      } else if (cleanLineForParsing.includes('##[endgroup]')) {
        // If we ignored opens due to depth cap, decrement counter instead of popping stack
        if (ignoredGroupDepth > 0) {
          ignoredGroupDepth--;
          continue; // Don't pop the real stack
        }
        if (groupStack.length > 0) {
          if (currentLines.length > 0) {
            groupStack[groupStack.length - 1].lines.push(...currentLines);
            if (currentFirstTimestamp && !groupStack[groupStack.length - 1].firstTimestamp) {
              groupStack[groupStack.length - 1].firstTimestamp = currentFirstTimestamp;
            }
            if (currentLastTimestamp) {
              groupStack[groupStack.length - 1].lastTimestamp = currentLastTimestamp;
            }
          }
          currentLines = [];
          currentFirstTimestamp = undefined;
          currentLastTimestamp = undefined;
          groupStack.pop();
        }
      } else {
        const processed = processLineForDisplay(line);
        if (processed.trim()) {
          if (groupStack.length > 0) {
            currentLines.push(processed);
            if (!currentFirstTimestamp) {
              currentFirstTimestamp = lineTs;
            }
            if (lineTs) {
              currentLastTimestamp = lineTs;
            }
          } else {
            ungroupedLines.push({
              line: processed,
              timestamp: lineTs,
              afterGroupIndex: topLevelGroups.length - 1,
            });
          }
        }
      }
    }

    // Handle remaining lines
    if (groupStack.length > 0 && currentLines.length > 0) {
      groupStack[groupStack.length - 1].lines.push(...currentLines);
    } else if (currentLines.length > 0) {
      currentLines.forEach((l) =>
        ungroupedLines.push({
          line: l,
          afterGroupIndex: topLevelGroups.length - 1,
        })
      );
    }

    // ============================================
    // PHASE 2: Categorize API steps
    // ============================================
    interface StepBucket {
      step: StepData;
      displayIndex: number;
      category: 'setup' | 'main' | 'post' | 'complete';
      groups: RawGroup[];
      ungroupedLines: string[];
    }

    // FIX A: Sort steps by step.number to ensure correct sequential order
    // GitHub usually returns ordered steps, but this guarantees correctness
    const stepsSorted = [...steps].sort((a, b) => a.number - b.number);

    const stepBuckets: StepBucket[] = stepsSorted.map((step, idx) => {
      const nameLower = step.name.toLowerCase();
      let category: 'setup' | 'main' | 'post' | 'complete' = 'main';

      if (nameLower === 'set up job') {
        category = 'setup';
      } else if (nameLower === 'set up runner' || nameLower === 'complete runner') {
        // Self-hosted runner setup/cleanup - these have hook scripts
        category = 'setup';
      } else if (nameLower === 'complete job') {
        category = 'complete';
      } else if (nameLower.startsWith('post ')) {
        // FIX B: Only treat "Post X" as post steps, NOT generic "Cleanup"
        // A user step named "Cleanup" is common and should remain main
        category = 'post';
      }

      return {
        step,
        displayIndex: idx + 1,
        category,
        groups: [],
        ungroupedLines: [],
      };
    });

    // Find specific buckets
    const setUpJobBucket = stepBuckets.find((b) => b.step.name.toLowerCase() === 'set up job');
    const setUpRunnerBucket = stepBuckets.find(
      (b) => b.step.name.toLowerCase() === 'set up runner'
    );
    const completeRunnerBucket = stepBuckets.find(
      (b) => b.step.name.toLowerCase() === 'complete runner'
    );
    const completeJobBucket = stepBuckets.find((b) => b.step.name.toLowerCase() === 'complete job');

    const mainBuckets = stepBuckets.filter(
      (b) => b.category === 'main' && b.step.conclusion !== 'skipped'
    );
    const postBuckets = stepBuckets.filter((b) => b.category === 'post');

    // ============================================
    // PHASE 3: Identify "Run ..." groups as step boundaries
    // ============================================
    // Self-hosted runner hook scripts should NOT be treated as step boundaries
    // They belong to "Set up runner" / "Complete runner" steps

    /**
     * Check if a group is a self-hosted runner hook script
     * These follow patterns like:
     * - Run '/opt/actions-runner/hook_job_started.sh'
     * - Run '/opt/actions-runner/hook_job_completed.sh'
     */
    function isSelfHostedHookGroup(groupName: string): boolean {
      // Self-hosted runner hook scripts
      if (groupName.match(/^Run '\/opt\/actions-runner\/hook_.*\.sh'$/)) {
        return true;
      }
      // Also match quoted paths with double quotes
      if (groupName.match(/^Run "\/opt\/actions-runner\/hook_.*\.sh"$/)) {
        return true;
      }
      return false;
    }

    /**
     * Extract action information from a group name.
     * Handles various formats:
     * - "Run actions/checkout@v4"
     * - "Run actions/cache/restore@v4"
     * - "Run org/repo@branch"
     * - "Run org/repo/path@version"
     * - "Run ./.github/actions/my-action"
     * - "Run echo ..."
     * - "Run MY_VAR=value" (environment variable)
     */
    interface ActionInfo {
      isAction: boolean;
      isLocalAction: boolean; // True for .github/actions/...
      isEnvVar: boolean; // True for VAR=value patterns
      fullPath: string; // e.g., "actions/checkout" or "org/repo"
      org: string; // e.g., "actions" or "docker"
      actionName: string; // e.g., "checkout" or "repo"
      subAction: string; // e.g., "restore" for actions/cache/restore
      normalizedName: string; // Combined name without special chars
      shellCommand: string; // For "Run echo ..." style
      envVarName: string; // For "Run MY_VAR=..." patterns
      rawCommand: string; // Everything after "Run "
      allPathParts: string[]; // All parts of the path for matching
    }

    function extractActionInfo(groupName: string): ActionInfo {
      const groupLower = groupName.toLowerCase();
      const afterRun = groupLower.replace(/^run\s+/, '').trim();

      const baseResult: ActionInfo = {
        isAction: false,
        isLocalAction: false,
        isEnvVar: false,
        fullPath: '',
        org: '',
        actionName: '',
        subAction: '',
        normalizedName: '',
        shellCommand: '',
        envVarName: '',
        rawCommand: afterRun,
        allPathParts: [],
      };

      // 1. Check for local/custom actions: ./.github/actions/ACTION or .github/actions/ACTION
      const localActionMatch = afterRun.match(
        /^\.?\/\.github\/actions\/([a-z0-9_-]+)(?:\/([a-z0-9_-]+))?/
      );
      if (localActionMatch) {
        const [, action, subAction] = localActionMatch;
        const normalizedAction = action.replace(/[-_]/g, '');
        const normalizedSub = subAction?.replace(/[-_]/g, '') || '';
        const allParts = [action, ...(subAction ? [subAction] : [])].flatMap((p) => p.split('-'));

        return {
          ...baseResult,
          isAction: true,
          isLocalAction: true,
          fullPath: `.github/actions/${action}${subAction ? '/' + subAction : ''}`,
          org: '.github',
          actionName: normalizedAction,
          subAction: normalizedSub,
          normalizedName: normalizedSub ? `${normalizedAction}${normalizedSub}` : normalizedAction,
          allPathParts: allParts,
        };
      }

      // 2. Check for GitHub Actions: org/action@version or org/action/subpath@version
      // Handle both actions/checkout@v4 and docker/setup-buildx-action@v3
      const actionPattern = /^([a-z0-9_-]+)\/([a-z0-9_-]+)(?:\/([a-z0-9_-]+))?(?:@[^\s]+)?(?:\s|$)/;
      const actionMatch = afterRun.match(actionPattern);

      if (actionMatch) {
        const [, org, action, subAction] = actionMatch;
        const normalizedAction = action.replace(/[-_]/g, '');
        const normalizedSub = subAction?.replace(/[-_]/g, '') || '';
        // Split all path parts by hyphens for better matching
        const allParts = [org, action, ...(subAction ? [subAction] : [])].flatMap((p) =>
          p.split('-')
        );

        return {
          ...baseResult,
          isAction: true,
          fullPath: subAction ? `${org}/${action}/${subAction}` : `${org}/${action}`,
          org,
          actionName: normalizedAction,
          subAction: normalizedSub,
          normalizedName: normalizedSub ? `${normalizedAction}${normalizedSub}` : normalizedAction,
          allPathParts: allParts,
        };
      }

      // 3. Check for environment variable pattern: VAR=value or export VAR=value
      const envVarMatch = afterRun.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=/i);
      if (envVarMatch) {
        return {
          ...baseResult,
          isEnvVar: true,
          envVarName: envVarMatch[1].toLowerCase(),
        };
      }

      // 4. Shell command pattern: first word after "Run "
      const shellMatch = afterRun.match(/^(\w+)/);
      return {
        ...baseResult,
        shellCommand: shellMatch?.[1] || '',
      };
    }

    /**
     * Normalize step name for matching - remove emojis, special chars, common prefixes
     */
    function normalizeStepName(stepName: string): {
      normalized: string;
      words: string[];
      hasEmoji: boolean;
    } {
      const hasEmoji = /[\u{1F300}-\u{1F9FF}]/u.test(stepName);
      // Remove emojis and special chars, normalize whitespace
      const normalized = stepName
        .toLowerCase()
        .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Remove emojis
        .replace(/[^\w\s]/g, ' ') // Replace special chars with space
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();

      const words = normalized.split(' ').filter((w) => w.length > 2);

      return { normalized, words, hasEmoji };
    }

    /**
     * Calculate similarity score between a log group name and an API step name.
     * Returns a score from 0 to 1, where 1 is a perfect match.
     *
     * Scoring tiers:
     * - 0.95: Exact action name match
     * - 0.90: Multiple keyword matches
     * - 0.80-0.85: Single strong keyword match or subAction match
     * - 0.70-0.75: Shell command or partial path match
     * - 0.60-0.70: Word overlap (improved weighting)
     * - 0.10: No meaningful match
     */
    function calculateStepMatchScore(groupName: string, stepName: string): number {
      const actionInfo = extractActionInfo(groupName);
      const stepInfo = normalizeStepName(stepName);

      // ============================================
      // Comprehensive keyword mappings for actions
      // ============================================
      const actionKeywords: Record<string, string[]> = {
        // === Code Management ===
        checkout: ['checkout', 'clone', 'code', 'repo', 'repository', 'source', 'fetch'],

        // === Node.js Ecosystem ===
        setupnode: ['node', 'nodejs', 'npm', 'setup', 'install'],
        actionsetup: ['setup', 'action', 'pnpm', 'yarn', 'install', 'dependencies'],
        pnpmaction: ['pnpm', 'setup', 'install', 'package'],

        // === Python ===
        setuppython: ['python', 'pip', 'setup', 'install', 'venv'],
        pipaction: ['pip', 'python', 'install', 'package', 'dependencies'],

        // === .NET ===
        setupdotnet: ['dotnet', 'csharp', 'nuget', 'setup', 'install', 'net'],

        // === Ruby ===
        setupruby: ['ruby', 'gem', 'bundler', 'setup', 'install', 'rails'],

        // === Java ===
        setupjava: ['java', 'jdk', 'jre', 'maven', 'gradle', 'setup', 'install'],
        gradlebuildaction: ['gradle', 'build', 'java', 'compile'],

        // === Go ===
        setupgo: ['go', 'golang', 'modules', 'setup', 'install', 'mod'],

        // === Rust ===
        setuprust: ['rust', 'cargo', 'rustup', 'setup', 'install'],

        // === Caching ===
        cache: ['cache', 'caching', 'restore', 'save', 'store'],
        restore: ['cache', 'restore', 'download', 'retrieve', 'load'],
        save: ['cache', 'save', 'upload', 'store', 'persist'],

        // === Artifacts ===
        uploadartifact: ['upload', 'artifact', 'save', 'store', 'publish', 'output'],
        downloadartifact: ['download', 'artifact', 'fetch', 'retrieve', 'input'],

        // === Testing ===
        test: ['test', 'testing', 'spec', 'jest', 'vitest', 'mocha', 'pytest', 'unittest'],

        // === Building ===
        build: ['build', 'compile', 'bundle', 'webpack', 'rollup', 'esbuild', 'vite'],

        // === Deployment ===
        deploy: ['deploy', 'deployment', 'release', 'publish', 'ship'],

        // === Docker ===
        docker: ['docker', 'container', 'image', 'registry', 'dockerfile'],
        buildpushaction: ['docker', 'build', 'push', 'container', 'image'],
        setupbuildxaction: ['docker', 'buildx', 'build', 'container', 'multiplatform'],
        loginaction: ['docker', 'login', 'registry', 'authenticate', 'ecr', 'gcr', 'acr'],

        // === Linting & Formatting ===
        lint: ['lint', 'eslint', 'prettier', 'format', 'style', 'check'],
        eslint: ['eslint', 'lint', 'javascript', 'typescript', 'check'],
        prettier: ['prettier', 'format', 'style', 'code'],

        // === Security ===
        codeqlaction: ['codeql', 'security', 'scan', 'analysis', 'vulnerability'],
        dependabot: ['dependabot', 'dependency', 'update', 'security'],
        trivyaction: ['trivy', 'security', 'scan', 'vulnerability', 'container'],

        // === GitHub Specific ===
        githubscript: ['github', 'script', 'api', 'octokit'],
        labeler: ['label', 'labeler', 'tag', 'pr', 'issue'],
        createrelease: ['release', 'create', 'publish', 'tag', 'version'],

        // === Cloud Providers ===
        awsactions: ['aws', 'amazon', 's3', 'ecr', 'ecs', 'lambda', 'cloud'],
        azureactions: ['azure', 'az', 'cloud', 'webapp', 'aks'],
        googleactions: ['gcloud', 'google', 'gcp', 'cloud', 'gke'],

        // === Kubernetes ===
        kubernetes: ['kubernetes', 'k8s', 'kubectl', 'deploy', 'helm'],

        // === Coverage & Reporting ===
        codecov: ['codecov', 'coverage', 'report', 'upload'],
        coveralls: ['coveralls', 'coverage', 'report'],
        reportportal: ['report', 'portal', 'launch', 'rp', 'testing'],

        // === Notifications ===
        slack: ['slack', 'notify', 'notification', 'message', 'alert'],
      };

      // ============================================
      // Shell command keyword mappings
      // ============================================
      const shellKeywords: Record<string, string[]> = {
        // Output/Display
        echo: ['print', 'display', 'show', 'output', 'log', 'debug', 'info'],
        cat: ['print', 'display', 'show', 'read', 'content', 'file'],
        ls: ['list', 'display', 'show', 'files', 'directory', 'dir'],
        pwd: ['directory', 'path', 'current', 'working'],

        // Package managers
        npm: ['npm', 'install', 'build', 'test', 'run', 'node', 'package'],
        pnpm: ['pnpm', 'install', 'build', 'test', 'run', 'node', 'package'],
        yarn: ['yarn', 'install', 'build', 'test', 'run', 'node', 'package'],
        pip: ['pip', 'install', 'python', 'package', 'dependencies'],
        cargo: ['cargo', 'rust', 'build', 'test', 'install'],
        gem: ['gem', 'ruby', 'install', 'bundle'],
        dotnet: ['dotnet', 'build', 'test', 'publish', 'restore'],
        go: ['go', 'build', 'test', 'run', 'mod', 'golang'],
        mvn: ['maven', 'build', 'test', 'package', 'java'],
        gradle: ['gradle', 'build', 'test', 'java'],

        // Runtimes
        node: ['node', 'run', 'execute', 'script', 'javascript'],
        python: ['python', 'run', 'execute', 'script'],
        ruby: ['ruby', 'run', 'execute', 'script'],
        java: ['java', 'run', 'execute'],

        // Build tools
        make: ['make', 'build', 'compile'],
        cmake: ['cmake', 'build', 'compile', 'configure'],

        // Container/Cloud
        docker: ['docker', 'container', 'build', 'push', 'run', 'image'],
        kubectl: ['kubectl', 'kubernetes', 'k8s', 'deploy', 'apply'],
        helm: ['helm', 'kubernetes', 'chart', 'deploy', 'install'],
        terraform: ['terraform', 'tf', 'infrastructure', 'iac', 'apply', 'plan'],
        aws: ['aws', 'amazon', 's3', 'cloud', 'ecr', 'ecs'],
        az: ['azure', 'az', 'cloud', 'webapp'],
        gcloud: ['gcloud', 'google', 'gcp', 'cloud'],

        // Version control
        git: ['git', 'commit', 'push', 'pull', 'clone', 'fetch', 'checkout'],

        // Network
        curl: ['curl', 'fetch', 'download', 'api', 'request', 'http'],
        wget: ['wget', 'download', 'fetch', 'http'],

        // Testing
        jest: ['jest', 'test', 'testing', 'spec'],
        vitest: ['vitest', 'test', 'testing', 'spec'],
        pytest: ['pytest', 'test', 'python', 'testing'],
        eslint: ['eslint', 'lint', 'check', 'style'],
      };

      // ============================================
      // Environment variable keywords
      // ============================================
      const envVarKeywords: Record<string, string[]> = {
        path: ['path', 'environment', 'setup'],
        home: ['home', 'directory', 'environment'],
        node: ['node', 'version', 'environment'],
        python: ['python', 'version', 'environment'],
        java: ['java', 'version', 'environment'],
        env: ['environment', 'variable', 'setup', 'configure'],
      };

      let score = 0;

      // ============================================
      // Scoring logic
      // ============================================

      if (actionInfo.isAction) {
        // 1. Exact action name match in step words (highest confidence)
        const exactMatch = stepInfo.words.some(
          (w) =>
            w === actionInfo.actionName ||
            w === actionInfo.subAction ||
            (actionInfo.actionName.length > 3 && actionInfo.actionName.includes(w)) ||
            (w.length > 3 && w.includes(actionInfo.actionName))
        );
        if (exactMatch) {
          score = Math.max(score, 0.95);
        }

        // 2. Keyword-based matching for known actions
        const keywords =
          actionKeywords[actionInfo.normalizedName] ||
          actionKeywords[actionInfo.actionName] ||
          actionKeywords[actionInfo.subAction] ||
          [];
        const keywordMatches = keywords.filter((kw) =>
          stepInfo.words.some((w) => w.includes(kw) || kw.includes(w))
        );
        if (keywordMatches.length >= 3) {
          score = Math.max(score, 0.92);
        } else if (keywordMatches.length === 2) {
          score = Math.max(score, 0.88);
        } else if (keywordMatches.length === 1) {
          score = Math.max(score, 0.75);
        }

        // 3. Check subAction keywords (e.g., "restore" in "actions/cache/restore")
        if (actionInfo.subAction) {
          const subKeywords = actionKeywords[actionInfo.subAction] || [];
          const subMatches = subKeywords.filter((kw) =>
            stepInfo.words.some((w) => w.includes(kw) || kw.includes(w))
          );
          if (subMatches.length >= 2) {
            score = Math.max(score, 0.88);
          } else if (subMatches.length === 1) {
            score = Math.max(score, 0.82);
          }
        }

        // 4. Match by organization name for common orgs (docker/*, aws-actions/*, etc.)
        const orgKeywords: Record<string, string[]> = {
          docker: ['docker', 'container', 'image'],
          aws: ['aws', 'amazon', 'cloud'],
          azure: ['azure', 'microsoft', 'cloud'],
          google: ['google', 'gcp', 'cloud'],
        };
        if (actionInfo.org && orgKeywords[actionInfo.org]) {
          const orgMatches = orgKeywords[actionInfo.org].filter((kw) =>
            stepInfo.words.some((w) => w.includes(kw))
          );
          if (orgMatches.length > 0) {
            score = Math.max(score, 0.7 + orgMatches.length * 0.05);
          }
        }

        // 5. Partial path matching using allPathParts
        const pathMatches = actionInfo.allPathParts.filter(
          (p) => p.length > 3 && stepInfo.words.some((w) => w.includes(p) || p.includes(w))
        );
        if (pathMatches.length >= 2) {
          score = Math.max(score, 0.8);
        } else if (pathMatches.length === 1) {
          score = Math.max(score, 0.65);
        }
      } else if (actionInfo.isEnvVar) {
        // Environment variable matching
        const varNameParts = actionInfo.envVarName.split('_');
        const envMatches = varNameParts.filter((p) =>
          stepInfo.words.some((w) => w.includes(p) || p.includes(w))
        );
        if (envMatches.length > 0) {
          score = Math.max(score, 0.7 + envMatches.length * 0.1);
        }

        // Check common env var keywords
        for (const [pattern, keywords] of Object.entries(envVarKeywords)) {
          if (actionInfo.envVarName.includes(pattern)) {
            const matches = keywords.filter((kw) => stepInfo.words.some((w) => w.includes(kw)));
            if (matches.length > 0) {
              score = Math.max(score, 0.7);
            }
          }
        }
      } else if (actionInfo.shellCommand) {
        // Shell command matching
        const shellKw = shellKeywords[actionInfo.shellCommand] || [];
        const shellMatches = shellKw.filter((kw) =>
          stepInfo.words.some((w) => w.includes(kw) || kw.includes(w))
        );
        if (shellMatches.length >= 3) {
          score = Math.max(score, 0.85);
        } else if (shellMatches.length === 2) {
          score = Math.max(score, 0.78);
        } else if (shellMatches.length === 1) {
          score = Math.max(score, 0.68);
        }

        // Check if shell command itself appears in step name
        if (stepInfo.words.includes(actionInfo.shellCommand)) {
          score = Math.max(score, 0.75);
        }
      }

      // 6. General word overlap (improved fallback with better weighting)
      if (score < 0.6) {
        const commandWords = actionInfo.rawCommand
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 3);
        const overlap = commandWords.filter((cw) =>
          stepInfo.words.some((sw) => sw.includes(cw) || cw.includes(sw))
        );
        // Improved weighting: base 0.55 + 0.12 per overlap, max 0.85
        if (overlap.length > 0) {
          score = Math.max(score, 0.55 + Math.min(overlap.length * 0.12, 0.3));
        }
      }

      // 7. No meaningful match - return low score
      return score > 0 ? score : 0.1;
    }

    // NOTE: findBestNameBasedMatch was removed - we now use timestamp-first matching

    interface GroupBoundary {
      groupIndex: number;
      group: RawGroup;
      isHook: boolean; // True if this is a self-hosted hook script
    }

    const allRunGroups: GroupBoundary[] = [];
    for (let i = 0; i < topLevelGroups.length; i++) {
      const group = topLevelGroups[i];
      if (group.name.startsWith('Run ') && group.depth === 0) {
        allRunGroups.push({
          groupIndex: i,
          group,
          isHook: isSelfHostedHookGroup(group.name),
        });
      }
    }

    // Separate hook groups from actual step boundary groups
    const hookGroups = allRunGroups.filter((b) => b.isHook);
    const stepBoundaryGroups = allRunGroups.filter((b) => !b.isHook);

    // ============================================
    // PHASE 4: Sequential matching of steps to groups
    // ============================================

    // Find the first non-hook "Run ..." group index
    const firstStepRunIndex =
      stepBoundaryGroups.length > 0 ? stepBoundaryGroups[0].groupIndex : topLevelGroups.length;

    // Find the last non-hook "Run ..." group index
    const lastStepRunIndex =
      stepBoundaryGroups.length > 0
        ? stepBoundaryGroups[stepBoundaryGroups.length - 1].groupIndex
        : -1;

    // Pre-step groups (before first actual step "Run ...") → setup steps
    const preStepGroups = topLevelGroups.slice(0, firstStepRunIndex);

    // Post-step groups (after last actual step "Run ...") → post/complete steps
    const postStepGroups = lastStepRunIndex >= 0 ? topLevelGroups.slice(lastStepRunIndex + 1) : [];

    // Assign pre-step groups to setup buckets
    // Split between "Set up job" and "Set up runner" if both exist
    if (setUpJobBucket || setUpRunnerBucket) {
      // Find where "Set up runner" hook starts (if any)
      const jobStartedHook = hookGroups.find((h) => h.group.name.includes('hook_job_started'));
      const hookStartIndex = jobStartedHook?.groupIndex ?? preStepGroups.length;

      // Groups before hook → "Set up job"
      // Groups from hook onwards (but still in pre-step) → "Set up runner"
      for (let i = 0; i < preStepGroups.length; i++) {
        const group = preStepGroups[i];
        const groupIndexInAll = i; // This is relative to preStepGroups

        if (setUpRunnerBucket && groupIndexInAll >= hookStartIndex) {
          setUpRunnerBucket.groups.push(group);
        } else if (setUpJobBucket) {
          setUpJobBucket.groups.push(group);
        } else if (setUpRunnerBucket) {
          setUpRunnerBucket.groups.push(group);
        }
      }
    }

    // ============================================
    // PHASE 4: Monotonic "advance or stay" step assignment
    // ============================================
    //
    // Key principle: sequential assignment with timestamps only as a GUARD
    // to decide whether multiple "Run ..." groups should stay in the current step
    // (composite actions) or advance to the next step.
    //
    // This avoids:
    // - Backward assignment (logs going to earlier steps)
    // - Timestamp window overlap issues
    // - "Fallback-previous" causing everything to stick to one step

    // Use both sets: sometimes skipped steps have no "Run ..." groups in logs
    const mainBucketsAll = stepBuckets.filter((b) => b.category === 'main');
    const mainBucketsNonSkipped = mainBucketsAll.filter((b) => b.step.conclusion !== 'skipped');

    // Pick the mapping list that best matches the log reality
    const mainBucketsForMapping =
      stepBoundaryGroups.length === mainBucketsNonSkipped.length
        ? mainBucketsNonSkipped
        : stepBoundaryGroups.length === mainBucketsAll.length
          ? mainBucketsAll
          : mainBucketsNonSkipped.length > 0
            ? mainBucketsNonSkipped
            : mainBucketsAll;

    // Smaller tolerance — big tolerances create overlaps and pull logs backwards
    const STEP_BOUNDARY_TOLERANCE_MS = 250;

    /**
     * Convert ISO timestamp string to milliseconds
     */
    const isoToMs = (iso?: string): number | undefined => {
      if (!iso) return undefined;
      const ms = Date.parse(iso);
      return Number.isFinite(ms) ? ms : undefined;
    };

    let stepPtr = 0;

    type BoundaryReason =
      | 'first'
      | 'stay'
      | 'advance-nextStart'
      | 'advance-currentEnd'
      | 'advance-no-ts'
      | 'no-step-left'
      | 'hook-setup';

    const boundaryDecisions: Array<{
      i: number;
      groupIndex: number;
      groupName: string;
      ts?: number;
      assignedStep: string;
      reason: BoundaryReason;
    }> = [];

    for (let i = 0; i < stepBoundaryGroups.length; i++) {
      const boundary = stepBoundaryGroups[i];
      const nextBoundary = stepBoundaryGroups[i + 1];

      // Segment = all top-level groups from this Run... until the next Run...
      const segmentEnd = nextBoundary ? nextBoundary.groupIndex : lastStepRunIndex + 1;
      const segmentGroups = topLevelGroups.slice(boundary.groupIndex, segmentEnd);

      const ts = boundary.group.firstTimestamp ?? boundary.group.lastTimestamp;

      let reason: BoundaryReason = 'stay';

      // Check for hook groups first - route to setup
      if (isSelfHostedHookGroup(boundary.group.name)) {
        const hookTarget = setUpRunnerBucket || setUpJobBucket;
        if (hookTarget) {
          hookTarget.groups.push(...segmentGroups);
        }
        boundaryDecisions.push({
          i,
          groupIndex: boundary.groupIndex,
          groupName: boundary.group.name,
          ts,
          assignedStep: hookTarget?.step.name ?? 'NONE',
          reason: 'hook-setup',
        });
        continue;
      }

      if (i === 0) {
        stepPtr = 0;
        reason = 'first';
      } else if (stepPtr >= mainBucketsForMapping.length) {
        reason = 'no-step-left';
      } else if (stepPtr < mainBucketsForMapping.length - 1) {
        const current = mainBucketsForMapping[stepPtr];
        const next = mainBucketsForMapping[stepPtr + 1];

        const nextStart = isoToMs(next.step.startedAt);
        const currentEnd = isoToMs(current.step.completedAt);

        if (ts === undefined) {
          // No timestamps in logs => behave like strict sequential
          stepPtr++;
          reason = 'advance-no-ts';
        } else {
          // If the log timestamp has reached the next step's start, move forward
          if (nextStart !== undefined && ts >= nextStart - STEP_BOUNDARY_TOLERANCE_MS) {
            stepPtr++;
            reason = 'advance-nextStart';
          }
          // Or if it's clearly after current end
          else if (currentEnd !== undefined && ts > currentEnd + STEP_BOUNDARY_TOLERANCE_MS) {
            stepPtr++;
            reason = 'advance-currentEnd';
          } else {
            // Otherwise: stay (this is what makes multiple Run... groups fold into one step)
            reason = 'stay';
          }
        }
      }

      const target = mainBucketsForMapping[Math.min(stepPtr, mainBucketsForMapping.length - 1)];
      if (target) {
        target.groups.push(...segmentGroups);
      }

      boundaryDecisions.push({
        i,
        groupIndex: boundary.groupIndex,
        groupName: boundary.group.name,
        ts,
        assignedStep: target?.step.name ?? 'NONE',
        reason,
      });
    }

    // Debug output
    const DEBUG_LOG_PARSER = true;
    if (DEBUG_LOG_PARSER) {
      console.groupCollapsed('[LogParser] Main boundary→step decisions');
      console.table(
        boundaryDecisions.map((d) => ({
          '#': d.i,
          groupIndex: d.groupIndex,
          Group: d.groupName.substring(0, 45) + (d.groupName.length > 45 ? '...' : ''),
          Ts: d.ts ? new Date(d.ts).toISOString() : '-',
          Step: d.assignedStep.substring(0, 30),
          Reason: d.reason,
        }))
      );
      console.groupEnd();

      console.log('[LogParser] Mapping counts', {
        stepBoundaries: stepBoundaryGroups.length,
        mainAll: mainBucketsAll.length,
        mainNonSkipped: mainBucketsNonSkipped.length,
        using: mainBucketsForMapping.length,
      });
    }

    // Warn about empty main buckets
    const emptyBuckets = mainBucketsForMapping.filter((b) => b.groups.length === 0);
    if (emptyBuckets.length > 0) {
      console.warn(
        '[LogParser] ⚠️ Steps with NO matched groups:',
        emptyBuckets.map((b) => ({
          name: b.step.name,
          number: b.step.number,
          status: b.step.conclusion || b.step.status,
        }))
      );
    }

    // Assign post-step groups to post/complete buckets
    if (postStepGroups.length > 0) {
      // Find where "Complete runner" hook starts (if any)
      const jobCompletedHook = hookGroups.find((h) => h.group.name.includes('hook_job_completed'));

      // ============================================
      // Handle "Post job cleanup." container specially
      // ============================================
      // GitHub wraps post steps in a container group. We need to distribute
      // its children to individual post step buckets.
      const postJobCleanupGroup = postStepGroups.find((g) =>
        g.name.toLowerCase().includes('post job cleanup')
      );

      if (postJobCleanupGroup && postBuckets.length > 0) {
        const originalChildren = postJobCleanupGroup.children;
        const leftoverChildren: RawGroup[] = [];
        postJobCleanupGroup.children = []; // Detach to prevent duplication

        const usedPostIndices = new Set<number>();

        for (let i = 0; i < originalChildren.length; i++) {
          const child = originalChildren[i];
          const match = findBestPostChildMatch(child, postBuckets, usedPostIndices, i);

          if (match && match.rawScore >= 0.5) {
            match.bucket.groups.push(child);
            usedPostIndices.add(match.index);
            console.log(
              `[LogParser] Post child matched: "${child.name}" → "${match.bucket.step.name}" (score: ${match.rawScore.toFixed(2)})`
            );
          } else {
            leftoverChildren.push(child);
          }
        }

        // Keep any unmatched children under the container
        postJobCleanupGroup.children = leftoverChildren;

        // Attach the container itself if it has own lines or unmatched children
        if (postJobCleanupGroup.lines.length > 0 || postJobCleanupGroup.children.length > 0) {
          if (completeJobBucket) {
            completeJobBucket.groups.push(postJobCleanupGroup);
          } else if (postBuckets.length > 0) {
            postBuckets[postBuckets.length - 1].groups.push(postJobCleanupGroup);
          }
        }
      }

      // Process remaining post-step groups (skip the container if already handled)
      for (const group of postStepGroups) {
        // Skip the container - already handled above
        if (group === postJobCleanupGroup) continue;

        const groupIndex = topLevelGroups.indexOf(group);

        // Check if this is a hook group for complete runner
        if (isSelfHostedHookGroup(group.name) && completeRunnerBucket) {
          completeRunnerBucket.groups.push(group);
          continue;
        }

        // Check if this is after the job_completed hook
        if (jobCompletedHook && groupIndex >= jobCompletedHook.groupIndex && completeRunnerBucket) {
          completeRunnerBucket.groups.push(group);
          continue;
        }

        // Try to match to a post step
        const matchingPostBucket = findPostBucketForGroup(group, postBuckets);
        if (matchingPostBucket) {
          matchingPostBucket.groups.push(group);
        } else if (completeJobBucket) {
          completeJobBucket.groups.push(group);
        } else if (postBuckets.length > 0) {
          postBuckets[postBuckets.length - 1].groups.push(group);
        }
      }
    }

    /**
     * Find the best post bucket for a "Run ..." group.
     * Uses the same scoring logic as main matching for consistency.
     */
    function findPostBucketForGroup(
      group: RawGroup,
      buckets: StepBucket[]
    ): StepBucket | undefined {
      if (buckets.length === 0) return undefined;

      const groupNameLower = group.name.toLowerCase();

      // Known post-step action patterns (action → step keywords)
      const postStepPatterns: Record<string, string[]> = {
        'actions/checkout': ['checkout', 'clone', 'code', 'repo'],
        'actions/setup-node': ['node', 'setup', 'npm', 'yarn', 'pnpm'],
        'actions/setup-python': ['python', 'setup', 'pip'],
        'actions/setup-java': ['java', 'setup', 'jdk', 'maven', 'gradle'],
        'actions/setup-go': ['go', 'golang', 'setup'],
        'actions/setup-dotnet': ['dotnet', 'setup', 'csharp'],
        'actions/setup-ruby': ['ruby', 'setup', 'bundler'],
        'actions/cache': ['cache', 'restore', 'save'],
        'actions/upload-artifact': ['upload', 'artifact'],
        'actions/download-artifact': ['download', 'artifact'],
        'docker/setup-buildx-action': ['docker', 'buildx', 'build'],
        'docker/login-action': ['docker', 'login', 'registry'],
        'docker/build-push-action': ['docker', 'build', 'push'],
      };

      let bestMatch: StepBucket | undefined;
      let bestScore = 0;

      for (const bucket of buckets) {
        const stepNameLower = bucket.step.name.toLowerCase();
        // Remove "Post " prefix for matching
        const cleanStepName = stepNameLower.replace(/^post\s+/, '');
        const stepWords = cleanStepName.split(/\s+/);

        let score = 0;

        // 1. Check known patterns first
        for (const [pattern, keywords] of Object.entries(postStepPatterns)) {
          if (groupNameLower.includes(pattern)) {
            const matches = keywords.filter((kw) => stepWords.some((sw) => sw.includes(kw)));
            if (matches.length > 0) {
              score = Math.max(score, 0.8 + matches.length * 0.05);
            }
          }
        }

        // 2. Extract action name and match generically
        const actionMatch = groupNameLower.match(/run\s+([a-z0-9_-]+)\/([a-z0-9_-]+)/);
        if (actionMatch) {
          const [, org, action] = actionMatch;
          const actionParts = action.split('-');

          // Check if any part of action name is in step name
          const partMatches = actionParts.filter(
            (p) => p.length > 2 && stepWords.some((sw) => sw.includes(p) || p.includes(sw))
          );
          if (partMatches.length > 0) {
            score = Math.max(score, 0.6 + partMatches.length * 0.1);
          }

          // Check organization name
          if (stepWords.some((sw) => sw.includes(org))) {
            score = Math.max(score, 0.5);
          }
        }

        // 3. Use the scoring function for more complex matching
        const nameScore = calculateStepMatchScore(group.name, cleanStepName);
        score = Math.max(score, nameScore * 0.9); // Slightly discount since it's post-step

        if (score > bestScore) {
          bestScore = score;
          bestMatch = bucket;
        }
      }

      // Only return if we have a reasonable match (> 0.5)
      return bestScore > 0.5 ? bestMatch : undefined;
    }

    /**
     * Find the best post bucket for a child group within "Post job cleanup." container.
     * Used to distribute children like "Post actions/checkout@v4" to individual "Post Checkout" buckets.
     */
    function findBestPostChildMatch(
      child: RawGroup,
      buckets: StepBucket[],
      used: Set<number>,
      preferredIndex?: number
    ): { bucket: StepBucket; index: number; score: number; rawScore: number } | undefined {
      let best: { bucket: StepBucket; index: number; score: number; rawScore: number } | undefined;

      // Normalize: "Post actions/checkout@v4" should score like "Run actions/checkout@v4"
      const groupNameForMatch = child.name.replace(/^post\s+/i, 'Run ');

      for (let i = 0; i < buckets.length; i++) {
        if (used.has(i)) continue;

        // Normalize: "Post Checkout" should score like "Checkout"
        const stepNameForMatch = buckets[i].step.name.replace(/^post\s+/i, '');

        const rawScore = calculateStepMatchScore(groupNameForMatch, stepNameForMatch);
        const positionBonus = preferredIndex !== undefined && i === preferredIndex ? 0.05 : 0;
        const score = rawScore + positionBonus;

        if (!best || score > best.score) {
          best = { bucket: buckets[i], index: i, score, rawScore };
        }
      }

      return best;
    }

    // ============================================
    // Build topLevelIndex → Bucket mapping for Phase 5
    // ============================================
    // This map is used to attach ungrouped lines to the correct step
    // based on which bucket owns the preceding top-level group.
    const topLevelIndexToBucket = new Map<number, StepBucket>();

    for (const bucket of stepBuckets) {
      for (const g of bucket.groups) {
        if (g.topLevelIndex !== undefined) {
          const prev = topLevelIndexToBucket.get(g.topLevelIndex);
          if (prev && prev !== bucket) {
            console.warn(
              `[LogParser] Top-level group #${g.topLevelIndex} assigned to multiple buckets:`,
              { group: g.name, prev: prev.step.name, next: bucket.step.name }
            );
          } else {
            topLevelIndexToBucket.set(g.topLevelIndex, bucket);
          }
        }
      }
    }

    // ============================================
    // PHASE 5: Assign ungrouped lines to steps
    // ============================================
    const orphanedLines: string[] = [];

    // Find setup bucket (use "Set up job" or "Set up runner")
    const setupBucket = setUpJobBucket || setUpRunnerBucket;

    // Track content-based state for post cleanup
    let inPostCleanup = false;
    let currentPostBucket: StepBucket | undefined = undefined;

    for (const item of ungroupedLines) {
      let assignedBucket: StepBucket | undefined = undefined;
      const lineContent = item.line.toLowerCase();

      // Content-based heuristics for post cleanup
      if (lineContent.includes('post job cleanup')) {
        inPostCleanup = true;
        // Find the first post bucket that matches
        currentPostBucket =
          postBuckets.find((b) => b.step.name.toLowerCase().includes('post checkout')) ||
          postBuckets[0];
      } else if (lineContent.includes('cleaning up orphan processes')) {
        currentPostBucket = completeJobBucket;
      }

      if (inPostCleanup && currentPostBucket) {
        assignedBucket = currentPostBucket;
      }

      // ============================================
      // FIX E: Check topLevelIndexToBucket map FIRST
      // ============================================
      // If we have a preceding group, attach to the bucket that owns that group.
      // This ensures ungrouped lines go to the same bucket as their preceding group,
      // even when Phase 4 matched groups to non-sequential buckets.
      if (!assignedBucket && item.afterGroupIndex >= 0) {
        const mapped = topLevelIndexToBucket.get(item.afterGroupIndex);
        if (mapped) assignedBucket = mapped;
      }

      // THEN fall back to setup/post heuristics only if mapping didn't work
      if (!assignedBucket) {
        if (item.afterGroupIndex < 0) {
          // Before any groups → setup
          assignedBucket = setupBucket;
        } else if (item.afterGroupIndex < firstStepRunIndex) {
          // Between setup groups → setup
          assignedBucket = setupBucket;
        } else if (item.afterGroupIndex >= lastStepRunIndex && postBuckets.length > 0) {
          // After last run group → post
          assignedBucket = postBuckets[0];
        }
      }

      // Final fallback: use timestamp
      if (!assignedBucket && item.timestamp !== undefined) {
        assignedBucket = findStepForTimestamp(item.timestamp, stepBuckets);
      }

      if (assignedBucket) {
        assignedBucket.ungroupedLines.push(item.line);
      } else {
        orphanedLines.push(item.line);
      }
    }

    /**
     * Find step bucket for a timestamp (fallback only)
     * FIX C: Skip steps with missing timestamps to avoid matching everything
     */
    function findStepForTimestamp(ts: number, buckets: StepBucket[]): StepBucket | undefined {
      for (const bucket of buckets) {
        // Skip buckets without both timestamps - they would match everything
        if (!bucket.step.startedAt || !bucket.step.completedAt) continue;

        const startMs = new Date(bucket.step.startedAt).getTime();
        const endMs = new Date(bucket.step.completedAt).getTime() + 999;
        if (ts >= startMs && ts <= endMs) {
          return bucket;
        }
      }
      return undefined;
    }

    // ============================================
    // Collect orphaned groups using topLevelIndex (not name)
    // ============================================
    // FIX: Using names as keys is incorrect because group names are NOT unique.
    // Multiple "Run actions/checkout@v4" groups would cause some to be "lost".
    // Using topLevelIndex ensures each group is tracked individually.
    const orphanedGroups = topLevelGroups.filter(
      (g) => g.topLevelIndex !== undefined && !topLevelIndexToBucket.has(g.topLevelIndex)
    );

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
        <!-- Use recursive LogGroupComponent for arbitrary nesting depth -->
        {#each parsedLogs.groups as group (group.id)}
          <LogGroupComponent
            {group}
            depth={0}
            {formatLogLine}
            {lineMatchesSearch}
            onToggle={toggleGroup}
            onOpenUrl={openUrl}
            onViewRawLogs={viewRawLogs}
            {formatDuration}
          />
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

  .spinning {
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
</style>
