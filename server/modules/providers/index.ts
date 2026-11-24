export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerRuntimeService } from './services/provider-runtime.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// sessionsService: used by the websocket module's chat gateway to resolve an
// edited message's resume point, which only the providers module can read.
export { sessionsService } from './services/sessions.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';

// getLiveAgentTasks/getLiveBackgroundTasks/stopClaudeAgentTask: used by the agents module to
// report and stop live subagents and background shells.
export { getLiveAgentTasks, getLiveBackgroundTasks, stopClaudeAgentTask } from './list/claude/claude-runtime.provider.js';

// setClaudeRuntimeAdditionsProvider: adds PreCompact/SessionStart hooks and the autocompact
// threshold to the runs of a supervised session.
export { setClaudeRuntimeAdditionsProvider } from './list/claude/claude-runtime.provider.js';

// setClaudeRuntimeSandboxProvider: runs a session in its sandbox.
export { setClaudeRuntimeSandboxProvider } from './list/claude/claude-runtime-sandbox.js';

// resolveCapConfig: read by a sandbox policy, which may never open claude-cap's port to a worker.
export { resolveCapConfig } from './list/claude/claude-cap-billing.js';

// subscribeClaudeRuntimeEvents/setClaudeSessionModel/getClaudeSessionContextUsage/hasClaudeApiKey/
// isClaudeSDKSessionActive/getActiveClaudeSDKSessions: observe and steer live Claude sessions.
export {
  getActiveClaudeSDKSessions,
  getClaudeSessionContextUsage,
  hasClaudeApiKey,
  isClaudeSDKSessionActive,
  setClaudeSessionModel,
  subscribeClaudeRuntimeEvents,
} from './list/claude/claude-runtime.provider.js';
