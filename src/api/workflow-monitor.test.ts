import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getWorkflowRuns } from './workflow-monitor';
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

describe('getWorkflowRuns', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    (globalThis as any).fetch = fetchMock;
    fetchMock.mockReset();
    vi.spyOn(TokenManager, 'getGithubToken').mockResolvedValue('test-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not include branch, actor or status in query parameters', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ workflow_runs: [], total_count: 0 }),
    } as Response);

    await getWorkflowRuns('owner', 'repo', {
      workflowId: 123,
      branch: 'feature-branch',
      actor: 'octocat',
      status: 'completed',
      perPage: 50, // Note: perPage is ignored by API layer, always uses 100
      page: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;

    expect(url).toContain('https://api.github.com/repos/owner/repo/actions/workflows/123/runs');
    // API always uses per_page=100 (GitHub's max) to minimize rate limit usage
    // The perPage option is only used for UI display purposes
    expect(url).toContain('per_page=100');
    expect(url).toContain('page=2');
    expect(url).not.toContain('branch=');
    expect(url).not.toContain('actor=');
    expect(url).not.toContain('status=');
  });

  it('includes created date range parameter when dates are provided', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ workflow_runs: [], total_count: 0 }),
    } as Response);

    const fromDate = new Date('2025-11-20T06:59:00.000Z');
    const toDate = new Date('2025-11-20T09:59:00.000Z');

    await getWorkflowRuns('owner', 'repo', {
      workflowId: 123,
      perPage: 100,
      page: 1,
      createdFrom: fromDate,
      createdTo: toDate,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;

    expect(url).toContain('https://api.github.com/repos/owner/repo/actions/workflows/123/runs');
    expect(url).toContain('per_page=100');
    expect(url).toContain('page=1');
    expect(url).toContain('created=2025-11-20T06%3A59%3A00.000Z..2025-11-20T09%3A59%3A00.000Z');
  });

  it('supports open-ended date ranges with wildcard', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ workflow_runs: [], total_count: 0 }),
    } as Response);

    const fromDate = new Date('2025-11-20T06:59:00.000Z');

    await getWorkflowRuns('owner', 'repo', {
      workflowId: 123,
      createdFrom: fromDate,
      // No createdTo - should use wildcard
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;

    expect(url).toContain('created=2025-11-20T06%3A59%3A00.000Z..*');
  });

  it('does not include created parameter when no dates provided', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ workflow_runs: [], total_count: 0 }),
    } as Response);

    await getWorkflowRuns('owner', 'repo', {
      workflowId: 123,
      perPage: 50,
      page: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;

    expect(url).not.toContain('created=');
  });
});
