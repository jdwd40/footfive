/**
 * Pure controlled fixtures for the overclock calibration.
 * Manual Balanced grade-B teams only: subject 70/70 against the three profiles.
 * No coaching experiment and no chance model.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const PROFILES = ['peer', 'strongattack', 'strongdefence'];
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function options(argv, defaultSeeds) {
  const result = { hooks: path.join(ROOT, 'pocketbase/pb_hooks'), seeds: defaultSeeds, seedStart: 1000 };
  const names = { '--hooks': 'hooks', '--seeds': 'seeds', '--seed-start': 'seedStart', '--output': 'output' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') { result.help = true; continue; }
    assert(Object.prototype.hasOwnProperty.call(names, argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--'), `invalid option: ${argv[i]}`);
    const key = names[argv[i++]];
    result[key] = ['seeds', 'seedStart'].includes(key) ? Number(argv[i]) : argv[i];
  }
  assert(path.isAbsolute(result.hooks), '--hooks must be absolute');
  assert(Number.isSafeInteger(result.seeds) && result.seeds > 0 && result.seeds <= 10000, '--seeds must be 1..10000');
  assert(Number.isSafeInteger(result.seedStart) && result.seedStart > 0 && result.seedStart + result.seeds - 1 <= 0xffffffff, 'invalid uint32 seed range');
  return result;
}

export function loadEngine(hooks) {
  const require = createRequire(import.meta.url);
  return require(path.join(hooks, 'lib/matchEngine.js'));
}

export function source(hooks) {
  return { hooks, sha256: Object.fromEntries(['matchEngine.js', 'balance.js', 'effectiveStats.js'].map(name =>
    [name, createHash('sha256').update(fs.readFileSync(path.join(hooks, 'lib', name))).digest('hex')])) };
}

/** Seven-player manual squads, five starters, both sides Balanced. */
export function fixture(eng, { seed, profile = 'peer', subjectSide = 'home', variant = 'balanced', minuteMs = 8000 }) {
  assert(PROFILES.includes(profile));
  assert(variant === 'balanced');
  assert(['home', 'away'].includes(subjectSide));
  const roster = (id, attack, defence) => ['gk', 'def', 'mid', 'mid', 'att', 'att', 'def'].map((role, i) => ({
    id: `${id}-p${i}`, name: `${id} Player ${i}`, role, attack, defence,
    energy: 100, condition: 100, intensity: 'balanced', is_starter: i < 5,
  }));
  const subject = { id: 'subject', name: 'Subject', abbr: 'SUB', grade: 'B', ai: false, stance: 'balanced',
    players: roster('subject', 70, 70) };
  const opponent = { id: 'opponent', name: 'Opponent', abbr: 'OPP', grade: 'B', ai: false, stance: 'balanced',
    players: roster('opponent', profile === 'strongattack' ? 90 : 70, profile === 'strongdefence' ? 90 : 70) };
  return eng.createMatch({ fixtureId: `balance-${seed}-${profile}`, seed, kickoffAt: 0,
    timing: eng.buildTiming(minuteMs, 1), home: subjectSide === 'home' ? subject : opponent,
    away: subjectSide === 'away' ? subject : opponent });
}
