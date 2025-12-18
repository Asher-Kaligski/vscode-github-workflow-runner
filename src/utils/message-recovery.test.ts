import { describe, it, expect } from 'vitest';
import {
  MESSAGE_RESPONSE_TYPES,
  DEFAULT_FETCH_TIMEOUT_MS,
  STUCK_LOADING_THRESHOLD_MS,
  getResponseTypeForMessage,
  createErrorResponse,
  isLoadingStuck,
  hasBlockingFlags,
  getResetLoadingState,
  formatStuckStateDiagnostic,
  type LoadingStateFlags,
} from './message-recovery';

describe('MESSAGE_RESPONSE_TYPES', () => {
  it('maps getWorkflowRuns to getWorkflowRuns', () => {
    expect(MESSAGE_RESPONSE_TYPES['getWorkflowRuns']).toBe('getWorkflowRuns');
  });

  it('maps getWorkflowId to getWorkflowIdResponse', () => {
    expect(MESSAGE_RESPONSE_TYPES['getWorkflowId']).toBe('getWorkflowIdResponse');
  });

  it('maps all critical message types', () => {
    const criticalTypes = [
      'getWorkflowRuns',
      'getWorkflows',
      'getWorkflowId',
      'getUserInfo',
      'loadMoreRuns',
      'getWorkflowRunJobs',
    ];
    for (const type of criticalTypes) {
      expect(MESSAGE_RESPONSE_TYPES[type]).toBeDefined();
    }
  });
});

describe('timeout constants', () => {
  it('DEFAULT_FETCH_TIMEOUT_MS is 30 seconds', () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(30000);
  });

  it('STUCK_LOADING_THRESHOLD_MS is 30 seconds', () => {
    expect(STUCK_LOADING_THRESHOLD_MS).toBe(30000);
  });
});

describe('getResponseTypeForMessage', () => {
  it('returns correct response type for known message types', () => {
    expect(getResponseTypeForMessage('getWorkflowRuns')).toBe('getWorkflowRuns');
    expect(getResponseTypeForMessage('getWorkflowId')).toBe('getWorkflowIdResponse');
    expect(getResponseTypeForMessage('cancelWorkflowRun')).toBe('cancelWorkflowRunResponse');
  });

  it('returns undefined for unknown message types', () => {
    expect(getResponseTypeForMessage('unknownType')).toBeUndefined();
    expect(getResponseTypeForMessage('webviewReady')).toBeUndefined();
  });
});

describe('createErrorResponse', () => {
  it('creates error response with Error object', () => {
    const error = new Error('Test error message');
    const response = createErrorResponse('getWorkflowRuns', error);

    expect(response.type).toBe('getWorkflowRuns');
    expect(response.success).toBe(false);
    expect(response.error).toBe('Internal error: Test error message');
  });

  it('creates error response with non-Error object', () => {
    const response = createErrorResponse('getWorkflows', 'string error');

    expect(response.type).toBe('getWorkflows');
    expect(response.success).toBe(false);
    expect(response.error).toBe('Internal error: Unknown error');
  });

  it('creates error response with undefined error', () => {
    const response = createErrorResponse('getUserInfo', undefined);

    expect(response.success).toBe(false);
    expect(response.error).toBe('Internal error: Unknown error');
  });
});

describe('isLoadingStuck', () => {
  it('returns false when loadingStartTime is null', () => {
    expect(isLoadingStuck(null)).toBe(false);
  });

  it('returns false when loading just started', () => {
    const now = Date.now();
    expect(isLoadingStuck(now, now + 1000)).toBe(false);
  });

  it('returns false when loading is within threshold', () => {
    const now = Date.now();
    expect(isLoadingStuck(now, now + 29000)).toBe(false);
  });

  it('returns true when loading exceeds threshold', () => {
    const now = Date.now();
    expect(isLoadingStuck(now, now + 31000)).toBe(true);
  });

  it('respects custom threshold', () => {
    const now = Date.now();
    expect(isLoadingStuck(now, now + 5000, 3000)).toBe(true);
    expect(isLoadingStuck(now, now + 2000, 3000)).toBe(false);
  });
});

