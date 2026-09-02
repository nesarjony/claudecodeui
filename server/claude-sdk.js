/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { buildClaudeUserContent, normalizeImageDescriptors } from './shared/image-attachments.js';
import { CLAUDE_FALLBACK_MODELS } from './modules/providers/list/claude/claude-models.provider.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { resolveClaudeCodeExecutablePath } from './shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

// ---------------------------------------------------------------------------
// Lifecycle tracing
//
// Exists to answer one question from the journal alone: when a turn's `claude`
// child dies, what killed it, and what was still running inside it. The child is
// spawned per turn (one `query()` per user message), so anything executing in it
// -- notably a background subagent -- cannot outlive the turn. These traces make
// that visible instead of inferred.
//
// Every line is single-line `key=value` under one prefix, so the whole story of
// a turn is `journalctl --user | grep '\[LIFECYCLE\]'`, and one turn is
// `... | grep 'turn=7'`. Set CLAUDE_LIFECYCLE_LOG=off to silence.
// ---------------------------------------------------------------------------

const LIFECYCLE_LOG_ENABLED = process.env.CLAUDE_LIFECYCLE_LOG !== 'off';
const CHILD_POLL_MS = parseInt(process.env.CLAUDE_LIFECYCLE_POLL_MS, 10) || 250;

let turnCounter = 0;

/** Pids this process signalled, so an exit can be attributed rather than guessed. */
const signalledPids = new Map();

/** Child pids currently being watched: pid -> { turn, firstSeenAt, argv }. */
const watchedChildren = new Map();

/** Turns that have not yet ended, keeping the child watcher alive. */
const openTurns = new Set();

let childWatcherTimer = null;

