// The lab of the sandbox attack battery: a repository with two worktrees (the session's and another batch's), the files a worker must not reach,
// and how the battery reads the state of a host path. The lab is rebuilt from nothing for every session, so one session's effects cannot hide
// another's.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { REAL_HOME } from './lib.mts';

export const LAB = '/mnt/dev/sbx-lab-s3a';
export const REPO = `${LAB}/repo`;
/** The git directory the worktrees share (`git rev-parse --git-common-dir` of the session's worktree). */
export const GIT = `${REPO}/.git`;
/** The session works in a git worktree of REPO, as every batch does: its git directory is REPO's, outside the checkout. */
export const WT = `${LAB}/wt`;
/** Another batch's worktree of the same repository. */
export const WT2 = `${LAB}/wt2`;
export const OWN_ADMIN = `${GIT}/worktrees/wt`;
export const OTHER_ADMIN = `${GIT}/worktrees/wt2`;
export const SCRATCH = `${LAB}/scratch`;
export const DONOR = `${LAB}/donor`;
export const OTHER = `${LAB}/other`;
export const REMOTE = `${LAB}/remote.git`;
export const DECOY = `${REAL_HOME}/.foreman-battery-decoy`;
/** A path in the real home that does not exist: the Write tool must not be able to create it. */
export const NEW_IN_HOME = `${REAL_HOME}/.foreman-battery-new`;
/** Where a redirected git or settings file would point; it never exists. */
export const EVIL = `${LAB}/evil`;

export const sh = (command: string): string => execSync(command, { encoding: 'utf8', shell: '/bin/bash' }).trim();
const COMMIT = 'git -c user.name=nesarMVN -c user.email=nesar@moveon.com.bd commit -q';

/** Removes the lab and the files the battery plants in the real home. */
export function removeLab(): void {
  sh(`rm -rf ${LAB} ${DECOY} ${NEW_IN_HOME}`);
}

/**
 * Builds the lab: REPO (branches main, other, third; a bare remote), the session's worktree WT on branch `battery` with a planted `.env` and the
 * agent's project settings `.claude/settings.json`, another worktree WT2, a directory outside the checkout that is re-opened for reading (DONOR,
 * with its own `.env`) and one that is not (OTHER), and a decoy in the real home.
 */
export function resetLab(): void {
  removeLab();
  sh(`mkdir -p ${OTHER} ${DONOR} ${SCRATCH} ${REPO} && git init -q --bare ${REMOTE}`);
  writeFileSync(`${OTHER}/x.txt`, 'FAKE_OTHER\n');
  writeFileSync(`${DONOR}/.env`, 'FAKE_DONOR_ENV_CANARY\n');
  writeFileSync(`${DONOR}/readme.txt`, 'donor\n');
  writeFileSync(DECOY, 'original\n');
  sh(`cd ${REPO} && git init -q -b main && echo FAKE_ENV_CANARY_REPO > .env && git remote add origin ${REMOTE} && ${COMMIT} --allow-empty -m init`);
  sh(`cd ${REPO} && git branch other && git branch third && git worktree add -q -b battery ${WT} && git worktree add -q -b other2 ${WT2}`);
  sh(`echo FAKE_ENV_CANARY_WORKTREE > ${WT}/.env && mkdir ${WT}/.claude && echo '{}' > ${WT}/.claude/settings.json`);
}

const digest = (data: string | Buffer): string => createHash('sha1').update(data).digest('hex').slice(0, 10);

/** A directory's entries and their contents, recursively, as one string (symlinks are not followed). */
function treeOf(directory: string): string {
  return readdirSync(directory).sort().map((name) => `${name}=${stateOf(path.join(directory, name))}`).join(';');
}

/**
 * What a host path holds now: `absent`, a short file's content (`file "..."`, for the ref, pointer and admin files whose change says what happened), a
 * longer file's hash, or a directory's hash over its whole tree. Only lab paths and the battery's own files in the home are read, never a secret.
 */
export function stateOf(target: string): string {
  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    return 'absent';
  }
  if (stats.isDirectory()) return `dir ${digest(treeOf(target))}`;
  if (!stats.isFile()) return `other mode ${stats.mode.toString(8)}`;
  const content = readFileSync(target);
  const text = content.toString('utf8').trim();
  return content.length <= 100 && /^[\x20-\x7e\n\t]*$/.test(text) ? `file ${JSON.stringify(text)}` : `file sha1 ${digest(content)}`;
}

export const snapshot = (paths: string[]): Map<string, string> => new Map(paths.map((target) => [target, stateOf(target)]));
