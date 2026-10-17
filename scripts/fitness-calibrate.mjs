/**
 * Paired fitness and investment calibration (#135). Not a copy of the chance model and not a mgmt-sim replay.
 * node scripts/fitness-calibrate.mjs --hooks /absolute/pb_hooks --seeds 128 \
 *   --seed-start 1000 --output /tmp/fitness-pilot.json
 * Defaults: repository hooks, 128 seeds starting at 1000. --output is required.
 * Every seed runs 3 profiles x 2 orientations x 8 subject variants (48 outcomes) with one
 * fixture id per seed/profile/orientation, so variants and sources share the same RNG seed.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { options, hash, source, loadEngine, fixture, PROFILES } from './balance-fixtures.mjs';

const SIDES = ['home', 'away'];
const ATTACK_UPGRADED = [2, 3, 4]; // mid, mid, att starters
const DEFENCE_UPGRADED = [0, 1, 2]; // gk, def, mid starters
const UPGRADE = 10;
/** Subject variants: one dimension at a time. Health applies to the whole squad; only Overclock debits the five. */
const VARIANTS = {
  full: { energy: 100, condition: 100 },
  e60: { energy: 60, condition: 100 },
  c50: { energy: 100, condition: 50 },
  atk10: { energy: 100, condition: 100, attack: ATTACK_UPGRADED },
  def10: { energy: 100, condition: 100, defence: DEFENCE_UPGRADED },
  e20: { energy: 20, condition: 100 },
  ocFull: { energy: 100, condition: 100, oc: true },
  ocE60: { energy: 60, condition: 100, oc: true },
};
/** Paired comparisons: treatment minus its control, inside each seed and orientation. */
const COMPARISONS = {
  energy60: ['e60', 'full'],
  condition50: ['c50', 'full'],
  energy20: ['e20', 'full'],
  attackUpgrade: ['atk10', 'full'],
  defenceUpgrade: ['def10', 'full'],
  fiveBatteries: ['e60', 'e20'],
  overclockFull: ['ocFull', 'full'],
  overclockE60: ['ocE60', 'e60'],
};
const OUTCOMES_PER_SEED = PROFILES.length * SIDES.length * Object.keys(VARIANTS).length;

const require = createRequire(import.meta.url);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const otherSide = side => (side === 'home' ? 'away' : 'home');

function readBalance(hooks) {
  const mod = require(path.join(hooks, 'lib/balance.js'));
  const b = mod.BALANCE;
  assert(Number.isFinite(b.overclockBonus) && b.overclockBonus > 1, 'overclockBonus missing');
  assert.equal(b.overclockEnergyCost, 8, 'overclockEnergyCost must stay 8');
  assert.equal(b.batteryRestore, 40, 'batteryRestore must stay 40 (e20 -> e60 is five batteries)');
  assert.equal(b.batteryCost, 180, 'batteryCost must stay 180');
  assert.equal(typeof mod.upgradeCost, 'function', 'upgradeCost missing');
  return { BALANCE: b, upgradeCost: mod.upgradeCost };
}

/** Subject squad for a variant, built from the controlled fixture roster. */
function subjectTeam(team, variant, cost) {
  const v = VARIANTS[variant];
  return {
    id: team.id, name: team.name, abbr: team.abbr, grade: team.grade, ai: false, stance: 'balanced', oc: !!v.oc,
    players: team.players.map((p, i) => {
      const starter = !!p.is_starter;
      assert.equal(starter, i < 5, 'the five starters are roster slots 0-4');
      return {
        id: p.id, name: p.name, role: p.role,
        attack: p.attack + (starter && v.attack?.includes(i) ? UPGRADE : 0),
        defence: p.defence + (starter && v.defence?.includes(i) ? UPGRADE : 0),
        energy: v.oc && starter ? clamp(v.energy - cost, 0, 100) : v.energy,
        condition: v.condition,
        intensity: p.intensity || 'balanced',
        is_starter: starter,
      };
    }),
  };
}

function opponentTeam(team) {
  return { id: team.id, name: team.name, abbr: team.abbr, grade: team.grade, ai: false, stance: 'balanced', oc: false,
    players: team.players.map(p => ({ id: p.id, name: p.name, role: p.role, attack: p.attack, defence: p.defence,
      energy: p.energy, condition: p.condition, intensity: p.intensity || 'balanced', is_starter: !!p.is_starter })) };
}

