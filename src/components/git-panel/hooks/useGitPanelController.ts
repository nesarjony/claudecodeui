import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { DEFAULT_BRANCH, RECENT_COMMITS_LIMIT } from '../constants/constants';
import type {
  GitApiErrorResponse,
  GitBranchesResponse,
  GitCommitSummary,
  GitCommitsResponse,
  GitDiffMap,
  GitDiffResponse,
  GitFileWithDiffResponse,
  GitGenerateMessageResponse,
  GitOperationResponse,
  GitPanelController,
  GitRemoteStatus,
  GitStatusResponse,
  UseGitPanelControllerOptions,
} from '../types/types';
import { getAllChangedFiles } from '../utils/gitPanelUtils';
import { useSelectedProvider } from './useSelectedProvider';

// ! use authenticatedFetch directly. fetchWithAuth is redundant 
const fetchWithAuth = authenticatedFetch as (url: string, options?: RequestInit) => Promise<Response>;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function readJson<T>(response: Response, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException('Request aborted', 'AbortError');
  }

  const data = (await response.json()) as T;

  if (signal?.aborted) {
    throw new DOMException('Request aborted', 'AbortError');
  }

  return data;
}

export function useGitPanelController({
  selectedProject,
  worktreePath,
  activeView,
  onFileOpen,
}: UseGitPanelControllerOptions): GitPanelController {
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffMap>({});
  const [isLoading, setIsLoading] = useState(false);
  const [currentBranch, setCurrentBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [recentCommits, setRecentCommits] = useState<GitCommitSummary[]>([]);
  const [commitDiffs, setCommitDiffs] = useState<GitDiffMap>({});
  const [remoteStatus, setRemoteStatus] = useState<GitRemoteStatus | null>(null);
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isCreatingInitialCommit, setIsCreatingInitialCommit] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const worktreePathRef = useRef(worktreePath);
  worktreePathRef.current = worktreePath;

  const fetchGit = useCallback((url: string, options: RequestInit = {}) => {
    const selectedWorktree = worktreePathRef.current;
    if (!selectedWorktree) {
      return fetchWithAuth(url, options);
    }

    return fetchWithAuth(url, {
      ...options,
      headers: {
        ...options.headers,
        'X-CloudCLI-Git-Worktree': encodeURIComponent(selectedWorktree),
      },
    });
  }, []);

  const clearOperationError = useCallback(() => setOperationError(null), []);
  // Includes the worktree because two requests for the same project can still
  // target different repositories. A late response from the previous worktree
  // must never overwrite the newly selected worktree's state.
  const selectedGitTargetRef = useRef('');
  selectedGitTargetRef.current = `${selectedProject?.projectId ?? ''}\0${worktreePath ?? ''}`;

  const provider = useSelectedProvider();

  const fetchFileDiff = useCallback(
    async (filePath: string, signal?: AbortSignal) => {
      if (!selectedProject) {
        return;
      }

      // Git endpoints receive the DB projectId via the `project` query param.
      const projectId = selectedProject.projectId;
      const gitTarget = `${projectId}\0${worktreePathRef.current ?? ''}`;

      try {
        const response = await fetchGit(
          `/api/git/diff?project=${encodeURIComponent(projectId)}&file=${encodeURIComponent(filePath)}`,
          { signal },
        );
        const data = await readJson<GitDiffResponse>(response, signal);

        if (
          signal?.aborted ||
          selectedGitTargetRef.current !== gitTarget
        ) {
          return;
        }

        if (!data.error && data.diff) {
          setGitDiff((previous) => ({
            ...previous,
            [filePath]: data.diff as string,
          }));
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          return;
        }

        console.error('Error fetching file diff:', error);
      }
    },
    [selectedProject],
  );

  const fetchGitStatus = useCallback(async (signal?: AbortSignal) => {
    if (!selectedProject) {
      return;
    }

    // `project` query param carries the DB projectId everywhere now.
    const projectId = selectedProject.projectId;
    const gitTarget = `${projectId}\0${worktreePathRef.current ?? ''}`;

    setIsLoading(true);
    try {
      const response = await fetchGit(`/api/git/status?project=${encodeURIComponent(projectId)}`, { signal });
      const data = await readJson<GitStatusResponse>(response, signal);

      if (
        signal?.aborted ||
        selectedGitTargetRef.current !== gitTarget
      ) {
        return;
      }

      if (data.error) {
        console.error('Git status error:', data.error);
        setGitStatus({ error: data.error, details: data.details });
        setCurrentBranch('');
        return;
      }

      setGitStatus(data);
      setCurrentBranch(data.branch || DEFAULT_BRANCH);

      const changedFiles = getAllChangedFiles(data);
      changedFiles.forEach((filePath) => {
        void fetchFileDiff(filePath, signal);
      });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return;
      }

      if (
        selectedGitTargetRef.current !== gitTarget
      ) {
        return;
      }

      console.error('Error fetching git status:', error);
      setGitStatus({ error: 'Git operation failed', details: String(error) });
      setCurrentBranch('');
    } finally {
      setIsLoading(false);
    }
  }, [fetchFileDiff, selectedProject]);

  const fetchBranches = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    try {
      const response = await fetchGit(`/api/git/branches?project=${encodeURIComponent(selectedProject.projectId)}`);
      const data = await readJson<GitBranchesResponse>(response);

      if (!data.error && data.branches) {
        setBranches(data.branches);
        setLocalBranches(data.localBranches ?? data.branches);
        setRemoteBranches(data.remoteBranches ?? []);
        return;
      }

      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
    } catch (error) {
      console.error('Error fetching branches:', error);
      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
    }
  }, [selectedProject]);

  const fetchRemoteStatus = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    try {
      const response = await fetchGit(`/api/git/remote-status?project=${encodeURIComponent(selectedProject.projectId)}`);
      const data = await readJson<GitRemoteStatus | GitApiErrorResponse>(response);

      if (!data.error) {
        setRemoteStatus(data as GitRemoteStatus);
        return;
      }

      setRemoteStatus(null);
    } catch (error) {
      console.error('Error fetching remote status:', error);
      setRemoteStatus(null);
    }
  }, [selectedProject]);

  const switchBranch = useCallback(
    async (branchName: string) => {
      if (!selectedProject) {
        return false;
      }

      try {
        const response = await fetchGit('/api/git/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            branch: branchName,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          console.error('Failed to switch branch:', data.error);
          return false;
        }

        setCurrentBranch(branchName);
        void fetchGitStatus();
        return true;
      } catch (error) {
        console.error('Error switching branch:', error);
        return false;
      }
    },
    [fetchGitStatus, selectedProject],
  );

  const createBranch = useCallback(
    async (branchName: string) => {
      const trimmedBranchName = branchName.trim();
      if (!selectedProject || !trimmedBranchName) {
        return false;
      }

      setIsCreatingBranch(true);
      try {
        const response = await fetchGit('/api/git/create-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            branch: trimmedBranchName,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          console.error('Failed to create branch:', data.error);
          return false;
        }

        setCurrentBranch(trimmedBranchName);
        void fetchBranches();
        void fetchGitStatus();
        return true;
      } catch (error) {
        console.error('Error creating branch:', error);
        return false;
      } finally {
        setIsCreatingBranch(false);
      }
    },
    [fetchBranches, fetchGitStatus, selectedProject],
  );

  const deleteBranch = useCallback(
    async (branchName: string) => {
      if (!selectedProject) return false;

      try {
        const response = await fetchGit('/api/git/delete-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: selectedProject.projectId, branch: branchName }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          setOperationError(data.error ?? 'Delete branch failed');
          return false;
        }

        void fetchBranches();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Delete branch failed');
        return false;
      }
    },
    [fetchBranches, selectedProject],
  );

  const handleFetch = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsFetching(true);
    try {
      const response = await fetchGit('/api/git/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject.projectId,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        void fetchBranches();
        return;
      }

      setOperationError(data.error ?? 'Fetch failed');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Fetch failed');
    } finally {
      setIsFetching(false);
    }
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus, selectedProject, worktreePath]);

  const handlePull = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsPulling(true);
    try {
      const response = await fetchGit('/api/git/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject.projectId,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      setOperationError(data.error ?? 'Pull failed');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Pull failed');
    } finally {
      setIsPulling(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, selectedProject]);

  const handlePush = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsPushing(true);
    try {
      const response = await fetchGit('/api/git/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject.projectId,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      setOperationError(data.error ?? 'Push failed');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Push failed');
    } finally {
      setIsPushing(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, selectedProject]);

  const handlePublish = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsPublishing(true);
    try {
      const response = await fetchGit('/api/git/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject.projectId,
          branch: currentBranch,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      console.error('Publish failed:', data.error);
    } catch (error) {
      console.error('Error publishing branch:', error);
    } finally {
      setIsPublishing(false);
    }
  }, [currentBranch, fetchGitStatus, fetchRemoteStatus, selectedProject]);

  const discardChanges = useCallback(
    async (filePath: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const response = await fetchGit('/api/git/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            file: filePath,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        console.error('Discard failed:', data.error);
      } catch (error) {
        console.error('Error discarding changes:', error);
      }
    },
    [fetchGitStatus, selectedProject],
  );

  const deleteUntrackedFile = useCallback(
    async (filePath: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const response = await fetchGit('/api/git/delete-untracked', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            file: filePath,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        console.error('Delete failed:', data.error);
      } catch (error) {
        console.error('Error deleting untracked file:', error);
      }
    },
    [fetchGitStatus, selectedProject],
  );

  const stageFiles = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return false;
      }

      try {
        const response = await fetchGit('/api/git/stage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            files,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          setOperationError(data.error ?? 'Stage failed');
          return false;
        }

        // Refresh so the Staged section re-syncs from the real index.
        await fetchGitStatus();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Stage failed');
        return false;
      }
    },
    [fetchGitStatus, selectedProject],
  );

  const unstageFiles = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return false;
      }

      try {
        const response = await fetchGit('/api/git/unstage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            files,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          setOperationError(data.error ?? 'Unstage failed');
          return false;
        }

        await fetchGitStatus();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Unstage failed');
        return false;
      }
    },
    [fetchGitStatus, selectedProject],
  );

  const fetchRecentCommits = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    try {
      const response = await fetchGit(
        `/api/git/commits?project=${encodeURIComponent(selectedProject.projectId)}&limit=${RECENT_COMMITS_LIMIT}`,
      );
      const data = await readJson<GitCommitsResponse>(response);

      if (!data.error && data.commits) {
        setRecentCommits(data.commits);
      }
    } catch (error) {
      console.error('Error fetching commits:', error);
    }
  }, [selectedProject]);

  const fetchCommitDiff = useCallback(
    async (commitHash: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const response = await fetchGit(
          `/api/git/commit-diff?project=${encodeURIComponent(selectedProject.projectId)}&commit=${commitHash}`,
        );
        const data = await readJson<GitDiffResponse>(response);

        if (!data.error && data.diff) {
          setCommitDiffs((previous) => ({
            ...previous,
            [commitHash]: data.diff as string,
          }));
        }
      } catch (error) {
        console.error('Error fetching commit diff:', error);
      }
    },
    [selectedProject],
  );

  const generateCommitMessage = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return null;
      }

      try {
        const response = await fetchGit('/api/git/generate-commit-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            files,
            provider,
          }),
        });

        const data = await readJson<GitGenerateMessageResponse>(response);
        if (data.message) {
          return data.message;
        }

        console.error('Failed to generate commit message:', data.error);
        return null;
      } catch (error) {
        console.error('Error generating commit message:', error);
        return null;
      }
    },
    [provider, selectedProject],
  );

  const commitChanges = useCallback(
    async (message: string, files: string[]) => {
      if (!selectedProject || !message.trim() || files.length === 0) {
        return false;
      }

      try {
        const response = await fetchGit('/api/git/commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            message,
            files,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          void fetchRemoteStatus();
          return true;
        }

        console.error('Commit failed:', data.error);
        return false;
      } catch (error) {
        console.error('Error committing changes:', error);
        return false;
      }
    },
    [fetchGitStatus, fetchRemoteStatus, selectedProject],
  );

  const createInitialCommit = useCallback(async () => {
    if (!selectedProject) {
      throw new Error('No project selected');
    }

    setIsCreatingInitialCommit(true);
    try {
      const response = await fetchGit('/api/git/initial-commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject.projectId,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return true;
      }

      throw new Error(data.error || 'Failed to create initial commit');
    } catch (error) {
      console.error('Error creating initial commit:', error);
      throw error;
    } finally {
      setIsCreatingInitialCommit(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, selectedProject]);

  const openFile = useCallback(
    async (filePath: string) => {
      if (!onFileOpen) {
        return;
      }

      if (!selectedProject) {
        onFileOpen(filePath);
        return;
      }

      try {
        const response = await fetchGit(
          `/api/git/file-with-diff?project=${encodeURIComponent(selectedProject.projectId)}&file=${encodeURIComponent(filePath)}`,
        );
        const data = await readJson<GitFileWithDiffResponse>(response);

        if (data.error) {
          console.error('Error fetching file with diff:', data.error);
          onFileOpen(filePath);
          return;
        }

        onFileOpen(filePath, {
          old_string: data.oldContent || '',
          new_string: data.currentContent || '',
        });
      } catch (error) {
        console.error('Error opening file:', error);
        onFileOpen(filePath);
      }
    },
    [onFileOpen, selectedProject],
  );

  const refreshAll = useCallback(() => {
    void fetchGitStatus();
    void fetchBranches();
    void fetchRemoteStatus();
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus]);

  useEffect(() => {
    const controller = new AbortController();

    // Reset repository-scoped state when project changes to avoid stale UI.
    setCurrentBranch('');
    setBranches([]);
    setLocalBranches([]);
    setRemoteBranches([]);
    setGitStatus(null);
    setRemoteStatus(null);
    setGitDiff({});
    setRecentCommits([]);
    setCommitDiffs({});
    setIsLoading(false);
    setOperationError(null);

    if (!selectedProject) {
      return () => {
        controller.abort();
      };
    }

    void fetchGitStatus(controller.signal);
    void fetchBranches();
    void fetchRemoteStatus();

    return () => {
      controller.abort();
    };
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus, selectedProject, worktreePath]);

  useEffect(() => {
    if (!selectedProject || activeView !== 'history') {
      return;
    }
    void fetchRecentCommits();
  }, [activeView, fetchRecentCommits, selectedProject, worktreePath]);

  return {
    gitStatus,
    gitDiff,
    isLoading,
    currentBranch,
    branches,
    localBranches,
    remoteBranches,
    recentCommits,
    commitDiffs,
    remoteStatus,
    isCreatingBranch,
    isFetching,
    isPulling,
    isPushing,
    isPublishing,
    isCreatingInitialCommit,
    operationError,
    clearOperationError,
    refreshAll,
    switchBranch,
    createBranch,
    deleteBranch,
    handleFetch,
    handlePull,
    handlePush,
    handlePublish,
    discardChanges,
    deleteUntrackedFile,
    stageFiles,
    unstageFiles,
    fetchCommitDiff,
    generateCommitMessage,
    commitChanges,
    createInitialCommit,
    openFile,
  };
}