function trace(event, fields = {}) {
  if (!LIFECYCLE_LOG_ENABLED) {
    return;
  }
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) {
      continue;
    }
    const rendered = typeof value === 'string' && /[\s"]/.test(value)
      ? JSON.stringify(value)
      : String(value);
    parts.push(`${key}=${rendered}`);
  }
  console.log(`[LIFECYCLE] ${event}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

/** Direct children of this process, with a trimmed argv for identification. */
function listChildProcesses() {
  try {
    const output = execFileSync('pgrep', ['-P', String(process.pid)], {
      encoding: 'utf-8',
      timeout: 5000
    });
    return output.trim().split('\n').filter(Boolean).map(Number).filter(pid => !isNaN(pid));
  } catch {
    // pgrep exits non-zero when there are no children.
    return [];
  }
}

function readArgv(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean).join(' ').slice(0, 200);
  } catch {
    return null;
  }
}

/**
 * Polls the child process table and traces every appearance and disappearance.
 *
 * Attribution is the point: an exit is reported with whether *we* signalled the
 * pid, and how long after its turn ended it went away. A child that vanishes
 * with `signalled=none` right after `turn.end` is the SDK's own teardown -- the
 * path that takes background subagents down with it, and the one no change to
 * the abort handler can prevent.
 */
function pollChildProcesses() {
  const live = new Set(listChildProcesses());

  for (const pid of live) {
    if (!watchedChildren.has(pid)) {
      const argv = readArgv(pid);
      // Only trace the provider children; the server spawns short-lived helpers
      // (pgrep, git, ...) that would otherwise drown the log.
      const isProviderChild = argv && argv.includes('claude');
      watchedChildren.set(pid, { firstSeenAt: Date.now(), argv, traced: isProviderChild });
      if (isProviderChild) {
        trace('child.spawned', { pid, argv });
      }
    }
  }

  for (const [pid, info] of watchedChildren.entries()) {
    if (live.has(pid)) {
      continue;
    }
    watchedChildren.delete(pid);
    if (!info.traced) {
      continue;
    }
    const signal = signalledPids.get(pid);
    trace('child.exited', {
      pid,
      lifetimeMs: Date.now() - info.firstSeenAt,
      signalled: signal ? signal.signals.join('+') : 'none',
      signalledMsAgo: signal ? Date.now() - signal.lastAt : undefined,
      attribution: signal ? 'killed-by-server' : 'sdk-teardown-or-self-exit'
    });
    signalledPids.delete(pid);
  }
}

function startChildWatcher(turnId) {
  openTurns.add(turnId);
  if (childWatcherTimer || !LIFECYCLE_LOG_ENABLED) {
    return;
  }
  childWatcherTimer = setInterval(() => {
    try {
      pollChildProcesses();
    } catch (error) {
      trace('child.poll_failed', { error: error?.message });
    }
  }, CHILD_POLL_MS);
  // Never hold the event loop open on account of tracing.
  childWatcherTimer.unref?.();
}

/**
 * Stops watching once the last turn has ended, after a short grace period so the
 * exit that follows `turn.end` is still captured -- that exit is the interesting
 * one.
 */
function stopChildWatcher(turnId) {
  openTurns.delete(turnId);
  if (openTurns.size > 0 || !childWatcherTimer) {
    return;
  }
  const graceTimer = setTimeout(() => {
    if (openTurns.size === 0 && childWatcherTimer) {
      try {
        pollChildProcesses();
      } catch { /* tracing must never break a run */ }
      clearInterval(childWatcherTimer);
      childWatcherTimer = null;
    }
  }, 5000);
  graceTimer.unref?.();
}

/** Records a signal we sent, so `child.exited` can attribute the death to us. */
function noteSignalled(pid, signal) {
  const existing = signalledPids.get(pid);
  if (existing) {
    existing.signals.push(signal);
    existing.lastAt = Date.now();
  } else {
    signalledPids.set(pid, { signals: [signal], lastAt: Date.now() });
  }
}

const SUBAGENT_TOOL_NAMES = new Set(['Task', 'Agent']);

/**
 * Extracts the content blocks of an SDK message, whichever shape it arrived in.
 */
function readContentBlocks(message) {
  const content = message?.message?.content ?? message?.content;
  return Array.isArray(content) ? content : [];
}

/**
 * Per-turn tracker for subagent tool calls.
 *
 * A subagent is "open" from its `tool_use` until the matching `tool_result`.
 * Any subagent still open at `turn.end` was killed with the turn rather than
 * completing -- traced as `subagent.orphaned`, which is the signal to grep for.
 */
function createSubagentTracker(turnId) {
  const open = new Map();
  const finished = [];

  return {
    observe(message) {
      for (const block of readContentBlocks(message)) {
        if (block?.type === 'tool_use' && SUBAGENT_TOOL_NAMES.has(block.name)) {
          const background = block.input?.run_in_background === true;
          open.set(block.id, {
            name: block.name,
            background,
            startedAt: Date.now(),
            description: block.input?.description ?? null,
            subagentType: block.input?.subagent_type ?? null
          });
          trace('subagent.started', {
            turn: turnId,
            toolUseId: block.id,
            tool: block.name,
            background,
            subagentType: block.input?.subagent_type,
            description: block.input?.description
          });
        }

        if (block?.type === 'tool_result' && open.has(block.tool_use_id)) {
          const entry = open.get(block.tool_use_id);
          open.delete(block.tool_use_id);
          finished.push(entry);
          trace('subagent.finished', {
            turn: turnId,
            toolUseId: block.tool_use_id,
            tool: entry.name,
            background: entry.background,
            durationMs: Date.now() - entry.startedAt,
            isError: block.is_error === true
          });
        }
      }
    },

    /** Traces every subagent still open, i.e. every one that died with the turn. */
    reportOrphans(turnId_, reason) {
      for (const [toolUseId, entry] of open.entries()) {
        trace('subagent.orphaned', {
          turn: turnId_,
          toolUseId,
          tool: entry.name,
          background: entry.background,
          subagentType: entry.subagentType,
          description: entry.description,
          openForMs: Date.now() - entry.startedAt,
          turnEndReason: reason,
          why: entry.background
            ? 'background-subagent-cannot-outlive-its-turn'
            : 'turn-ended-before-tool_result'
        });
      }
      return open.size;
    },

    get openCount() {
      return open.size;
    },

    get finishedCount() {
      return finished.length;
    }
  };
}

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_FALLBACK_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options = {}) {
  const { sessionId, cwd, toolsSettings, permissionMode, effort } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_FALLBACK_MODELS.DEFAULT;

  const resolvedEffort = resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_FALLBACK_MODELS,
  );
  if (resolvedEffort) {
    sdkOptions.effort = resolvedEffort;
  }

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 */
function addSession(sessionId, queryInstance, writer = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    writer
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Extracts token usage from SDK messages.
 * Prefers per-step `message.usage` (Claude message payload), then falls back
 * to result-level usage/modelUsage for compatibility across SDK versions.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage || sdkMessage.usage;
  if (messageUsage && typeof messageUsage === 'object') {
    const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
    const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
    const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
    const cacheTokens = cacheCreationTokens + cacheReadTokens;
    const inputTokens = directInputTokens + cacheTokens;
    const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
    const totalUsed = inputTokens + outputTokens;
    const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

    return {
      used: totalUsed,
      total: contextWindow,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Builds the SDK `prompt` payload for one turn.
 *
 * Plain text turns pass the string through unchanged. Turns with image
 * attachments use the SDK's streaming-input mode: a single SDKUserMessage
 * whose content carries the prompt text plus one base64 `image` block per
 * attachment (read from the global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {string} cwd - Project working directory image paths resolve against
 * @returns {Promise<string|AsyncIterable>} SDK prompt payload
 */
async function buildPromptPayload(command, images, cwd) {
  if (normalizeImageDescriptors(images).length === 0) {
    return command;
  }

  const content = await buildClaudeUserContent(command, images, cwd);
  return (async function* () {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content
      },
      parent_tool_use_id: null,
      timestamp: new Date().toISOString()
    };
  })();
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const { sessionId, sessionSummary } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;

  const turnId = ++turnCounter;
  const turnStartedAt = Date.now();
  const subagents = createSubagentTracker(turnId);
  const messageCounts = {};
  const subagentMessageCounts = {};

  trace('turn.start', {
    turn: turnId,
    session: sessionId || 'NEW',
    appSession: options.appSessionId,
    resume: Boolean(options.resume),
    cwd: options.cwd
  });
  startChildWatcher(turnId);

  /** Single exit point for turn tracing, so no path can end a turn silently. */
  const endTurn = (reason, extra = {}) => {
    const orphaned = subagents.reportOrphans(turnId, reason);
    trace('turn.end', {
      turn: turnId,
      session: capturedSessionId || sessionId || 'NEW',
      reason,
      durationMs: Date.now() - turnStartedAt,
      messages: JSON.stringify(messageCounts),
      subagentsFinished: subagents.finishedCount,
      subagentsOrphaned: orphaned,
      subagentMessages: Object.keys(subagentMessageCounts).length
        ? JSON.stringify(subagentMessageCounts)
        : undefined,
      ...extra
    });
    // The child usually dies a beat after this line. The watcher stays up
    // briefly to catch that exit and attribute it.
    stopChildWatcher(turnId);
  };

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  try {
    // Per-session model overrides are keyed by the APP session id, but on resume
    // `sessionId` is the provider-native id. Prefer the app id so the model the
    // user picked is actually found (otherwise it silently falls back to the
    // client-sent model -- e.g. a migration kept running Opus after Haiku was set).
    const modelOverrideSessionId = options.appSessionId || sessionId;
    const resolvedModel = await providerModelsService.resolveResumeModel(
      'claude',
      modelOverrideSessionId,
      options.model,
    );
    let effortModels = CLAUDE_FALLBACK_MODELS;
    try {
      effortModels = (await providerModelsService.getProviderModels('claude')).models;
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      model: resolvedModel || options.model,
      effortModels,
    });

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Turns with image attachments switch to streaming input so the images
    // ride along as real content blocks. Built per query attempt because an
    // async generator cannot be replayed once consumed.
    const createPrompt = () => buildPromptPayload(command, options.images, options.cwd);

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: capturedSessionId || sessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${capturedSessionId || sessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${capturedSessionId || sessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          _sessionId: capturedSessionId || sessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // Query constructor reads this synchronously.
    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

    let queryInstance;
    try {
      queryInstance = query({
        prompt: await createPrompt(),
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      queryInstance = query({
        prompt: await createPrompt(),
        options: sdkOptions
      });
    }

    // Restore immediately — Query constructor already captured the value
    if (prevStreamTimeout !== undefined) {
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
    } else {
      delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    }

    // Track the query instance for abort capability. Register under the APP
    // session id immediately (known from the start) so Stop works even before
    // Claude announces its own session id -- a brand-new session previously had
    // a window where nothing was registered and Stop silently no-op'd.
    if (options.appSessionId) {
      addSession(options.appSessionId, queryInstance, ws);
    }
    if (capturedSessionId && capturedSessionId !== options.appSessionId) {
      addSession(capturedSessionId, queryInstance, ws);
    }

    trace('turn.query_created', {
      turn: turnId,
      session: capturedSessionId || sessionId || 'NEW',
      resume: Boolean(sdkOptions.resume),
      model: sdkOptions.model,
      permissionMode: sdkOptions.permissionMode
    });

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    trace('turn.loop_start', { turn: turnId, session: capturedSessionId || sessionId || 'NEW' });
    for await (const message of queryInstance) {
      messageCounts[message.type] = (messageCounts[message.type] || 0) + 1;
      subagents.observe(message);

      // Subagent output arrives tagged with the parent tool_use id; count it per
      // subagent rather than tracing every message, which would flood the log.
      if (message.parent_tool_use_id) {
        subagentMessageCounts[message.parent_tool_use_id] =
          (subagentMessageCounts[message.parent_tool_use_id] || 0) + 1;
      }

      if (message.type === 'system' || message.type === 'result') {
        trace('turn.message', {
          turn: turnId,
          type: message.type,
          subtype: message.subtype,
          isError: message.is_error,
          stopReason: message.stop_reason,
          numTurns: message.num_turns
        });
      }

      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(capturedSessionId, queryInstance, ws);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for new sessions
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        ws.send(msg);
      }

      // Extract and send token budget updates from assistant/result usage payloads
      const tokenBudgetData = extractTokenBudget(message);
      if (tokenBudgetData) {
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }
    }

    // Clean up session on completion
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const wasAborted = capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false;
    endTurn(wasAborted ? 'generator_end_after_abort' : 'generator_end', { wasAborted });
    if (!wasAborted) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
    }
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      stopReason: wasAborted ? 'aborted' : 'completed'
    });
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    const wasAborted = capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false;
    endTurn(wasAborted ? 'threw_after_abort' : 'threw', {
      wasAborted,
      error: error?.message
    });
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await providerAuthService.isProviderInstalled('claude');
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      error
    });
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
const INTERRUPT_TIMEOUT_MS = parseInt(process.env.CLAUDE_ABORT_INTERRUPT_TIMEOUT_MS, 10) || 5000;
const SIGKILL_GRACE_MS = parseInt(process.env.CLAUDE_ABORT_SIGKILL_GRACE_MS, 10) || 3000;

/** In-flight aborts, keyed by the id abort was called with. */
const inFlightAborts = new Map();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Finds the `claude` child processes belonging to one session, by matching the
 * session id in their argv (the SDK passes it as `--resume <id>`).
 *
 * Returns [] when the id cannot be matched, and callers must then kill nothing.
 * There is deliberately no "any claude child" fallback: the SDK's own binary
 * path contains "claude", so such a fallback matches *every* concurrent
 * session's child, and aborting one session would signal all the others. A
 * brand-new session is exactly the case that misses (no `--resume` in argv
 * until Claude announces an id), so the fallback did the most damage precisely
 * where it was least able to identify its target.
 *
 * @param {string} sessionId - Session identifier
 * @returns {Array<number>} Matching child pids, or [] if none could be matched
 */
function findSessionPids(sessionId) {
  // pgrep treats the pattern as a regex and a leading dash as a flag, so only
  // accept plain id-shaped input. Provider and app ids are UUIDs.
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)) {
    return [];
  }
  try {
    // execFileSync, not a shell string: the id reaches here from a client
    // message, and nothing about it should ever be parsed by a shell.
    const output = execFileSync('pgrep', ['-P', String(process.pid), '-f', sessionId], {
      encoding: 'utf-8',
      timeout: 5000
    });
    return output.trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n) && n !== process.pid);
  } catch {
    // pgrep exits non-zero when nothing matched.
    return [];
  }
}

function killPids(pids, signal) {
  for (const pid of pids) {
    try {
      // Read argv first: a killed process becomes a zombie with an empty
      // cmdline, and "which process did we just kill" is the whole point.
      const argv = readArgv(pid);
      process.kill(pid, signal);
      noteSignalled(pid, signal);
      console.log(`[ABORT] Sent ${signal} to PID ${pid}`);
      trace('child.signalled', { pid, signal, argv });
    } catch (err) {
      if (err.code !== 'ESRCH') console.error(`[ABORT] kill ${pid} failed:`, err.message);
      trace('child.signal_failed', { pid, signal, error: err.code || err.message });
    }
  }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Drops every activeSessions entry pointing at one query instance.
 *
 * A run registers itself twice — under the app session id and under the
 * provider-native id — so removing only the key abort was called with left the
 * other entry behind, keeping `isClaudeSDKSessionActive` true for a dead run.
 *
 * @param {Object} instance - SDK query instance
 * @param {string} sessionId - Id abort was called with (removed even if the
 *   instance is missing, so a malformed entry cannot become permanent)
 */
function removeSessionsForInstance(instance, sessionId) {
  if (instance) {
    for (const [key, value] of activeSessions.entries()) {
      if (value.instance === instance) {
        activeSessions.delete(key);
      }
    }
  }
  removeSession(sessionId);
}

async function abortClaudeSDKSession(sessionId) {
  // Stop is a button, and the abort below takes seconds. Without this, a second
  // press ran a second escalation ladder against the same instance concurrently
  // (the caller's `run.status === 'running'` guard cannot help: it only clears
  // once this promise resolves).
  trace('abort.requested', { session: sessionId });

  const existing = inFlightAborts.get(sessionId);
  if (existing) {
    console.log(`[ABORT] Abort already in flight for ${sessionId}, joining it`);
    trace('abort.joined_in_flight', { session: sessionId });
    return existing;
  }

  const pending = performAbort(sessionId).finally(() => inFlightAborts.delete(sessionId));
  inFlightAborts.set(sessionId, pending);
  return pending;
}

async function performAbort(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`[ABORT] Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);

    // Cooperative interrupt. The outcome has to be distinguishable: racing
    // against a bare `setTimeout` made a 5s hang resolve exactly like a fast
    // success, and the old code then decided whether to escalate by checking
    // whether the child was still alive — which it always is, because the child
    // outlives a successful interrupt by design while the turn winds down. So
    // every Stop escalated to SIGTERM/SIGKILL.
    const interruptStartedAt = Date.now();
    trace('abort.interrupt_start', { session: sessionId, timeoutMs: INTERRUPT_TIMEOUT_MS });

    let outcome = 'ok';
    let interruptError = null;
    try {
      outcome = await Promise.race([
        session.instance.interrupt().then(() => 'ok'),
        sleep(INTERRUPT_TIMEOUT_MS).then(() => 'timeout')
      ]);
    } catch (error) {
      outcome = 'error';
      interruptError = error?.message ?? String(error);
      console.warn(`[ABORT] interrupt() threw for ${sessionId}:`, error?.message);
    }

    trace('abort.interrupt_outcome', {
      session: sessionId,
      outcome,
      elapsedMs: Date.now() - interruptStartedAt,
      error: interruptError,
      escalating: outcome !== 'ok'
    });

    if (outcome === 'ok') {
      // The SDK acknowledged the interrupt and is unwinding the turn; it tears
      // the child down itself. Nothing to signal, and nothing to verify — the
      // child is expected to still be alive for a moment here.
      console.log(`[ABORT] Interrupt acknowledged for ${sessionId}`);
      trace('abort.no_escalation', {
        session: sessionId,
        note: 'child left alone; SDK tears it down as the turn unwinds'
      });
    } else {
      // The interrupt could not complete. The usual cause is a turn stopped
      // mid `tool_use`, which the SDK cannot always interrupt cleanly. Stop
      // still has to stop, so signal the child directly — but only now, with an
      // actual failure in hand.
      const pids = findSessionPids(sessionId);
      trace('abort.escalating', { session: sessionId, outcome, matchedPids: pids.join(',') || 'none' });
      if (pids.length === 0) {
        console.warn(
          `[ABORT] interrupt ${outcome} for ${sessionId} but no child pid could be matched; signalling nothing`
        );
      } else {
        console.warn(`[ABORT] interrupt ${outcome} for ${sessionId} (PIDs: ${pids}), sending SIGTERM`);
        killPids(pids, 'SIGTERM');

        await sleep(SIGKILL_GRACE_MS);
        const survivors = pids.filter(isProcessAlive);

        if (survivors.length > 0) {
          console.warn(`[ABORT] Session ${sessionId} survived SIGTERM (PIDs: ${survivors}), sending SIGKILL`);
          killPids(survivors, 'SIGKILL');
        }
      }
    }

    session.status = 'aborted';
    removeSessionsForInstance(session.instance, sessionId);
    return true;
  } catch (error) {
    console.error(`[ABORT] Error aborting session ${sessionId}:`, error);
    // Leave the session registered: the run is still going and will emit its
    // own terminal complete, which the un-marking below re-enables.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  __testing__
};

/** Seam for abort tests: registering a session otherwise requires a live run. */
const __testing__ = { addSession, getSession, findSessionPids, createSubagentTracker };