/** Everything the variant promises is in the frozen state before the first draw. */
function assertFrozen(st, subjectSide, profile, variant, cost) {
  const v = VARIANTS[variant];
  const mine = st.teams[subjectSide], theirs = st.teams[otherSide(subjectSide)];
  assert.equal(st.rc, 0, 'createMatch must not draw RNG');
  assert.equal(mine.oc, !!v.oc);
  assert.equal(theirs.oc, false);
  mine.players.forEach((p, i) => {
    const starter = i < 5;
    const energy = v.oc && starter ? clamp(v.energy - cost, 0, 100) : v.energy;
    assert.equal(p.is_starter, starter);
    assert.equal(p.energy, energy);
    assert.equal(p.e0, energy);
    assert.equal(p.condition, v.condition);
    assert.equal(p.c0, v.condition);
    assert.equal(p.attack, 70 + (starter && v.attack?.includes(i) ? UPGRADE : 0));
    assert.equal(p.defence, 70 + (starter && v.defence?.includes(i) ? UPGRADE : 0));
  });
  const opp = { peer: [70, 70], strongattack: [90, 70], strongdefence: [70, 90] }[profile];
  for (const p of theirs.players) {
    assert.deepEqual([p.attack, p.defence, p.energy, p.e0, p.condition, p.c0], [...opp, 100, 100, 100, 100]);
  }
}

