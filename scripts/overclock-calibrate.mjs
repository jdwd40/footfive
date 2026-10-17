/**
 * Paired overclock calibration. Not a copy of the chance model and not a mgmt-sim replay.
 * node scripts/overclock-calibrate.mjs --hooks /absolute/pb_hooks --seeds 128 \
 *   --seed-start 1000 --output /tmp/overclock-pilot.json
 * Defaults: repository hooks, 128 seeds starting at 1000. --output is required.
 * Every seed runs all 3 profiles, 3 subject-health scenarios, both orientations and off/on (36).
 * On pays overclockEnergyCost from the five starters before createMatch and sets oc:true.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { options, hash, source, loadEngine, fixture, PROFILES } from './balance-fixtures.mjs';

const HEALTH = [
  { id: 'e100c100', energy: 100, condition: 100 },
  { id: 'e60c100', energy: 60, condition: 100 },
  { id: 'e100c60', energy: 100, condition: 60 },
];
const SIDES = ['home', 'away'];
const VARIANTS = ['off', 'on'];
const OUTCOMES_PER_SEED = PROFILES.length * HEALTH.length * SIDES.length * VARIANTS.length;

const require = createRequire(import.meta.url);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const otherSide = side => (side === 'home' ? 'away' : 'home');

function readBalance(hooks) {
  const balance = require(path.join(hooks, 'lib/balance.js')).BALANCE;
  assert(Number.isFinite(balance.overclockBonus) && balance.overclockBonus > 1, 'overclockBonus missing');
  assert(balance.overclockEnergyCost === 8, 'overclockEnergyCost must stay 8');
  return balance;
}

/** Copy the controlled roster fixture() already built. Health and the debit are applied after. */
function rosterFrom(team) {
  return {
    id: team.id,
    name: team.name,
    abbr: team.abbr,
    grade: team.grade,
    ai: false,
    stance: 'balanced',
    oc: false,
    players: team.players.map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      attack: p.attack,
      defence: p.defence,
      energy: p.energy,
      condition: p.condition,
      intensity: p.intensity || 'balanced',
      is_starter: !!p.is_starter,
    })),
  };
}

function withHealth(team, health) {
  return {
    ...team,
    players: team.players.map(p => ({ ...p, energy: health.energy, condition: health.condition })),
  };
}

/** Debit the five actual starters once. Bench rows keep the health they were given. */
function payStarters(players, cost) {
  let starters = 0;
  const next = players.map(p => {
    if (!p.is_starter) return { ...p };
    starters += 1;
    return { ...p, energy: clamp(p.energy - cost, 0, 100) };
  });
  assert.equal(starters, 5, 'overclock must charge exactly five starters');
  return next;
}

function fixtureId(seed, profile, health, subjectSide) {
  return `overclock-${seed}-${profile}-${health}-${subjectSide}`;
}

function metrics(st, events, side) {
  const other = otherSide(side);
  const goals90 = who => events.filter(e => ['goal', 'penalty_goal'].includes(e.t) && e.min <= 90 && e.side === who).length;
  const players = st.teams[side].players.filter(p => p.is_starter);
  return {
    advance: st.winner === side ? 1 : 0,
    goalDiff90: goals90(side) - goals90(other),
    goalsFor90: goals90(side),
    goalsAgainst90: goals90(other),
    shotsFor: st.stats[side].sh,
    shotsAgainst: st.stats[other].sh,
    finalEnergy: players.reduce((n, p) => n + p.energy, 0) / players.length,
    finalCondition: players.reduce((n, p) => n + p.condition, 0) / players.length,
  };
}

function assertFrozen(st, subjectSide, health, variant, cost) {
  const side = st.teams[subjectSide];
  const other = st.teams[otherSide(subjectSide)];
  assert.equal(side.oc, variant === 'on');
  assert.equal(other.oc, false);
  let starters = 0;
  for (const player of side.players) {
    const expected = player.is_starter && variant === 'on' ? clamp(health.energy - cost, 0, 100) : health.energy;
    if (player.is_starter) starters += 1;
    assert.equal(player.energy, expected);
    assert.equal(player.e0, expected);
    assert.equal(player.condition, health.condition);
  }
  assert.equal(starters, 5);
  for (const player of other.players) {
    assert.equal(player.energy, 100);
    assert.equal(player.e0, 100);
    assert.equal(player.condition, 100);
  }
  assert.equal(st.rc, 0, 'createMatch must not draw RNG');
}

const mean = values => values.reduce((a, b) => a + b, 0) / values.length;

function interval(values) {
  const estimate = mean(values);
  if (values.length < 2) return { estimate, ci95: null, seedBlocks: values.length };
  const variance = values.reduce((sum, x) => sum + (x - estimate) ** 2, 0) / (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return { estimate, ci95: [estimate - margin, estimate + margin], seedBlocks: values.length };
}

function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.profile}/${row.health}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups].map(([group, list]) => {
    const off = list.filter(r => r.variant === 'off');
    const on = list.filter(r => r.variant === 'on');
    const keys = Object.keys(off[0].metrics);
    const means = variantRows => Object.fromEntries(keys.map(key => [key, mean(variantRows.map(r => r.metrics[key]))]));
    const pairedOnMinusOff = {};
    for (const key of keys) {
      const blocks = new Map();
      for (const row of on) {
        const control = off.find(r => r.seed === row.seed && r.subjectSide === row.subjectSide && r.profile === row.profile && r.health === row.health);
        assert(control, 'missing exact off control');
        if (!blocks.has(row.seed)) blocks.set(row.seed, []);
        blocks.get(row.seed).push(row.metrics[key] - control.metrics[key]);
      }
      for (const deltas of blocks.values()) assert.equal(deltas.length, SIDES.length, 'each seed block must average both orientations');
      pairedOnMinusOff[key] = interval([...blocks.values()].map(mean));
    }
    return {
      group,
      seeds: new Set(list.map(r => r.seed)).size,
      orientations: SIDES,
      matchesPerVariant: off.length,
      outcomes: list.length,
      means: { off: means(off), on: means(on) },
      pairedOnMinusOff,
    };
  });
}

