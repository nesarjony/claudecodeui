import express from 'express';

import { listSessionAgents } from '@/modules/agents/agents.service.js';
import { stopClaudeAgentTask } from '@/modules/providers/index.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

const router = express.Router();

router.get('/:sessionId', asyncHandler(async (req, res) => {
  res.json(await listSessionAgents(String(req.params.sessionId), req.query.all === '1'));
}));

router.post('/:sessionId/tasks/:taskId/stop', asyncHandler(async (req, res) => {
  const stopped = await stopClaudeAgentTask(String(req.params.sessionId), String(req.params.taskId));
  if (!stopped) throw new AppError('That agent is not running in a live session.', { statusCode: 409 });
  res.json({ stopped: true });
}));

export default router;