function metrics(st, events, side) {
  const other = otherSide(side);
  const goals90 = who => events.filter(e => ['goal', 'penalty_goal'].includes(e.t) && e.min <= 90 && e.side === who).length;
  const starters = st.teams[side].players.filter(p => p.is_starter);
  return {
    advance: st.winner === side ? 1 : 0,
    goalDiff90: goals90(side) - goals90(other),
    goalsFor90: goals90(side),
    goalsAgainst90: goals90(other),
    shotsFor: st.stats[side].sh,
    shotsAgainst: st.stats[other].sh,
    finalEnergy: starters.reduce((n, p) => n + p.energy, 0) / starters.length,
    finalCondition: starters.reduce((n, p) => n + p.condition, 0) / starters.length,
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

function summarize(rows) {
  const at = new Map(rows.map(r => [`${r.profile}/${r.seed}/${r.subjectSide}/${r.variant}`, r]));
  const keys = Object.keys(rows[0].metrics);
  return PROFILES.map(profile => {
    const list = rows.filter(r => r.profile === profile);
    const seeds = [...new Set(list.map(r => r.seed))];
    const means = Object.fromEntries(Object.keys(VARIANTS).map(variant => {
      const vr = list.filter(r => r.variant === variant);
      return [variant, Object.fromEntries(keys.map(k => [k, mean(vr.map(r => r.metrics[k]))]))];
    }));
    const paired = Object.fromEntries(Object.entries(COMPARISONS).map(([name, [treatment, control]]) => {
      const deltas = Object.fromEntries(keys.map(k => [k, interval(seeds.map(seed => mean(SIDES.map(side => {
        const t = at.get(`${profile}/${seed}/${side}/${treatment}`), c = at.get(`${profile}/${seed}/${side}/${control}`);
        assert(t && c, 'missing paired row');
        return t.metrics[k] - c.metrics[k];
      }))))]));
      return [name, { treatment, control, deltas }];
    }));
    return { profile, seeds: seeds.length, orientations: SIDES, matchesPerVariant: seeds.length * SIDES.length, means, paired };
  });
}

/** Exact treasury cost of the measured investments under this source (prospective prices). */
function economy(balance, upgradeCost, summaries) {
  const thirty = (from) => {
    let total = 0;
    for (let player = 0; player < 3; player++) for (let level = from; level < from + UPGRADE; level++) total += upgradeCost(level);
    return total;
  };
  const credits = {
    attackUpgrade: thirty(70), // 30 purchases: +1 x10 on three 70-attack starters
    defenceUpgrade: thirty(70),
    fiveBatteries: 5 * balance.batteryCost, // e20 -> e60 for five starters, one match
  };
  const perThousand = Object.fromEntries(summaries.map(s => [s.profile, Object.fromEntries(Object.keys(credits).map(name =>
    [name, (s.paired[name].deltas.advance.estimate * 100 * 1000) / credits[name]]))]));
  return {
    credits,
    upgradeCostPerLevel: Object.fromEntries([50, 60, 70, 80, 90].map(l => [l, upgradeCost(l)])),
    advancePpPerThousandCredits: perThousand,
    notes: [
      'Upgrades are permanent +1 purchases; batteries are spent for one match. Per-credit figures compare a single match only and are not a campaign economy.',
      'Credits are prospective prices under this source; no refunds or wallet changes are implied.',
    ],
  };
}

export function calibrate(eng, config, balance, upgradeCost) {
  assert.equal(OUTCOMES_PER_SEED, 48);
  const cost = balance.overclockEnergyCost;
  const rows = [];
  for (let seed = config.seedStart; seed < config.seedStart + config.seeds; seed++) {
    for (const profile of PROFILES) for (const subjectSide of SIDES) {
      const probe = fixture(eng, { seed, profile, subjectSide, variant: 'balanced', minuteMs: 8000 });
      const id = `fitness-${seed}-${profile}-${subjectSide}`;
      for (const variant of Object.keys(VARIANTS)) {
        const subject = subjectTeam(probe.teams[subjectSide], variant, cost);
        const opponent = opponentTeam(probe.teams[otherSide(subjectSide)]);
        const st = eng.createMatch({ fixtureId: id, seed, kickoffAt: 0, timing: eng.buildTiming(8000, 1),
          home: subjectSide === 'home' ? subject : opponent, away: subjectSide === 'away' ? subject : opponent });
        assertFrozen(st, subjectSide, profile, variant, cost);
        const events = eng.advanceTo(st, Infinity);
        assert.equal(st.phase, 'finished');
        rows.push({ seed, profile, subjectSide, variant, fixtureId: id, metrics: metrics(st, events, subjectSide),
          eventHash: hash(events), finalStateHash: hash(st), rngCount: st.rc });
      }
    }
  }
  assert.equal(rows.length, config.seeds * OUTCOMES_PER_SEED);
  const summaries = summarize(rows);
  return {
    schema: 'footfive-fitness-calibration-v1',
    source: { ...source(config.hooks), fitness: balance.fitness || null, upgradeGrowth: balance.upgradeGrowth,
      upgradeBaseCost: balance.upgradeBaseCost, overclockBonus: balance.overclockBonus, overclockEnergyCost: cost,
      batteryRestore: balance.batteryRestore, batteryCost: balance.batteryCost },
    inputs: {
      seeds: config.seeds, seedStart: config.seedStart, seedEnd: config.seedStart + config.seeds - 1,
      outcomesPerSeed: OUTCOMES_PER_SEED, profiles: { subject: [70, 70], peer: [70, 70], strongattack: [90, 70], strongdefence: [70, 90] },
      grade: 'B', roles: ['gk', 'def', 'mid', 'mid', 'att', 'att', 'def'], starters: [0, 1, 2, 3, 4],
      variants: VARIANTS, upgrade: UPGRADE, comparisons: COMPARISONS, opponentHealth: { energy: 100, condition: 100 },
      stance: 'balanced', intensity: 'balanced', ai: false, orientations: SIDES, minuteMs: 8000,
    },
    notes: [
      'Controlled grade-B manual fixtures, not a replication of /workspace/mgmt-sim and not a campaign or league proof.',
      'Advance includes extra time and penalties; regulation goals are minute <= 90; shots and final starter fitness include extra time.',
      'Health applies to all seven subject players; Overclock variants debit overclockEnergyCost from exactly the five starters before createMatch and set oc.',
      'Paired deltas average the two orientations inside each seed, then take a normal 95% interval across seeds. No multiple-comparison correction.',
    ],
    matches: rows.length,
    summaries,
    economy: economy(balance, upgradeCost, summaries),
    rows,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const config = options(process.argv.slice(2), 128);
    if (config.help) {
      console.log('node scripts/fitness-calibrate.mjs [--hooks ABS_PB_HOOKS] [--seeds 128] [--seed-start 1000] --output PATH');
    } else {
      assert(config.output, '--output is required');
      const { BALANCE, upgradeCost } = readBalance(config.hooks);
      const report = calibrate(loadEngine(config.hooks), config, BALANCE, upgradeCost);
      fs.writeFileSync(config.output, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ output: path.resolve(config.output), matches: report.matches, seeds: config.seeds,
        seedStart: config.seedStart, outcomesPerSeed: OUTCOMES_PER_SEED, reportHash: hash(report), source: report.source }));
    }
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
}
