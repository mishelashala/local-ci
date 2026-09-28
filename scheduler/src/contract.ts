/**
 * Frozen shapes for the develop merge and GitHub push.
 * Dashboard calls these through the Vite proxy: /api/repo, /api/merges, /api/pushes.
 */

export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'canceled' | 'stale';

export type RepoSnapshot = {
  id: string;
  name: string;
  barePath: string;
  maxBranchDrift: number;
  develop: string | null;
  branches: {
    name: string;
    sha: string;
    aheadOfDevelop: number | null;
    behindDevelop: number | null;
    status:
      | 'ready-to-merge'
      | 'passed'
      | 'failed'
      | 'running'
      | 'queued'
      | 'sync-required'
      | 'idle'
      | 'ready-to-deploy';
  }[];
  origin: string | null;
};

export type RepositoryRegistration = {
  id: string;
  name: string;
  barePath: string;
  origin: string | null;
  createdAt: number;
};

export type MergeBody = {
  runId: string;
};

export type MergeResult = {
  develop: string;
};

export type PushBody = {
  branch: 'develop';
};

export type PushResult = {
  sha: string;
  remote: string;
};
