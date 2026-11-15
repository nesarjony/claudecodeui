// One scripted session of the sandbox attack battery: the stand-in model, the session start through the bridge, the prompts that reach the
// supervisor (denied), and the host read just before and just after every step, so that each step is judged by its own effect.
import { LAB, snapshot } from './battery-lab.mts';
import type { ProbeName, Step } from './battery-steps.mts';
import { startFakeApi } from './fake-model-api.mjs';
import { bridge, capRequestsSince, eventsOf, instanceDbCount, newKey, REAL_HOME, type BridgeEvent, type SandboxPolicy, waitFor } from './lib.mts';

export const FAKE_MODEL_PORT = 3012;
/** The reason the supervisor gives when it denies a prompt; the tool result of a call denied that way is exactly this text. */
const DENY_REASON = 'denied by the battery supervisor';

/** What became of a tool call: it ran (in the sandbox, for Bash), or it never ran because the supervisor, the CLI's rules or its classifier stopped it. */
export type Outcome = 'ran' | 'refused by the CLI' | 'blocked by the classifier' | 'denied by the supervisor';
export const OUTCOMES: Outcome[] = ['ran', 'refused by the CLI', 'blocked by the classifier', 'denied by the supervisor'];

function outcomeOf(text: string, isError: boolean): Outcome {
  if (!isError) return 'ran';
  if (text === DENY_REASON) return 'denied by the supervisor';
  // Plan mode hands some calls to the CLI's auto-mode classifier, a model call; the stand-in gives no verdict, so the CLI blocks them.
  if (/^Auto mode could not evaluate this action/.test(text)) return 'blocked by the classifier';
  if (/^Permission to use \S+ .*has been denied|denied by your permission settings|No such tool available/.test(text)) return 'refused by the CLI';
  return 'ran';
}

type HostState = { paths: Map<string, string>; probes: Partial<Record<ProbeName, string>>; controlHolds: boolean | null };
export type StepResult = { index: number; step: Step; ran: boolean; outcome: Outcome | null; text: string; verdict: boolean; host: string };
export type SessionReport = {
  label: string;
  mode: string;
  sessionId: string | null;
  /** The start's error when the bridge did not start the session. */
  refused: string | null;
  results: StepResult[];
  prompts: Array<{ tool: string; detail: string }>;
  events: BridgeEvent[];
  requestPaths: string[];
  foreignRequests: number;
  /** claude-cap requests with profile "default" or the battery's marker, logged while the session ran. */
  capRequests: number;
};
type SessionInput = { label: string; mode: string; runId: string; capMarker: string; policy: SandboxPolicy; projectPath: string; steps: Step[]; secrets: string[]; onSessionId: (sessionId: string) => void };

const shortPath = (target: string) => target.replace(`${LAB}/`, '').replace(`${REAL_HOME}/`, '~/');
const TURN_OVER = ['turn_end', 'error', 'session_end', 'quota'];