export function calibrate(eng, config, balance) {
  assert.equal(OUTCOMES_PER_SEED, 36);
  const rows = [];
  for (let seed = config.seedStart; seed < config.seedStart + config.seeds; seed++) {
    for (const profile of PROFILES) {
      for (const health of HEALTH) {
        for (const subjectSide of SIDES) {
          const probe = fixture(eng, { seed, profile, subjectSide, variant: 'balanced', minuteMs: 8000 });
          const baseHome = rosterFrom(probe.teams.home);
          const baseAway = rosterFrom(probe.teams.away);
          const id = fixtureId(seed, profile, health.id, subjectSide);
          for (const variant of VARIANTS) {
            const home = baseHome.id === 'subject' ? withHealth(baseHome, health) : baseHome;
            const away = baseAway.id === 'subject' ? withHealth(baseAway, health) : baseAway;
            const subject = subjectSide === 'home' ? home : away;
            if (variant === 'on') subject.players = payStarters(subject.players, balance.overclockEnergyCost);
            subject.oc = variant === 'on';
            const st = eng.createMatch({
              fixtureId: id,
              seed,
              kickoffAt: 0,
              timing: eng.buildTiming(8000, 1),
              home,
              away,
            });
            assert.equal(st.fx, id);
            assertFrozen(st, subjectSide, health, variant, balance.overclockEnergyCost);
            const events = eng.advanceTo(st, Infinity);
            assert.equal(st.phase, 'finished');
            rows.push({
              seed,
              profile,
              health: health.id,
              subjectSide,
              variant,
              fixtureId: id,
              metrics: metrics(st, events, subjectSide),
              eventHash: hash(events),
              finalStateHash: hash(st),
              rngCount: st.rc,
            });
          }
        }
      }
    }
  }
  assert.equal(rows.length, config.seeds * OUTCOMES_PER_SEED);
  const manifest = {
    ...source(config.hooks),
    overclockBonus: balance.overclockBonus,
    overclockEnergyCost: balance.overclockEnergyCost,
  };
  return {
    schema: 'footfive-overclock-calibration-v1',
    source: manifest,
    inputs: {
      seeds: config.seeds,
      seedStart: config.seedStart,
      seedEnd: config.seedStart + config.seeds - 1,
      outcomesPerSeed: OUTCOMES_PER_SEED,
      profiles: {
        subject: { attack: 70, defence: 70 },
        peer: { attack: 70, defence: 70 },
        strongattack: { attack: 90, defence: 70 },
        strongdefence: { attack: 70, defence: 90 },
      },
      health: HEALTH,
      opponentHealth: { energy: 100, condition: 100 },
      grade: 'B',
      roles: ['gk', 'def', 'mid', 'mid', 'att', 'att', 'def'],
      starters: [0, 1, 2, 3, 4],
      stance: 'balanced',
      ai: false,
      orientations: SIDES,
      variants: VARIANTS,
      minuteMs: 8000,
      teamFlag: 'oc',
      costAppliedBeforeCreateMatch: true,
    },
    notes: [
      'Controlled grade-B manual fixtures. Not a replication of /workspace/mgmt-sim and not a universal balance proof.',
      'Advance includes extra time and penalties. Regulation goals are minute <= 90. Shots and final starter energy/condition include extra time.',
      'On debits overclockEnergyCost from exactly five starters before createMatch, clamped to 0..100, and passes oc:true. Off pays nothing and leaves oc false. Bench energy is not debited.',
      'Fixture ids depend on seed, profile, health and side only, so off/on and source versions share them.',
      'Paired on-minus-off intervals average the two orientations inside each seed, then take a normal 95% interval across seeds. Orientations are not independent samples. No multiple-comparison correction.',
      'Pooled means use one row per match. Seed-block intervals are the comparison.',
    ],
    matches: rows.length,
    summaries: summarize(rows),
    rows,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const config = options(process.argv.slice(2), 128);
    if (config.help) {
      console.log('node scripts/overclock-calibrate.mjs [--hooks ABS_PB_HOOKS] [--seeds 128] [--seed-start 1000] --output PATH');
    } else {
      assert(config.output, '--output is required');
      const balance = readBalance(config.hooks);
      const report = calibrate(loadEngine(config.hooks), config, balance);
      fs.writeFileSync(config.output, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({
        output: path.resolve(config.output),
        matches: report.matches,
        seeds: config.seeds,
        seedStart: config.seedStart,
        outcomesPerSeed: OUTCOMES_PER_SEED,
        reportHash: hash(report),
        source: report.source,
      }));
    }
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
}
