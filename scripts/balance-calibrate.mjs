/**
 * Independent, paired manual-fixture calibration; not a reproduction of mgmt-sim.
 * node scripts/balance-calibrate.mjs --hooks /absolute/pb_hooks --seeds 128 \
 *   --seed-start 1000 --output /tmp/balance-pilot.json
 * Defaults: repository hooks, 128 seeds starting at 1000. --output is required.
 * One seed is a block: both orientations use that exact seed for every variant.
 * All three profiles use the same grade/roles/health; only opponent attributes vary.
 * Coaching branches share a REAL balanced minute-70 prefix, including its score.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const PROFILES = ['peer', 'strongattack', 'strongdefence'];
export const VARIANTS = ['balanced', 'attack', 'defend', 'aggressive', 'passive'];
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const clone = value => JSON.parse(JSON.stringify(value));

export function options(argv, defaultSeeds) {
  const result = { hooks: path.join(ROOT, 'pocketbase/pb_hooks'), seeds: defaultSeeds, seedStart: 1000 };
  const names = { '--hooks': 'hooks', '--seeds': 'seeds', '--seed-start': 'seedStart', '--output': 'output' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') { result.help = true; continue; }
    assert(names[argv[i]] && argv[i + 1] && !argv[i + 1].startsWith('--'), `invalid option: ${argv[i]}`);
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

// Explicit controlled inputs, not copies of engine strength/selection formulas.
export function fixture(eng, { seed, profile = 'peer', subjectSide = 'home', variant = 'balanced', minuteMs = 8000 }) {
  assert(PROFILES.includes(profile) && VARIANTS.includes(variant));
  assert(['home', 'away'].includes(subjectSide));
  const roster = (id, attack, defence, intensity) => ['gk', 'def', 'mid', 'mid', 'att', 'att', 'def'].map((role, i) => ({
    id: `${id}-p${i}`, name: `${id} Player ${i}`, role, attack, defence,
    energy: 100, condition: 100, intensity, is_starter: i < 5,
  }));
  const subject = { id: 'subject', name: 'Subject', abbr: 'SUB', grade: 'B', ai: false,
    stance: ['attack', 'defend'].includes(variant) ? variant : 'balanced',
    players: roster('subject', 70, 70, ['aggressive', 'passive'].includes(variant) ? variant : 'balanced') };
  const opponent = { id: 'opponent', name: 'Opponent', abbr: 'OPP', grade: 'B', ai: false, stance: 'balanced',
    players: roster('opponent', profile === 'strongattack' ? 90 : 70, profile === 'strongdefence' ? 90 : 70, 'balanced') };
  return eng.createMatch({ fixtureId: `balance-${seed}-${profile}`, seed, kickoffAt: 0,
    timing: eng.buildTiming(minuteMs, 1), home: subjectSide === 'home' ? subject : opponent,
    away: subjectSide === 'away' ? subject : opponent });
}
export function prefix70(eng, st) {
  const events = [];
  let steps = 0;
  while (st.minute < 70 && st.phase !== 'finished') {
    assert(++steps < 200 && Number.isFinite(st.nextAt), 'minute-70 checkpoint unreachable');
    events.push(...eng.advanceTo(st, st.nextAt));
  }
  assert.equal(st.minute, 70);
  assert.equal(st.phase, 'second_half');
  return events;
}
function metrics(st, events, side) {
  const other = side === 'home' ? 'away' : 'home', index = side === 'home' ? 0 : 1;
  const goals90 = who => events.filter(e => ['goal', 'penalty_goal'].includes(e.t) && e.min <= 90 && e.side === who).length;
  const players = st.teams[side].players.filter(p => p.is_starter);
  return {
    advance: st.winner === side ? 1 : 0,
    goalDiff90: goals90(side) - goals90(other), goalsFor90: goals90(side), goalsAgainst90: goals90(other),
    shotsFor: st.stats[side].sh, shotsAgainst: st.stats[other].sh,
    possession: st.possMin[index] / Math.max(1, st.possMin[0] + st.possMin[1]),
    yellows: st.stats[side].yc, reds: st.stats[side].rc,
    finalEnergy: players.reduce((n, p) => n + p.energy, 0) / players.length,
    finalCondition: players.reduce((n, p) => n + p.condition, 0) / players.length,
  };
}
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
function interval(values) {
  const estimate = mean(values);
  if (values.length < 2) return { estimate, ci95: null, seedBlocks: values.length };
  const variance = values.reduce((sum, x) => sum + (x - estimate) ** 2, 0) / (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return { estimate, ci95: [estimate - margin, estimate + margin], seedBlocks: values.length };
}
function wilson(wins, n) {
  const z2 = 1.96 ** 2, p = wins / n, mid = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = 1.96 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n);
  return [mid - half, mid + half];
}
function summarize(rows) {
  const paired = new Map(rows.filter(r => r.variant === 'balanced').map(r => [`${r.family}/${r.profile}/${r.seed}/${r.subjectSide}`, r]));
  const groups = new Map();
  for (const row of rows) for (const side of ['both', row.subjectSide]) {
    for (const stratum of row.family === 'coaching' ? ['all', row.stratum] : ['all']) {
      const key = `${row.family}/${row.profile}/${row.variant}/${side}/${stratum}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
  }
  return [...groups].map(([group, list]) => {
    const values = Object.fromEntries(Object.keys(list[0].metrics).map(key => [key, mean(list.map(r => r.metrics[key]))]));
    const deltas = {};
    for (const key of Object.keys(values)) {
      const blocks = new Map();
      for (const row of list) {
        const control = paired.get(`${row.family}/${row.profile}/${row.seed}/${row.subjectSide}`);
        assert(control, 'missing exact paired balanced control');
        if (!blocks.has(row.seed)) blocks.set(row.seed, []);
        blocks.get(row.seed).push(row.metrics[key] - control.metrics[key]);
      }
      deltas[key] = interval([...blocks.values()].map(mean));
    }
    return { group, matches: list.length, distinctSeeds: new Set(list.map(r => r.seed)).size,
      means: values, advanceWilson95Descriptive: wilson(list.reduce((n, r) => n + r.metrics.advance, 0), list.length),
      pairedDeltaVsBalanced: deltas,
      appliedCoachingEvents: list.reduce((n, r) => n + (r.coaching?.events.length || 0), 0) };
  });
}
export function calibrate(eng, config) {
  const rows = [];
  function record(st, events, detail) {
    assert.equal(st.phase, 'finished');
    rows.push({ ...detail, metrics: metrics(st, events, detail.subjectSide), eventCount: events.length,
      rngCount: st.rc, eventHash: hash(events), finalStateHash: hash(st) });
  }
  for (let seed = config.seedStart; seed < config.seedStart + config.seeds; seed++) {
    for (const profile of PROFILES) for (const subjectSide of ['home', 'away']) {
      for (const variant of VARIANTS) {
        const st = fixture(eng, { seed, profile, subjectSide, variant });
        record(st, eng.advanceTo(st, Infinity), { family: 'kickoff', seed, profile, subjectSide, variant, stratum: 'all' });
      }
      const checkpoint = fixture(eng, { seed, profile, subjectSide });
      const prefix = prefix70(eng, checkpoint), index = subjectSide === 'home' ? 0 : 1;
      const score = checkpoint.score[index] - checkpoint.score[1 - index];
      const stratum = score > 0 ? 'leading' : score < 0 ? 'trailing' : 'tied';
      for (const variant of ['balanced', 'attack', 'defend']) {
        const st = clone(checkpoint);
        eng.queueStance(st, subjectSide, variant);
        const tail = eng.advanceTo(st, Infinity);
        const applied = tail.filter(e => e.t === 'coaching' && e.by === 'manager' && e.side === subjectSide);
        assert.equal(st.teams[subjectSide].stance, variant);
        assert.equal(st.pending[subjectSide], undefined);
        assert.equal(applied.length, variant === 'balanced' ? 0 : 1);
        if (applied.length) assert.equal(applied[0].min, 71);
        record(st, [...prefix, ...tail], { family: 'coaching', seed, profile, subjectSide, variant, stratum,
          checkpoint: { minute: 70, score: checkpoint.score, hash: hash(checkpoint) },
          coaching: { queuedAtMinute: 70, pendingConsumed: true, events: applied.map(({ seq, at, min, stance }) => ({ seq, at, min, stance })) } });
      }
    }
  }
  return { schema: 'footfive-balance-calibration-v1', source: source(config.hooks),
    inputs: { seeds: config.seeds, seedStart: config.seedStart, seedEnd: config.seedStart + config.seeds - 1,
      profiles: { subject: { attack: 70, defence: 70 }, peer: { attack: 70, defence: 70 },
        strongattack: { attack: 90, defence: 70 }, strongdefence: { attack: 70, defence: 90 } },
      grade: 'B', roles: ['gk', 'def', 'mid', 'mid', 'att', 'att', 'def'], starters: [0, 1, 2, 3, 4],
      initialEnergy: 100, initialCondition: 100, minuteMs: 8000, ai: false, orientations: ['home', 'away'], variants: VARIANTS },
    notes: [
      'Independent controlled profiles; historical /workspace/mgmt-sim inputs unavailable. Not an exact replication of quoted issue statistics.',
      'Advance is knockout qualification, including extra time/shootouts. Goals/difference are regulation only; other metrics include extra time.',
      'Coaching strata use natural balanced minute-70 scores, never inserted goals. All branches reuse the exact same prefix.',
      'Paired deltas use identical seed/profile/orientation controls, averaged within seed blocks; 95% normal-approximation intervals use independent seed blocks, not orientations as independent samples.',
      'Wilson intervals are descriptive pooled-match intervals; mirrored orientations share seeds, so use seed-block paired intervals for comparisons.',
      'Balanced coaching is an intentional no-op with zero coaching events; attack/defend must emit exactly one manager event at minute71.',
    ], matches: rows.length, summaries: summarize(rows), rows };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const config = options(process.argv.slice(2), 128);
    if (config.help) console.log('node scripts/balance-calibrate.mjs [--hooks ABS_PB_HOOKS] [--seeds 128] [--seed-start 1000] --output PATH');
    else {
      assert(config.output, '--output is required');
      const report = calibrate(loadEngine(config.hooks), config);
      fs.writeFileSync(config.output, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ output: path.resolve(config.output), matches: report.matches, seeds: config.seeds,
        seedStart: config.seedStart, reportHash: hash(report), source: report.source }));
    }
  } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
