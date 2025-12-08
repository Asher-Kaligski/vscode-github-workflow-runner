import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchWorkflowWithRunId, fetchLatestRunId } from './workflow-dispatcher';
import { TokenManager } from '../utils/token-manager';

// Minimal VS Code mock so modules depending on `vscode` can be imported in tests.
vi.mock('vscode', () => ({
  default: {},
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_section: string, defaultValue: unknown) => defaultValue),
    })),
  },
  authentication: {
    getSession: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('fetchLatestRunId', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).fetch = fetchMock;
    fetchMock.mockReset();
    vi.spyOn(TokenManager, 'getGithubToken').mockResolvedValue('test-token');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches unfiltered runs and selects the newest run matching the branch', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        workflow_runs: [
          { id: 3, head_branch: 'other-branch' },
          { id: 2, head_branch: 'feature-branch' },
          { id: 1, head_branch: 'feature-branch' },
        ],
      }),
    } as Response);

    const promise = fetchLatestRunId('owner', 'repo', 'workflow.yml', 'feature-branch');

    await vi.runAllTimersAsync();
    const runId = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;

    expect(url).toContain(
      'https://api.github.com/repos/owner/repo/actions/workflows/workflow.yml/runs'
    );
    expect(url).toContain('per_page=20');
    expect(url).not.toContain('branch=');

    expect(runId).toBe(2);
  });

  it('returns undefined when no runs match the requested branch', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        workflow_runs: [{ id: 1, head_branch: 'other-branch' }],
      }),
    } as Response);

    const promise = fetchLatestRunId('owner', 'repo', 'workflow.yml', 'feature-branch');

    await vi.runAllTimersAsync();
    const runId = await promise;

    expect(runId).toBeUndefined();
  });

  it('returns undefined when the request fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const promise = fetchLatestRunId('owner', 'repo', 'workflow.yml', 'feature-branch');

    await vi.runAllTimersAsync();
    const runId = await promise;

    expect(runId).toBeUndefined();
  });
});

describe('dispatchWorkflowWithRunId', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).fetch = fetchMock;
    fetchMock.mockReset();
    vi.spyOn(TokenManager, 'getGithubToken').mockResolvedValue('test-token');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('dispatches the workflow and resolves the latest run id', async () => {
    // First call: workflow dispatch, second call: fetchLatestRunId
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          workflow_runs: [{ id: 42, head_branch: 'main' }],
        }),
      } as Response);

    const definition = {
      filename: 'workflow.yml',
      name: 'Test workflow',
      inputs: [],
    } as any;

    const request = {
      ref: 'main',
      inputs: { foo: 'bar' },
    };

    const promise = dispatchWorkflowWithRunId('owner', 'repo', definition, request);

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.runId).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns validation error without calling the GitHub API', async () => {
    const definition = {
      filename: 'workflow.yml',
      name: 'Test workflow',
      inputs: [
        {
          name: 'required-input',
          required: true,
          type: 'string',
          description: 'A required input',
        },
      ],
    } as any;

    const request = {
      ref: 'main',
      inputs: {},
    };

    const promise = dispatchWorkflowWithRunId('owner', 'repo', definition, request);

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('Validation failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