export async function runScriptedSession(input: SessionInput): Promise<SessionReport> {
  const marker = `battery ${input.runId} ${input.label}`;
  const startedAt = Date.now();
  let resolveSessionId: (sessionId: string | null) => void = () => undefined;
  const sessionIdKnown = new Promise<string | null>((resolve) => { resolveSessionId = resolve; });
  const watched = [...new Set(input.steps.flatMap((step) => step.paths ?? []))];
  const capCount = async () => (await capRequestsSince(startedAt, (request) => request.profile === 'default' || (request.prompt ?? '').includes(input.capMarker))).length;
  const probe = async (name: ProbeName): Promise<string> => {
    if (name === 'cap') return `${await capCount()} request(s)`;
    // The bridge's own counts: every session, the events of sessions other than this one, and the keys of calls the battery did not make.
    const own = await sessionIdKnown;
    return [
      `sessions ${instanceDbCount('select count(*) from sessions')}`,
      `other events ${instanceDbCount(`select count(*) from foreman_events where session_id != '${own}'`)}`,
      `other keys ${instanceDbCount("select count(*) from foreman_idempotency where key not like 'battery:%'")}`,
    ].join(', ');
  };
  const states: HostState[] = [];
  const capture = async (index: number): Promise<void> => {
    const needed = new Set<ProbeName>([...(input.steps[index - 1]?.probes ?? []), ...(input.steps[index]?.probes ?? [])]);
    const probes: Partial<Record<ProbeName, string>> = {};
    for (const name of needed) probes[name] = await probe(name);
    const previous = input.steps[index - 1];
    states[index] = { paths: snapshot(watched), probes, controlHolds: previous?.kind === 'control' && previous.host ? previous.host() : null };
  };

  const fake = await startFakeApi(input.steps.map((step) => ({ tool: step.tool ?? 'Bash', input: step.input })), { model: 'MiniMax-M3', port: FAKE_MODEL_PORT, marker, onStep: capture });
  const report: SessionReport = { label: input.label, mode: input.mode, sessionId: null, refused: null, results: [], prompts: [], events: [], requestPaths: [], foreignRequests: 0, capRequests: 0 };
  try {
    const started = await bridge('POST', '/sessions', {
      projectPath: input.projectPath,
      prompt: `run the scripted steps (${marker})`,
      model: 'claude-sonnet-5-5',
      billing: 'cap',
      permissionMode: input.mode,
      taskId: `battery-${input.label}`,
      sandbox: input.policy,
      idempotencyKey: newKey(`start-${input.label}`),
    });
    if (started.status !== 201) {
      resolveSessionId(null);
      report.refused = `${started.status} ${JSON.stringify(started.body.error ?? started.body).slice(0, 400)}`;
      return report;
    }
    const sessionId = started.body.data.sessionId as string;
    report.sessionId = sessionId;
    input.onSessionId(sessionId);
    resolveSessionId(sessionId);
    const answered = new Set<string>();
    report.events = await waitFor('the scripted session to end its turn', async () => {
      const all = await eventsOf(sessionId);
      for (const ask of all.filter((event) => event.kind === 'permission_request' && !answered.has(event.id))) {
        answered.add(ask.id);
        report.prompts.push({ tool: String(ask.payload.tool), detail: String(ask.payload.detail).slice(0, 110) });
        await bridge('POST', `/sessions/${sessionId}/permission`, { requestId: ask.payload.requestId, decision: 'deny', reason: DENY_REASON, idempotencyKey: newKey('deny') });
      }
      return all.some((event) => TURN_OVER.includes(event.kind)) ? all : null;
    }, 15 * 60_000, 500);
    // A CLI process held open after the turn would join the next session's lab; nothing runs any more, so a 409 is the usual answer.
    await bridge('POST', `/sessions/${sessionId}/interrupt`, { idempotencyKey: newKey('interrupt') });
    report.capRequests = await capCount();
    report.requestPaths = fake.requestPaths();
    report.foreignRequests = fake.stats().foreignRequests;
    const answers = fake.results() as Array<{ i: number; isError: boolean; text: string }>;
    report.results = input.steps.map((step, index) => judge(step, index, answers.find((answer) => answer.i === index), states[index], states[index + 1], input.secrets));
    return report;
  } finally {
    await fake.close();
  }
}

/** The verdict of one step from what the tool answered and from the host just before and just after it. */
function judge(step: Step, index: number, answer: { isError: boolean; text: string } | undefined, before: HostState | undefined, after: HostState | undefined, secrets: string[]): StepResult {
  const raw = (answer?.text ?? '').replace(/<system-reminder>[\s\S]*$/, '').trim();
  const leaks = secrets.some((secret) => raw.includes(secret));
  const text = secrets.reduce((masked, secret) => masked.split(secret).join('[TOKEN]'), raw);
  if (!answer || !before || !after) {
    return { index, step, ran: false, outcome: null, text, verdict: false, host: 'not run' };
  }
  const outcome = outcomeOf(raw, answer.isError);
  const changed = [
    ...(step.paths ?? []).filter((target) => before.paths.get(target) !== after.paths.get(target)).map((target) => `${shortPath(target)}: ${before.paths.get(target)} -> ${after.paths.get(target)}`),
    ...(step.probes ?? []).filter((name) => before.probes[name] !== after.probes[name]).map((name) => `${name}: ${before.probes[name]} -> ${after.probes[name]}`),
  ];
  const answerHolds = step.answer ? step.answer(text, answer.isError) : true;
  if (step.kind === 'control') {
    const host = after.controlHolds === null ? '' : after.controlHolds ? 'the host shows it' : 'the host does NOT show it';
    return { index, step, ran: true, outcome, text, verdict: answerHolds && after.controlHolds !== false, host };
  }
  if (step.kind === 'limitation') {
    return { index, step, ran: true, outcome, text, verdict: changed.length > 0, host: changed.length > 0 ? `changed: ${changed.join('; ')}` : 'unchanged' };
  }
  const read = [...(step.paths ?? []).map(shortPath), ...(step.probes ?? []).map((name) => `${name} (${after.probes[name]})`)];
  const host = changed.length > 0 ? `CHANGED: ${changed.join('; ')}` : read.length > 0 ? `unchanged: ${read.join(', ')}` : 'judged by the answer';
  // A check of what a command printed applies to a command that ran; a call that never ran printed nothing.
  const verdict = (outcome !== 'ran' || answerHolds) && !leaks && changed.length === 0;
  return { index, step, ran: true, outcome, text: leaks ? `${text} (a token was in the answer)` : text, verdict, host };
}
