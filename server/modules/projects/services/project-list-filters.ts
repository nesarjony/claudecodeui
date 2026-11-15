/** Whether a project is over: its work is done and its place is the archive, whatever its row says. */
export type ClosedProjectCheck = (projectPath: string) => boolean;

/** Makes the check for one list: a module that knows which projects are over registers one of these, and it is called each time a list is built so it is never stale. */
export type ClosedProjectCheckFactory = () => ClosedProjectCheck;

const factories: ClosedProjectCheckFactory[] = [];

/**
 * Lets a module that owns a kind of project (Foreman's batch worktrees) say which of them are over. The sidebar lists the others and the archive
 * lists these: the `isArchived` flag of the row cannot decide it, since any session upsert in the project's path sets it back to active. Registering
 * the same factory twice counts once.
 */
export function registerClosedProjectCheck(factory: ClosedProjectCheckFactory): void {
  if (!factories.includes(factory)) factories.push(factory);
}

/** The checks of every registered module, as one: a project is over when any of them says so. */
export function closedProjectCheck(): ClosedProjectCheck {
  const checks = factories.map((factory) => factory());
  return (projectPath) => checks.some((check) => check(projectPath));
}
