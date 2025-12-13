/**
 * Log parser utility for GitHub Actions workflow logs
 * Parses ANSI color codes and formats logs for display in VSCode text editor
 */

/**
 * Parsed log structure for text document display
 */
export interface ParsedLog {
  content: string; // Plain text content with ANSI codes preserved
  lineCount: number;
}

/**
 * Parse job logs (plain text with ANSI codes)
 * For use with TextDocumentContentProvider
 */
export function parseJobLogs(logData: string): ParsedLog {
  // Keep ANSI codes intact - VSCode will handle them with proper language support
  const lines = logData.split('\n');

  return {
    content: logData,
    lineCount: lines.length,
  };
}

/**
 * Extract logs for a specific step from job logs
 * GitHub Actions logs have timestamps and step markers that help identify step boundaries
 * Step markers look like: "##[group]Run step-name" or similar patterns
 *
 * IMPORTANT: GitHub Actions logs contain BOTH:
 * 1. Internal groups from the runner (e.g., "Runner Image Provisioner", "Operating System", "GITHUB_TOKEN Permissions")
 * 2. User-defined step groups that start with "Run " (e.g., "Run actions/checkout@v4", "Run echo 'hello'")
 *
 * The step number from GitHub API includes special steps like "Set up job" (1) and "Complete job" (last)
 * which don't have corresponding ##[group] entries in the logs. User action steps start at number 2.
 *
 * Strategy:
 * 1. Skip all internal runner groups
 * 2. Count only groups that start with "Run " (these are actual workflow steps)
 * 3. Map API step number to log group: logGroupIndex = stepNumber - 1 (since API step 1 is "Set up job")
 *
 * @param logData Full job logs
 * @param stepNumber The step number (1-based) from GitHub API
 * @param stepName The step name (for informational purposes, not used for matching due to name differences)
 * @returns Extracted step logs or null if step not found
 */
export function extractStepLogs(
  logData: string,
  stepNumber: number,
  stepName?: string
): ParsedLog | null {
  const lines = logData.split('\n');

  // GitHub Actions log patterns:
  // - Step groups: ##[group]<step name> or timestamp ##[group]<step name>
  // - Step end: ##[endgroup]
  // - Timestamp lines: 2024-01-01T00:00:00.0000000Z <content>
  const groupStartPattern = /##\[group\]/;
  const groupEndPattern = /##\[endgroup\]/;

  // Internal runner groups to skip - these are NOT user workflow steps
  // They appear at the beginning of logs before actual workflow steps
  const internalGroupPatterns = [
    /##\[group\]Runner Image/i,
    /##\[group\]Operating System/i,
    /##\[group\]GITHUB_TOKEN Permissions/i,
    /##\[group\]Virtual Environment/i,
    /##\[group\]Runner Context/i,
    /##\[group\]Environment variables/i,
  ];

  /**
   * Checks if a line is an internal runner group (not a user step)
   */
  function isInternalGroup(line: string): boolean {
    return internalGroupPatterns.some((pattern) => pattern.test(line));
  }

  // Collect all user step groups (groups that start with "Run ")
  // These correspond to actual workflow steps in the GitHub API (steps 2, 3, 4, ...)
  // API step 1 is "Set up job" which has no ##[group] in logs
  // API last step is "Complete job" which also has no ##[group] in logs
  interface StepRange {
    startLine: number;
    endLine: number;
  }

  const userStepGroups: StepRange[] = [];
  let currentGroupStart = -1;
  let inGroup = false;
  let nestingLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (groupStartPattern.test(line)) {
      // Check if this is an internal group - skip it
      if (isInternalGroup(line)) {
        // Still track nesting for internal groups
        if (inGroup) {
          nestingLevel++;
        }
        continue;
      }

      // This is a user step group (starts with "Run ")
      if (!inGroup) {
        // Start of a new top-level user step
        currentGroupStart = i;
        inGroup = true;
        nestingLevel = 0;
      } else {
        // Nested group within a step - increment nesting level
        nestingLevel++;
      }
    } else if (groupEndPattern.test(line)) {
      if (inGroup) {
        if (nestingLevel > 0) {
          // End of a nested group
          nestingLevel--;
        } else {
          // End of the top-level step group
          userStepGroups.push({
            startLine: currentGroupStart,
            endLine: i + 1, // Include the ##[endgroup] line
          });
          inGroup = false;
          currentGroupStart = -1;
        }
      }
    }
  }

  // Handle case where a group wasn't closed (goes to end of file)
  if (inGroup && currentGroupStart !== -1) {
    userStepGroups.push({
      startLine: currentGroupStart,
      endLine: lines.length,
    });
  }

  // Map API step number to user step group index
  // API step 1 = "Set up job" (no log group)
  // API step 2 = First user step = userStepGroups[0]
  // API step 3 = Second user step = userStepGroups[1]
  // etc.
  // So: groupIndex = stepNumber - 2
  const groupIndex = stepNumber - 2;

  if (groupIndex < 0 || groupIndex >= userStepGroups.length) {
    // Step 1 "Set up job" or invalid step number
    // For "Set up job", we could return the content before the first user step
    if (stepNumber === 1) {
      // Return everything before the first user step group
      const endLine = userStepGroups.length > 0 ? userStepGroups[0].startLine : lines.length;
      const stepLines = lines.slice(0, endLine);
      if (stepLines.length > 0) {
        return {
          content: stepLines.join('\n'),
          lineCount: stepLines.length,
        };
      }
    }
    return null;
  }

  const stepRange = userStepGroups[groupIndex];
  const stepLines = lines.slice(stepRange.startLine, stepRange.endLine);
  const content = stepLines.join('\n');

  return {
    content,
    lineCount: stepLines.length,
  };
}
