// The sandbox attack battery, run through real sandboxed sessions on the Foreman test instance.
//   node --import tsx scripts/foreman-battery/attack-battery.mts [--only=default,acceptEdits,plan,forced,refusals]
// A scripted stand-in for the model (fake-model-api.mjs, answering as MiniMax-M3) asks the REAL Claude Code CLI, started by the REAL cloudcli
// session path with a policy from Foreman's builder (through the adapter in lib.mts), to carry out every step (battery-steps.mts): once in each
// permission mode a sandboxed session accepts, once with a policy that asks for nothing (what cloudcli forces must hold alone), and then the
// policies cloudcli must refuse (battery-refusals.mts). Each step is judged by the host just before and just after it (battery-session.mts).
// A full run writes docs/foreman-sandbox-battery-evidence.md and exits 1 unless everything is contained; `--only` runs the named parts and prints
// their evidence instead. The instance runs on the stand-ins while sessions run and is restarted in its normal configuration at the end.
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { writeEvidence } from './battery-evidence.mts';
import { DONOR, GIT, removeLab, resetLab, SCRATCH, sh, WT } from './battery-lab.mts';
import { runRefusals, type RefusalResult } from './battery-refusals.mts';
import { FAKE_MODEL_PORT, runScriptedSession, type SessionReport } from './battery-session.mts';
import { forcedSteps, LOOPBACK_CONTROL_PORT, modeSteps, type Step } from './battery-steps.mts';
import { adaptedPolicy, instance, instanceDbCount, normalInstanceSettings, REAL_HOME, ROOT, type SandboxPolicy, secret, sleep } from './lib.mts';

const MODES = ['default', 'acceptEdits', 'plan'];
const PARTS = [...MODES, 'forced', 'refusals'];
const INTAKE_PORT = 4298;
const only = process.argv.find((argument) => argument.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean) ?? null;
if (only?.some((part) => !PARTS.includes(part))) {
  console.error(`--only takes a comma-separated list of: ${PARTS.join(', ')}`);
  process.exit(2);
}
const wanted = (part: string) => !only || only.includes(part);
const runId = Date.now().toString(36);
const startedAt = new Date().toISOString();

function listen(port: number, handle: (request: http.IncomingMessage, body: string, response: http.ServerResponse) => void): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => handle(request, Buffer.concat(chunks).toString('utf8'), response));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// A loopback service of the host that the policy opens: the control that the way to the host's loopback works where a policy allows it.
const loopbackHits: Record<string, number> = {};
const control = await listen(LOOPBACK_CONTROL_PORT, (request, _body, response) => {
  const route = (request.url ?? '').split('?')[0] ?? '';
  loopbackHits[route] = (loopbackHits[route] ?? 0) + 1;
  response.writeHead(200, { 'content-type': 'text/plain' }).end('loopback control\n');
});
// A stand-in for Foreman's intake: it takes the battery's events, so none stay owed to the intake the instance normally pushes to. Another
// session's event is refused and stays owed for that intake.
const batterySessions = new Set<string>();
const intake = { received: 0, withIntakeToken: 0, owedAfterRun: 0 };
const intakeToken = `Bearer ${secret('intake-token')}`;
const intakeServer = await listen(INTAKE_PORT, (request, body, response) => {
  const event = JSON.parse(body || '{}') as { sessionId?: string };
  if (!event.sessionId || !batterySessions.has(event.sessionId)) {
    response.writeHead(503).end();
    return;
  }
  intake.received += 1;
  if (request.headers.authorization === intakeToken) intake.withIntakeToken += 1;
  response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
});

