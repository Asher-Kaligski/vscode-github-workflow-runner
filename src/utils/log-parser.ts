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
