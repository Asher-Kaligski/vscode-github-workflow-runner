import { describe, it, expect } from 'vitest';
import { parseJobLogs, extractStepLogs } from './log-parser';

describe('parseJobLogs', () => {
  it('returns content with line count (keeps ANSI codes intact)', () => {
    const input = '[36;1mLine 1[0m\nLine 2\n[1mLine 3[0m';
    const result = parseJobLogs(input);

    // The reverted version keeps ANSI codes intact for VSCode to handle
    expect(result.content).toBe(input);
    expect(result.lineCount).toBe(3);
  });

  it('handles empty logs', () => {
    const result = parseJobLogs('');
    expect(result.content).toBe('');
    expect(result.lineCount).toBe(1);
  });
});

describe('extractStepLogs', () => {
  const sampleLog = `2025-01-01T00:00:00.0000000Z Current runner version: '2.329.0'
2025-01-01T00:00:00.0000000Z ##[group]Runner Image Provisioner
2025-01-01T00:00:00.0000000Z Version: 1.0
2025-01-01T00:00:00.0000000Z ##[endgroup]
2025-01-01T00:00:00.0000000Z ##[group]Operating System
2025-01-01T00:00:00.0000000Z Ubuntu 24.04
2025-01-01T00:00:00.0000000Z ##[endgroup]
2025-01-01T00:00:00.0000000Z Prepare workflow directory
2025-01-01T00:00:00.0000000Z ##[group]Run actions/checkout@v4
2025-01-01T00:00:00.0000000Z with:
2025-01-01T00:00:00.0000000Z   repository: owner/repo
2025-01-01T00:00:00.0000000Z ##[group]Getting Git version info
2025-01-01T00:00:00.0000000Z git version 2.52.0
2025-01-01T00:00:00.0000000Z ##[endgroup]
2025-01-01T00:00:00.0000000Z Checkout done
2025-01-01T00:00:00.0000000Z ##[endgroup]
2025-01-01T00:00:00.0000000Z ##[group]Run echo "Hello World"
2025-01-01T00:00:00.0000000Z [36;1mecho "Hello World"[0m
2025-01-01T00:00:00.0000000Z Hello World
2025-01-01T00:00:00.0000000Z ##[endgroup]
2025-01-01T00:00:00.0000000Z ##[group]Run npm test
2025-01-01T00:00:00.0000000Z Running tests...
2025-01-01T00:00:00.0000000Z ##[endgroup]
2025-01-01T00:00:00.0000000Z Post job cleanup.
2025-01-01T00:00:00.0000000Z Cleanup done`;

  it('extracts "Set up job" logs for step 1', () => {
    const result = extractStepLogs(sampleLog, 1);

    expect(result).not.toBeNull();
    expect(result!.content).toContain('Current runner version');
    expect(result!.content).toContain('Runner Image Provisioner');
    expect(result!.content).toContain('Prepare workflow directory');
    expect(result!.content).not.toContain('Run actions/checkout');
  });

  it('extracts first user step logs for step 2', () => {
    const result = extractStepLogs(sampleLog, 2, 'actions/checkout@v4');

    expect(result).not.toBeNull();
    expect(result!.content).toContain('Run actions/checkout@v4');
    expect(result!.content).toContain('Getting Git version info');
    expect(result!.content).toContain('Checkout done');
    expect(result!.content).not.toContain('Hello World');
  });

  it('extracts second user step logs for step 3', () => {
    const result = extractStepLogs(sampleLog, 3);

    expect(result).not.toBeNull();
    expect(result!.content).toContain('Run echo "Hello World"');
    expect(result!.content).toContain('Hello World');
    // ANSI codes are kept intact for VSCode to handle
    expect(result!.content).toContain('[36;1m');
  });

  it('extracts third user step logs for step 4', () => {
    const result = extractStepLogs(sampleLog, 4);

    expect(result).not.toBeNull();
    expect(result!.content).toContain('Run npm test');
    expect(result!.content).toContain('Running tests...');
  });

  it('returns null for invalid step number', () => {
    const result = extractStepLogs(sampleLog, 100);
    expect(result).toBeNull();
  });

  it('handles nested groups within steps', () => {
    const result = extractStepLogs(sampleLog, 2);

    expect(result).not.toBeNull();
    // The nested "Getting Git version info" group should be included
    expect(result!.content).toContain('Getting Git version info');
    expect(result!.content).toContain('git version 2.52.0');
  });
});
