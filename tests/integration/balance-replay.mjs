/**
 * Same-configuration determinism/serialization gate; no baseline/candidate identity assertion.
 * node tests/integration/balance-replay.mjs --hooks /absolute/pb_hooks --seeds 200 --seed-start 1000
 * Defaults: repository hooks, 200 seeds starting at1000. No server or database.
 * Every seed checks fresh full/repeated/incremental runs, then queued minute71 coaching.
 */
import assert from 'node:assert/strict';
import { options, loadEngine, source, fixture, prefix70, clone, hash, PROFILES, VARIANTS } from '../../scripts/balance-calibrate.mjs';

const PHASES = new Set(['pre', 'first_half', 'half_time', 'second_half', 'et_break', 'extra_time_1', 'et_half_time', 'extra_time_2', 'shootout', 'finished']);
function validate(st, events) {
  assert.equal(st.phase, 'finished');
  assert(['home', 'away'].includes(st.winner));
  assert(['normal', 'aet', 'pens'].includes(st.by));
  assert.equal(events.filter(e => e.t === 'match_end').length, 1);
  assert.equal(events.at(-1).t, 'match_end');
  assert.equal(st.seq, events.length);
  let at = -Infinity;
  for (const [i, event] of events.entries()) {
    assert.equal(event.seq, i + 1, 'unique contiguous increasing seq');
    assert(Number.isFinite(event.at) && event.at >= at, `event time reversed at seq${event.seq}`);
    at = event.at;
    assert(PHASES.has(event.st.ph), `invalid event phase ${event.st.ph}`);
    assert(event.st.sc.every(n => Number.isInteger(n) && n >= 0), 'invalid public score');
  }
  assert.deepEqual(st.score, ['home', 'away'].map(side => events.filter(e => ['goal', 'penalty_goal'].includes(e.t) && e.side === side).length));
  assert.deepEqual(events.at(-1).st.sc, st.score);
  for (const side of ['home', 'away']) for (const p of st.teams[side].players) {
    assert(p.energy >= 0 && p.energy <= 100 && p.condition >= 0 && p.condition <= 100);
  }
}
function same(reference, actual, label) {
  assert.deepEqual(actual.st.score, reference.st.score, label + ': score');
  assert.deepEqual(actual.st.stats, reference.st.stats, label + ': stats');
  assert.equal(actual.st.rc, reference.st.rc, label + ': RNG count');
  assert.equal(hash(actual.events), hash(reference.events), label + ': complete event stream');
  assert.deepEqual(actual.st, reference.st, label + ': complete final state');
}
function full(eng, input, queued) {
  const st = fixture(eng, input), events = [];
  if (queued) {
    events.push(...prefix70(eng, st));
    eng.queueStance(st, input.subjectSide, queued);
  }
  events.push(...eng.advanceTo(st, Infinity));
  return { st, events };
}
function persisted(eng, input, queued) {
  let st = fixture(eng, input), previousNow = -Infinity, didQueue = false, steps = 0;
  const events = [];
  while (st.phase !== 'finished') {
    assert(++steps < 500, 'replay failed to terminate');
    if (queued && st.minute === 70 && !didQueue) {
      eng.queueStance(st, input.subjectSide, queued);
      didQueue = true;
    }
    // Persist at real boundaries, including an unapplied pending command.
    st = clone(st);
    if (didQueue && st.minute === 70) assert.equal(st.pending[input.subjectSide], queued);
    const cursor = st.nextAt;
    assert(Number.isFinite(cursor) && cursor >= previousNow, 'valid monotonic resume clock');
    // Immediately before a future cursor, nothing may advance. Never rewind now.
    if (cursor - 1 >= previousNow) {
      const before = hash(st);
      assert.deepEqual(eng.advanceTo(st, cursor - 1), []);
      assert.equal(hash(st), before, 'advance before cursor mutated state');
    }
    events.push(...eng.advanceTo(st, cursor));
    previousNow = cursor;
    const after = hash(st);
    assert.deepEqual(eng.advanceTo(st, cursor), [], 'same now must not advance twice');
    assert.equal(hash(st), after);
  }
  assert.equal(didQueue, !!queued);
  return { st, events };
}
try {
  const config = options(process.argv.slice(2), 200);
  if (config.help) console.log('node tests/integration/balance-replay.mjs [--hooks ABS_PB_HOOKS] [--seeds 200] [--seed-start 1000]');
  else {
    const eng = loadEngine(config.hooks), fingerprints = [];
    for (let i = 0; i < config.seeds; i++) {
      const input = { seed: config.seedStart + i, profile: PROFILES[i % PROFILES.length],
        subjectSide: i % 2 ? 'away' : 'home', variant: VARIANTS[i % VARIANTS.length],
        minuteMs: [8000, 15000, 1000][i % 3] };
      for (const queued of [null, input.variant === 'attack' ? 'defend' : 'attack']) {
        const reference = full(eng, input, queued);
        validate(reference.st, reference.events);
        same(reference, full(eng, input, queued), 'fresh repeat');
        const replay = persisted(eng, input, queued);
        same(reference, replay, 'JSON incremental replay');
        validate(replay.st, replay.events);
        if (queued) {
          const applied = replay.events.filter(e => e.t === 'coaching' && e.by === 'manager');
          assert.equal(applied.length, 1);
          assert.equal(applied[0].side, input.subjectSide);
          assert.equal(applied[0].stance, queued);
          assert.equal(applied[0].min, 71);
        }
        fingerprints.push({ input, queued, finalStateHash: hash(reference.st), eventHash: hash(reference.events) });
      }
    }
    console.log(JSON.stringify({ status: 'PASS', seeds: config.seeds, seedStart: config.seedStart,
      configurations: fingerprints.length, executions: fingerprints.length * 3,
      checks: ['fresh repeat', 'JSON incremental including pending coaching', 'cursor boundaries', 'seq/time/score/phase/end/resource invariants'],
      fingerprint: hash(fingerprints), source: source(config.hooks) }));
  }
} catch (error) { console.error(error.stack || error); process.exitCode = 1; }
