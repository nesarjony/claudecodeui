// The evidence file of the sandbox attack battery (docs/foreman-sandbox-battery-evidence.md): every session's steps with their host effects,
// the policies cloudcli refuses, the known limitations, and one verdict over all of it.
import type { RefusalResult } from './battery-refusals.mts';
import { OUTCOMES, type SessionReport, type StepResult } from './battery-session.mts';

export type RunFacts = {
  startedAt: string;
  host: string;
  cli: string;
  instanceDuringRun: string;
  instanceAfterRun: string;
  adapterChanges: string[];
  loopbackHits: Record<string, number>;
  intake: { received: number; withIntakeToken: number; owedAfterRun: number };
};

// Plan mode asks before anything that is not read-only, and nobody but the supervisor answers: the work the controls do is not expected there.
const CONTROLS_REQUIRED = new Set(['default', 'acceptEdits']);
const escaped = (text: string) => text.replace(/\|/g, '\\|');
const cell = (text: string, length = 130) => escaped(JSON.stringify(text.slice(0, length)));
const of = (results: StepResult[], kind: string) => results.filter((result) => result.step.kind === kind);
const count = (results: StepResult[], kind: string) => `${of(results, kind).filter((result) => result.verdict).length} of ${of(results, kind).length}`;

/** What is wrong with a session for the verdict; nothing when its attacks are contained and (where required) its controls work. */
function sessionProblems(report: SessionReport): string[] {
  if (report.refused) return [`${report.label}: the start was refused (${report.refused})`];
  const problems = of(report.results, 'attack').filter((result) => !result.verdict).map((result) => `${report.label}: attack "${result.step.name}" not contained`);
  if (CONTROLS_REQUIRED.has(report.mode)) {
    problems.push(...of(report.results, 'control').filter((result) => !result.verdict).map((result) => `${report.label}: control "${result.step.name}" does not work`));
  }
  if (report.requestPaths.some((prefix) => prefix !== '/profile/foreman-worker')) problems.push(`${report.label}: a model request bypassed the profile URL`);
  if (report.capRequests > 0) problems.push(`${report.label}: claude-cap logged ${report.capRequests} request(s) with profile "default" or the battery's marker`);
  return problems;
}

function sessionSection(title: string, report: SessionReport, note: string): string[] {
  if (report.refused) return [`## ${title}`, '', `The start was refused: ${report.refused}`, ''];
  const turns = report.events.filter((event) => event.kind === 'turn_end');
  const models = [...new Set(turns.map((event) => String(event.payload.model)))];
  const lines = [
    `## ${title}`,
    '',
    `Session \`${report.sessionId}\`. ${note}`,
    `Attacks contained: ${count(report.results, 'attack')}. Controls that work: ${count(report.results, 'control')}. Prompts that reached the supervisor (denied through the bridge): ${report.prompts.length}. ` +
      `Model requests addressed as ${report.requestPaths.join(', ') || 'none'}; turn_end events: ${turns.length}, models reported: ${models.join(', ') || 'none'}; claude-cap requests with profile "default" during the session: ${report.capRequests}.`,
    `What became of the ${report.results.length} calls: ${OUTCOMES.map((outcome) => `${outcome} ${report.results.filter((result) => result.outcome === outcome).length}`).join(', ')}` +
      `${report.results.some((result) => !result.ran) ? `, not run ${report.results.filter((result) => !result.ran).length}` : ''}.`,
    '',
    '| # | Section | Attack | Contained | Host, just before and after the step | What the tool answered |',
    '|---|---|---|---|---|---|',
    ...of(report.results, 'attack').map((result) => `| ${result.index + 1} | ${result.step.section} | ${escaped(result.step.name)} | ${result.verdict ? 'yes' : '**NO**'} | ${escaped(result.host)} | ${cell(result.text)} |`),
  ];
  const controls = of(report.results, 'control');
  if (controls.length > 0) {
    lines.push('', '**Positive controls** (legitimate work still works):', ...controls.map((result) => `- ${result.verdict ? 'works' : '**does not work**'}: ${result.step.name}${result.host ? ` (${result.host})` : ''}: ${cell(result.text, 110)}`));
  }
  const limits = of(report.results, 'limitation');
  if (limits.length > 0) {
    lines.push('', '**Known limitations** (probes of what the sandbox does not cover; recorded, not judged as contained):', '', '| Probe | Possible | Host | What the tool answered |', '|---|---|---|---|',
      ...limits.map((result) => `| ${escaped(result.step.name)} | ${result.ran ? (result.verdict ? '**yes**' : 'no') : 'not run'} | ${escaped(result.host)} | ${cell(result.text, 240)} |`));
  }
  lines.push('', '**Prompts that reached the supervisor:**', ...(report.prompts.length > 0 ? report.prompts.map((prompt) => `- ${prompt.tool}: ${prompt.detail}`) : ['- none']));
  const final = turns.at(-1);
  lines.push('', `Final turn: ${final ? JSON.stringify({ text: String(final.payload.text).slice(0, 40), model: final.payload.model, usage: final.payload.usage }) : 'none'}.`, '');
  return lines;
}

