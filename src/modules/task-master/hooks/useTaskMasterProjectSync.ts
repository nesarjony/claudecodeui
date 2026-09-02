import { useEffect } from 'react';

import type { Project } from '@/shared/types';
import { useTaskMaster } from '@/modules/task-master/context/TaskMasterContext';

/** Keeps TaskMaster's active project aligned with the workspace selection. */
export function useTaskMasterProjectSync(selectedProject: Project | null, enabled = true) {
  const { currentProject, setCurrentProject } = useTaskMaster();

  useEffect(() => {
    // The TaskMaster context keys its internal maps by the same DB projectId.
    if (enabled && selectedProject && selectedProject.projectId !== currentProject?.projectId) {
      setCurrentProject(selectedProject);
    }
  }, [enabled, selectedProject, currentProject?.projectId, setCurrentProject]);
}
