import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyToolUse, compileGuard } from '@/modules/foreman/foreman-guard.service.js';

/**
 * The red-team guard cases (Foreman `evals/adversarial/guard-cases.json`, the same table Foreman's own classifier is held
 * to). Every attack must be held (a Bash call, a path argument, a write), every control must stay allowed. The patterns are
 * the ones Foreman hands over (`guard-patterns.json`, exported from Foreman's config), so this tests the guard as a session
 * really runs it. Set RT_RECORD=<file> to write the verdicts as JSON instead of asserting (how the baseline was taken).
 */

type Case = {
  id: string;
  class: number;
  tool: string;
  input: Record<string, unknown>;
  expect: 'hold' | 'allow';
  setup?: Array<{ file?: string; content?: string; mode?: number; link?: string; target?: string }>;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(path.join(here, 'fixtures/guard-adversarial-cases.json'), 'utf8')) as Case[];
const patterns = JSON.parse(readFileSync(path.join(here, 'fixtures/guard-adversarial-patterns.json'), 'utf8')) as { riskyPatterns: string[]; secretPatterns: string[] };

const FAKE = 'FAKE_SECRET_do_not_use_0123456789';
// Under the user's cache directory, not /tmp: the guard lets a command write to scratch space, and the cases for "a write
// outside the repo" need somewhere that is not. realpath: the guard resolves links, and the cache may itself sit behind one.
const cache = path.join(process.env.FOREMAN_REDTEAM_CACHE ?? path.join(homedir(), '.cache'), 'foreman-redteam');
mkdirSync(cache, { recursive: true });
const root = realpathSync(mkdtempSync(path.join(cache, 'guard-')));
const repo = path.join(root, 'repo');
const home = path.join(root, 'home');
const outside = path.join(root, 'outside');
for (const d of [repo, path.join(repo, 'src'), path.join(repo, '.git/hooks'), home, path.join(home, '.ssh'), path.join(home, '.aws'), path.join(home, '.config/claude-api'), path.join(home, '.config/gh'), path.join(home, '.claude'), path.join(home, '.foreman'), path.join(home, '.kube'), path.join(home, '.docker'), outside]) {
  mkdirSync(d, { recursive: true });
}
const plant = (p: string, text = FAKE) => writeFileSync(p, `${text}\n`);
plant(path.join(repo, '.env'), `API_KEY=${FAKE}`);
plant(path.join(repo, '.env.example'), 'API_KEY=changeme');
plant(path.join(repo, '.env.production'), `API_KEY=${FAKE}`);
plant(path.join(repo, 'src/index.ts'), 'export {}');
plant(path.join(repo, 'notes.txt'), 'plain notes');
plant(path.join(repo, 'terraform.tfstate'), `{"secret":"${FAKE}"}`);
plant(path.join(repo, 'gcp-service-account-key.json'), `{"private_key":"${FAKE}"}`);
for (const f of ['.ssh/id_rsa', '.ssh/id_ed25519', '.aws/credentials', '.config/claude-api/key', '.kube/config', '.docker/config.json', '.git-credentials']) {
  plant(path.join(home, f));
}
plant(path.join(home, '.config/gh/hosts.yml'), `oauth_token: ${FAKE}`);
plant(path.join(home, '.claude/settings.json'), '{}');
plant(path.join(home, '.foreman/config.json'), '{}');
plant(path.join(home, '.bash_history'), 'ls');
plant(path.join(home, '.bashrc'), '# rc');

const fill = (text: string) => text.replaceAll('{{REPO}}', repo).replaceAll('{{HOME}}', home).replaceAll('{{OUTSIDE}}', outside);
const guard = compileGuard(
  { enabled: true, riskyPatterns: patterns.riskyPatterns, secretPatterns: patterns.secretPatterns, writeOutsideRepo: true, repoRoot: repo },
  repo,
  { home },
);

type Row = { id: string; class: number; expect: string; actual: 'hold' | 'allow'; detail: string };
const rows: Row[] = [];

test('red-team guard cases', () => {
  for (const c of cases) {
    const made: string[] = [];
    for (const s of c.setup ?? []) {
      if (s.file !== undefined) {
        const p = path.join(repo, s.file);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, fill(s.content ?? ''));
        if (s.mode) chmodSync(p, s.mode);
        made.push(p);
      } else if (s.link && s.target) {
        const p = path.join(repo, s.link);
        rmSync(p, { force: true, recursive: true });
        symlinkSync(fill(s.target), p);
        made.push(p);
      }
    }
    const verdict = classifyToolUse({ toolName: c.tool, input: JSON.parse(fill(JSON.stringify(c.input))) }, guard);
    rows.push({ id: c.id, class: c.class, expect: c.expect, actual: verdict.risky ? 'hold' : 'allow', detail: verdict.risky ? `${verdict.category}: ${verdict.matched}`.slice(0, 80) : '' });
    for (const p of made) {
      rmSync(p, { force: true, recursive: true });
    }
  }
  if (process.env.RT_RECORD) {
    writeFileSync(process.env.RT_RECORD, JSON.stringify(rows));
    return;
  }
  const wrong = rows.filter((r) => r.expect !== r.actual);
  assert.deepEqual(wrong.map((r) => `${r.id}: wanted ${r.expect}, got ${r.actual}`), []);
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});