const { policy, changes } = await adaptedPolicy({ cwd: WT, scratch: SCRATCH, gitCommonDir: GIT, extraReadAllow: [DONOR], allowedDomains: [`127.0.0.1:${LOOPBACK_CONTROL_PORT}`] });
/** The adapted policy with everything cloudcli forces taken out: what the forced-switch session runs with. */
const askingForNothing = (base: SandboxPolicy): SandboxPolicy => ({
  ...structuredClone(base),
  network: { ...base.network, allowAllUnixSockets: false },
  filesystem: { ...base.filesystem, denyRead: [], denyWrite: [] },
  permissions: { allow: [...base.permissions.allow], deny: [] },
  disallowedTools: base.disallowedTools.filter((tool) => tool !== 'AskUserQuestion' && tool !== 'ExitPlanMode'),
});
// The live instance's bridge token too: an answer that holds any of them is a leak.
const liveToken = (() => {
  try {
    return [readFileSync(`${REAL_HOME}/.config/foreman/bridge-token`, 'utf8').trim()];
  } catch {
    return [];
  }
})();
const secrets = [secret('bridge-token'), secret('intake-token'), ...liveToken];
const instanceStatus = () => instance(['status']).split('\n')[0] ?? '';

const normal = normalInstanceSettings();
const modes: SessionReport[] = [];
let forced: SessionReport | null = null;
let refusals: RefusalResult[] = [];
let instanceDuringRun = 'not restarted (no session ran)';
const session = async (label: string, mode: string, sessionPolicy: SandboxPolicy, steps: Step[]): Promise<SessionReport> => {
  resetLab();
  const report = await runScriptedSession({ label, mode, runId, capMarker: `BATTERY-LOOPBACK-${runId}`, policy: sessionPolicy, projectPath: WT, steps, secrets, onSessionId: (id) => batterySessions.add(id) });
  const attacks = report.results.filter((result) => result.step.kind === 'attack');
  console.log(`${label}: ${report.refused ?? `${attacks.filter((result) => result.verdict).length}/${attacks.length} attacks contained, ${report.prompts.length} prompt(s)`}`);
  return report;
};
try {
  if ([...MODES, 'forced'].some(wanted)) {
    resetLab();
    instance(['restart'], { ...normal, CLAUDE_CAP_URL: `http://127.0.0.1:${FAKE_MODEL_PORT}`, FOREMAN_EVENTS_URL: `http://127.0.0.1:${INTAKE_PORT}/events` });
    instanceDuringRun = instanceStatus();
    instance(['register-project', WT]);
    for (const mode of MODES.filter(wanted)) {
      modes.push(await session(mode, mode, policy, modeSteps({ capMarker: `BATTERY-LOOPBACK-${runId}`, loopbackHits: (route) => loopbackHits[route] ?? 0 })));
    }
    if (wanted('forced')) forced = await session('forced', 'default', askingForNothing(policy), forcedSteps());
    // The battery's events go to the stand-in intake before the instance is put back on its own.
    const owed = () => (batterySessions.size === 0 ? 0 : instanceDbCount(`select count(*) from foreman_events where acked_at is null and session_id in (${[...batterySessions].map((id) => `'${id}'`).join(',')})`));
    for (let tries = 0; owed() > 0 && tries < 120; tries += 1) await sleep(1000);
    intake.owedAfterRun = owed();
  }
} finally {
  instance(['restart'], normal);
  for (const server of [control, intakeServer]) {
    server.close();
    server.closeAllConnections();
  }
}
if (wanted('refusals')) {
  resetLab();
  instance(['register-project', WT]);
  refusals = await runRefusals(policy);
}
removeLab();

const facts = {
  startedAt,
  host: `${sh('hostname')} (kernel ${sh('uname -r')}, ${sh('bwrap --version')})`,
  cli: `Claude Code ${sh(`${REAL_HOME}/.local/bin/claude --version`)}`,
  instanceDuringRun,
  instanceAfterRun: instanceStatus(),
  adapterChanges: changes,
  loopbackHits,
  intake,
};
const evidence = writeEvidence(facts, modes, forced, refusals);
if (only) {
  console.log(evidence.text);
} else {
  writeFileSync(path.join(ROOT, 'docs/foreman-sandbox-battery-evidence.md'), evidence.text);
}
console.log(`Verdict: ${evidence.contained ? 'CONTAINED' : 'NOT CONTAINED'}${evidence.problems.length > 0 ? `\n- ${evidence.problems.join('\n- ')}` : ''}`);
process.exitCode = evidence.contained ? 0 : 1;