describe('hasBlockingFlags', () => {
  const defaultFlags: LoadingStateFlags = {
    loading: false,
    refreshing: false,
    isManualWorkflowFetch: false,
    waitingForInitialFilters: false,
    pendingWorkflowId: null,
  };

  it('returns false when no flags are set', () => {
    expect(hasBlockingFlags(defaultFlags)).toBe(false);
  });

  it('returns true when loading is true', () => {
    expect(hasBlockingFlags({ ...defaultFlags, loading: true })).toBe(true);
  });

  it('returns true when refreshing is true', () => {
    expect(hasBlockingFlags({ ...defaultFlags, refreshing: true })).toBe(true);
  });

  it('returns true when isManualWorkflowFetch is true', () => {
    expect(hasBlockingFlags({ ...defaultFlags, isManualWorkflowFetch: true })).toBe(true);
  });

  it('returns true when waitingForInitialFilters is true', () => {
    expect(hasBlockingFlags({ ...defaultFlags, waitingForInitialFilters: true })).toBe(true);
  });

  it('returns true when pendingWorkflowId is set to number', () => {
    expect(hasBlockingFlags({ ...defaultFlags, pendingWorkflowId: 123 })).toBe(true);
  });

  it('returns true when pendingWorkflowId is set to string', () => {
    expect(hasBlockingFlags({ ...defaultFlags, pendingWorkflowId: 'all' })).toBe(true);
  });
});

describe('getResetLoadingState', () => {
  it('returns all flags as false/null', () => {
    const reset = getResetLoadingState();

    expect(reset.loading).toBe(false);
    expect(reset.refreshing).toBe(false);
    expect(reset.isManualWorkflowFetch).toBe(false);
    expect(reset.waitingForInitialFilters).toBe(false);
    expect(reset.pendingWorkflowId).toBeNull();
  });

  it('returns a new object each time', () => {
    const reset1 = getResetLoadingState();
    const reset2 = getResetLoadingState();

    expect(reset1).not.toBe(reset2);
    expect(reset1).toEqual(reset2);
  });
});

describe('formatStuckStateDiagnostic', () => {
  const sampleFlags: LoadingStateFlags = {
    loading: true,
    refreshing: false,
    isManualWorkflowFetch: true,
    waitingForInitialFilters: false,
    pendingWorkflowId: 123,
  };

  it('includes all flag values in output', () => {
    const diagnostic = formatStuckStateDiagnostic(sampleFlags, Date.now() - 5000);

    expect(diagnostic).toContain('loading=true');
    expect(diagnostic).toContain('refreshing=false');
    expect(diagnostic).toContain('isManualWorkflowFetch=true');
    expect(diagnostic).toContain('waitingForInitialFilters=false');
    expect(diagnostic).toContain('pendingWorkflowId=123');
  });

  it('calculates duration in seconds', () => {
    const startTime = Date.now() - 10000; // 10 seconds ago
    const diagnostic = formatStuckStateDiagnostic(sampleFlags, startTime);

    expect(diagnostic).toMatch(/Loading stuck for \d+s/);
  });

  it('handles null loadingStartTime', () => {
    const diagnostic = formatStuckStateDiagnostic(sampleFlags, null);

    expect(diagnostic).toContain('Loading stuck for 0s');
  });

  it('includes error message when provided', () => {
    const diagnostic = formatStuckStateDiagnostic(sampleFlags, Date.now(), 'Test error');

    expect(diagnostic).toContain('error="Test error"');
  });

  it('excludes error when not provided', () => {
    const diagnostic = formatStuckStateDiagnostic(sampleFlags, Date.now());

    expect(diagnostic).not.toContain('error=');
  });
});