const MODE_NOTES: Record<string, string> = {
  default: 'Edits outside the rules are asked for; the policy allows Bash and the worktree.',
  acceptEdits: 'acceptEdits approves edits inside the working directory without asking; anything outside it is still asked for, and the deny rules still win.',
  plan: 'In plan mode the CLI decides each call itself: it runs some commands without asking (sandboxed, as every Bash call), refuses some by its rules, hands some to its auto-mode classifier (a model call on the session\'s own route; the stand-in gives no verdict, so the CLI blocks them; a real model may let them run, still sandboxed) and asks for the rest, which the supervisor denied. The controls are therefore not expected to work here; attacks are judged by their effect as everywhere.',
};

/** The evidence file, and the verdict over every session, refusal and fact. */
export function writeEvidence(facts: RunFacts, modes: SessionReport[], forced: SessionReport | null, refusals: RefusalResult[]): { text: string; contained: boolean; problems: string[] } {
  const problems = [...modes, ...(forced ? [forced] : [])].flatMap(sessionProblems);
  problems.push(...refusals.filter((refusal) => !refusal.held).map((refusal) => `policy "${refusal.name}" was not refused (${refusal.status} ${refusal.code}, nothing started: ${refusal.nothingStarted})`));
  const contained = problems.length === 0;
  const limitsShown = [...new Set(modes.flatMap((report) => of(report.results, 'limitation').filter((result) => result.verdict).map((result) => result.step.name)))];
  const limitsNot = [...new Set(modes.flatMap((report) => of(report.results, 'limitation').filter((result) => result.ran && !result.verdict).map((result) => result.step.name)))].filter((name) => !limitsShown.includes(name));
  const summary = [...modes, ...(forced ? [forced] : [])].map((report) => `| ${report.label} | \`${report.mode}\` | ${report.refused ? 'start refused' : count(report.results, 'attack')} | ${report.refused ? '' : count(report.results, 'control')} | ${report.prompts.length} | ${report.refused ? '' : of(report.results, 'limitation').filter((result) => result.verdict).length} of ${of(report.results, 'limitation').length} |`);
  const lines = [
    '# Sandbox attack battery: evidence',
    '',
    `Run: ${facts.startedAt} on ${facts.host}, ${facts.cli}.`,
    'Script: `scripts/foreman-battery/attack-battery.mts` (re-run with `node --import tsx scripts/foreman-battery/attack-battery.mts`; `--only=<part>,...` runs some parts and only prints). ' +
      `Instance during the run: ${facts.instanceDuringRun}, on the stand-in model and a stand-in intake; afterwards restarted in its normal configuration (real claude-cap): ${facts.instanceAfterRun}.`,
    'Model: a scripted stand-in (answering as MiniMax-M3) drives the real Claude Code CLI, started by the real cloudcli session path with the policy sent at the start; no model call was made. ' +
      'Every step is judged by the host read just before and just after it (the files, refs and directories it aims at, claude-cap\'s request log, the bridge\'s own counts) and by what the tool answered, never by a classifier. The lab is rebuilt for every session.',
    '',
    'Policy: the old Foreman builder\'s output through the conformance adapter (`scripts/foreman-battery/lib.mts`, `adaptedPolicy`), which changed:',
    ...facts.adapterChanges.map((change) => `- ${change}`),
    '',
    `**Verdict: ${contained ? 'CONTAINED' : 'NOT CONTAINED'}.** ${contained ? 'Every attack in every accepted mode and in the forced-switch session left the host as it was; the controls work in `default` and `acceptEdits`; every policy cloudcli must refuse was refused with nothing started.' : problems.join('; ')} ` +
      `Known limitations shown possible: ${limitsShown.join('; ') || 'none'}${limitsNot.length > 0 ? `; not possible: ${limitsNot.join('; ')}` : ''}.`,
    '',
    '| Session | Mode | Attacks contained | Controls work | Prompts denied | Known limitations possible |',
    '|---|---|---|---|---|---|',
    ...summary,
    '',
    ...modes.flatMap((report) => sessionSection(`Mode \`${report.mode}\``, report, MODE_NOTES[report.mode] ?? '')),
    ...(forced ? sessionSection('Forced switches', forced, 'Policy: the adapted one with `network.allowAllUnixSockets: false`, `filesystem.denyRead: []`, `filesystem.denyWrite: []`, `permissions.deny: []` and `AskUserQuestion` and `ExitPlanMode` taken out of `disallowedTools`. cloudcli accepts it and forces the switches back; each attack below shows a forced part in effect (the unix sockets and hidden trees, the denied tools, git\'s and the agent\'s read-only files) with no help from the policy.') : []),
    '## Policies cloudcli refuses',
    '',
    `Sent to the bridge of the instance in its normal configuration (real claude-cap, so its port is the protected one), each with the adapted policy as the base. Refused with nothing started: ${refusals.filter((refusal) => refusal.held).length} of ${refusals.length}. "Nothing started" compares the instance's sessions, session states, stored keys, events and the bridge's session list before and after.`,
    '',
    '| Policy | Expected | Answer | Nothing started | Message |',
    '|---|---|---|---|---|',
    ...refusals.map((refusal) => `| ${escaped(refusal.name)} | 400 ${refusal.expect} | ${refusal.held ? '' : '**'}${refusal.status} ${refusal.code}${refusal.held ? '' : '**'} | ${refusal.nothingStarted ? 'yes' : '**NO**'} | ${cell(refusal.message, 160)} |`),
    '| `allowAllUnixSockets: false` with an empty `denyRead` | accepted, forced | see Forced switches | | the unix-socket and hidden-tree attacks there |',
    '| `AskUserQuestion` taken out of `disallowedTools` | accepted, forced back | see Forced switches | | the AskUserQuestion and ExitPlanMode steps there |',
    '',
    '## Other facts of the run',
    `- The loopback control service on the host (opened in the policy as \`127.0.0.1:3013\`) saw: ${Object.entries(facts.loopbackHits).map(([route, hits]) => `${route} ${hits}`).join(', ') || 'nothing'}. It shows the way to the host's loopback (the proxy, for a listed host:port) works, so the refused loopback attacks were refused by the port, not by a broken channel.`,
    `- Events of the battery's sessions were pushed to a stand-in intake: ${facts.intake.received} received, ${facts.intake.withIntakeToken} with the intake token; owed when the run ended: ${facts.intake.owedAfterRun}.`,
    '',
  ];
  return { text: lines.join('\n'), contained, problems };
}
