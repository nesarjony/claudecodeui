import { useCallback, useEffect, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { useGitPanelController } from '../hooks/useGitPanelController';
import { useRevertLocalCommit } from '../hooks/useRevertLocalCommit';
import type {
  ConfirmationRequest,
  GitPanelProps,
  GitPanelView,
  GitWorktree,
  GitWorktreesResponse,
} from '../types/types';
import { getChangedFileCount } from '../utils/gitPanelUtils';
import ChangesView from '../view/changes/ChangesView';
import HistoryView from '../view/history/HistoryView';
import BranchesView from '../view/branches/BranchesView';
import GitPanelHeader from '../view/GitPanelHeader';
import GitRepositoryErrorState from '../view/GitRepositoryErrorState';
import GitViewTabs from '../view/GitViewTabs';
import ConfirmActionModal from '../view/modals/ConfirmActionModal';

export default function GitPanel({ selectedProject, selectedSession, isMobile = false, onFileOpen }: GitPanelProps) {
  const [activeView, setActiveView] = useState<GitPanelView>('changes');
  const [wrapText, setWrapText] = useState(true);
  const [hasExpandedFiles, setHasExpandedFiles] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmationRequest | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [selectedWorktreePath, setSelectedWorktreePath] = useState<string | null>(null);
  const [isLoadingWorktrees, setIsLoadingWorktrees] = useState(false);
  const worktreeSelectionKey = selectedProject
    ? `cloudcli:git-worktree:${selectedSession?.id ?? selectedProject.projectId}`
    : null;

  useEffect(() => {
    let isCurrent = true;
    setWorktrees([]);
    setSelectedWorktreePath(null);

    if (!selectedProject) return () => { isCurrent = false; };

    setIsLoadingWorktrees(true);
    authenticatedFetch(`/api/git/worktrees?project=${encodeURIComponent(selectedProject.projectId)}`)
      .then((response) => response.json() as Promise<GitWorktreesResponse>)
      .then((data) => {
        if (!isCurrent || !data.worktrees) return;

        const storedPath = worktreeSelectionKey ? localStorage.getItem(worktreeSelectionKey) : null;
        const sessionPath = [selectedSession?.worktree, selectedSession?.cwd, selectedSession?.directory]
          .find((value): value is string => typeof value === 'string');
        const selectedWorktree = data.worktrees.find((worktree) => worktree.path === storedPath)
          ?? data.worktrees.find((worktree) => worktree.path === sessionPath)
          ?? data.worktrees.find((worktree) => worktree.isProject)
          ?? data.worktrees[0];

        setWorktrees(data.worktrees);
        setSelectedWorktreePath(selectedWorktree?.path ?? null);
      })
      .catch((error) => {
        if (isCurrent) console.error('Failed to load Git worktrees:', error);
      })
      .finally(() => {
        if (isCurrent) setIsLoadingWorktrees(false);
      });

    return () => { isCurrent = false; };
  }, [selectedProject, selectedSession, worktreeSelectionKey]);

  const selectWorktree = useCallback((worktreePath: string) => {
    setSelectedWorktreePath(worktreePath);
    if (worktreeSelectionKey) localStorage.setItem(worktreeSelectionKey, worktreePath);
  }, [worktreeSelectionKey]);

  const {
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
  } = useGitPanelController({
    selectedProject,
    worktreePath: selectedWorktreePath,
    activeView,
    onFileOpen,
  });

  const { isRevertingLocalCommit, revertLatestLocalCommit } = useRevertLocalCommit({
    // `projectId` (DB primary key) is forwarded to the revert API which uses it
    // as the `project` body param.
    projectId: selectedProject?.projectId ?? null,
    worktreePath: selectedWorktreePath,
    onSuccess: refreshAll,
  });

  const executeConfirmedAction = useCallback(async () => {
    if (!confirmAction) return;
    const actionToExecute = confirmAction;
    setConfirmAction(null);
    try {
      await actionToExecute.onConfirm();
    } catch (error) {
      console.error('Error executing confirmation action:', error);
    }
  }, [confirmAction]);

  const changeCount = getChangedFileCount(gitStatus);

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>Select a project to view source control</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <GitPanelHeader
        isMobile={isMobile}
        currentBranch={currentBranch}
        worktrees={worktrees}
        selectedWorktreePath={selectedWorktreePath}
        isLoadingWorktrees={isLoadingWorktrees}
        branches={branches}
        remoteStatus={remoteStatus}
        isLoading={isLoading}
        isCreatingBranch={isCreatingBranch}
        isFetching={isFetching}
        isPulling={isPulling}
        isPushing={isPushing}
        isPublishing={isPublishing}
        isRevertingLocalCommit={isRevertingLocalCommit}
        operationError={operationError}
        onRefresh={refreshAll}
        onWorktreeChange={selectWorktree}
        onRevertLocalCommit={revertLatestLocalCommit}
        onSwitchBranch={switchBranch}
        onCreateBranch={createBranch}
        onFetch={handleFetch}
        onPull={handlePull}
        onPush={handlePush}
        onPublish={handlePublish}
        onClearError={clearOperationError}
        onRequestConfirmation={setConfirmAction}
      />

      {gitStatus?.error ? (
        <GitRepositoryErrorState error={gitStatus.error} details={gitStatus.details} />
      ) : (
        <>
          <GitViewTabs
            activeView={activeView}
            isHidden={hasExpandedFiles}
            changeCount={changeCount}
            onChange={setActiveView}
          />

          {activeView === 'changes' && (
            <ChangesView
              key={selectedWorktreePath ?? selectedProject.fullPath}
              isMobile={isMobile}
              projectPath={selectedWorktreePath ?? selectedProject.fullPath}
              gitStatus={gitStatus}
              gitDiff={gitDiff}
              isLoading={isLoading}
              wrapText={wrapText}
              isCreatingInitialCommit={isCreatingInitialCommit}
              onWrapTextChange={setWrapText}
              onCreateInitialCommit={createInitialCommit}
              onOpenFile={openFile}
              onDiscardFile={discardChanges}
              onDeleteFile={deleteUntrackedFile}
              onStageFiles={stageFiles}
              onUnstageFiles={unstageFiles}
              onCommitChanges={commitChanges}
              onGenerateCommitMessage={generateCommitMessage}
              onRequestConfirmation={setConfirmAction}
              onExpandedFilesChange={setHasExpandedFiles}
            />
          )}

          {activeView === 'history' && (
            <HistoryView
              isMobile={isMobile}
              isLoading={isLoading}
              recentCommits={recentCommits}
              commitDiffs={commitDiffs}
              wrapText={wrapText}
              onFetchCommitDiff={fetchCommitDiff}
            />
          )}

          {activeView === 'branches' && (
            <BranchesView
              isMobile={isMobile}
              isLoading={isLoading}
              currentBranch={currentBranch}
              localBranches={localBranches}
              remoteBranches={remoteBranches}
              remoteStatus={remoteStatus}
              isCreatingBranch={isCreatingBranch}
              onSwitchBranch={switchBranch}
              onCreateBranch={createBranch}
              onDeleteBranch={deleteBranch}
              onRequestConfirmation={setConfirmAction}
            />
          )}
        </>
      )}

      <ConfirmActionModal
        action={confirmAction}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          void executeConfirmedAction();
        }}
      />
    </div>
  );
}
