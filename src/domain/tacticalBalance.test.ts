/**
 * Tactical balance (#133) — stance is a deterministic match tempo shared by both sides, and
 * intensity trades immediate pressure for fitness. Runs against the real PocketBase hook modules.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const eff = lib("effectiveStats.js");
const { BALANCE } = lib("balance.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

type Stance = "defend" | "balanced" | "attack";
type Intensity = "passive" | "balanced" | "aggressive";
type Rates = { home: number; away: number };
type Ev = { seq: number; t: string; min: number; side?: string; by?: string; stance?: string; st: { sc: [number, number]; ph: string } };

const STANCES: Stance[] = ["defend", "balanced", "attack"];
const ROLES = ["gk", "def", "mid", "mid", "att"];
const timing = eng.buildTiming(1000, 1);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** A manual five with uniform attributes (the same shape as the calibration profiles). */
const side = (id: string, o: { attack?: number; defence?: number; grade?: string; stance?: Stance; intensity?: Intensity } = {}) => ({
  id,
  name: id,
  abbr: id.slice(0, 3).toUpperCase(),
  grade: o.grade || "B",
  ai: false,
  stance: o.stance || "balanced",
  players: ROLES.map((role, i) => ({
    id: `${id}-${i}`,
    name: `${id} ${i}`,
    role,
    attack: o.attack ?? 70,
    defence: o.defence ?? 70,
    energy: 100,
    condition: 100,
    intensity: o.intensity || "balanced",
    is_starter: true,
  })),
});
type Side = ReturnType<typeof side>;
const kickoff = (home: Side, away: Side, seed = 1) => eng.createMatch({ fixtureId: "t" + seed, seed, kickoffAt: 0, home, away, timing });
const rates = (home: Side, away: Side): Rates => eng.goalRates(kickoff(home, away));
const authored = (i: number) => {
  const t = TEAMS[i];
  return {
    id: t.slug,
    name: t.name,
    abbr: t.abbreviation,
    grade: t.grade,
    ai: false,
    stance: "balanced" as Stance,
    players: defaultStarters(t.players).map((p: object) => ({ ...p, intensity: "balanced" })),
  };
};

describe("balanced v balanced manual matches are unchanged by #133", () => {
  // Captured from the pre-#133 engine (base 88b0b64); a later balance change must update these knowingly.
  const GOLDEN = [
    { seed: 11, h: 0, a: 15, rc: 2254, score: [2, 1], events: 409, hash: "e5d2e3853031bd1f779251c5f3a020401d1fab057dd59c1ec061be5e41c6a4be" },
    { seed: 12, h: 5, a: 6, rc: 2068, score: [2, 0], events: 367, hash: "283e19375049323e703ae1b7b51de620be4ae70832b8b3bf2f19619fe6c95b61" },
    { seed: 13, h: 9, a: 2, rc: 2082, score: [0, 1], events: 365, hash: "a5674d4d455fdaa1c78c1ac49d173de6d588fa7ab5b7e30a11aef97bd43774b6" },
  ];

  it.each(GOLDEN)("seed $seed reproduces the identical event stream, score and RNG count", (g) => {
    const st = eng.createMatch({ fixtureId: "n" + g.seed, seed: g.seed, kickoffAt: 0, home: authored(g.h), away: authored(g.a), timing });
    const ev = eng.advanceTo(st, 1e12);
    expect(st.rc).toBe(g.rc);
    expect(st.score).toEqual(g.score);
    expect(ev).toHaveLength(g.events);
    expect(hash(ev)).toBe(g.hash);
  });

  it("a stance never changes a player's effective stats (stance is match tempo)", () => {
    const p = { attack: 80, defence: 60, role: "mid", energy: 90, condition: 95, intensity: "balanced" };
    const plain = eff.effectivePlayerStats(p, {});
    for (const s of STANCES) expect(eff.effectivePlayerStats(p, { coachingStance: s })).toEqual(plain);
    expect(eff.effectiveTeamStrength([{ ...p, is_starter: true }], { grade: "B", coachingStance: "attack" })).toEqual(
      eff.effectiveTeamStrength([{ ...p, is_starter: true }], { grade: "B" }),
    );
  });
});

describe("stance tempo", () => {
  it("is mirror-neutral: identical sides get identical goal rates for every stance pair", () => {
    for (const h of STANCES)
      for (const a of STANCES) {
        const r = rates(side("home", { stance: h }), side("away", { stance: a }));
        expect(r.home).toBe(r.away);
      }
  });

  it("Attack raises both sides' goal rates and Defend lowers both, across opponent profiles and grades", () => {
    const opponents = [
      side("peer"),
      side("strongattack", { attack: 90 }),
      side("strongdefence", { defence: 90 }),
      side("elite", { attack: 92, defence: 92, grade: "A++" }),
      side("minnow", { attack: 50, defence: 50, grade: "C-" }),
    ];
    for (const opp of opponents)
      for (const subjectHome of [true, false]) {
        const at = (s: Stance) => {
          const subject = side("subject", { stance: s });
          const r = subjectHome ? rates(subject, opp) : rates(opp, subject);
          return subjectHome ? { mine: r.home, theirs: r.away } : { mine: r.away, theirs: r.home };
        };
        const [d, b, a] = STANCES.map(at);
        expect(a.mine).toBeGreaterThan(b.mine);
        expect(a.theirs).toBeGreaterThan(b.theirs);
        expect(d.mine).toBeLessThan(b.mine);
        expect(d.theirs).toBeLessThan(b.theirs);
      }
  });

  it("opposite stances cancel exactly, and tempo amplifies the stronger side's margin", () => {
    const fav = side("fav", { attack: 85, defence: 85, grade: "A" });
    const dog = side("dog", { attack: 60, defence: 60, grade: "C" });
    expect(rates({ ...fav, stance: "attack" }, { ...dog, stance: "defend" })).toEqual(rates(fav, dog));
    const margin = (s: Stance) => {
      const r = rates({ ...fav, stance: s }, dog);
      return r.home - r.away;
    };
    expect(margin("balanced")).toBeGreaterThan(0);
    expect(margin("attack")).toBeGreaterThan(margin("balanced"));
    expect(margin("defend")).toBeLessThan(margin("balanced"));
  });

  it("unknown or prototype stance names play as Balanced", () => {
    const base = rates(side("home"), side("away"));
    for (const odd of ["toString", "constructor", "__proto__", "park_the_bus", ""]) {
      const st = kickoff(side("home"), side("away"));
      st.teams.home.stance = odd;
      expect(eng.goalRates(st)).toEqual(base);
    }
  });

  it("simulated goals follow the same chance model as goalRates (one chance path)", () => {
    const goals = (s: Stance) => {
      let n = 0;
      for (let seed = 1; seed <= 60; seed++) {
        const ev: Ev[] = eng.advanceTo(kickoff(side("home", { stance: s }), side("away", { stance: s }), seed), 1e12);
        n += ev.filter((e) => (e.t === "goal" || e.t === "penalty_goal") && e.min <= 90).length;
      }
      return n / 60;
    };
    const model = (s: Stance) => {
      const r = rates(side("home", { stance: s }), side("away", { stance: s }));
      return (r.home + r.away) * 90;
    };
    const sim = STANCES.map(goals);
    expect(sim[2]).toBeGreaterThan(sim[1]);
    expect(sim[1]).toBeGreaterThan(sim[0]);
    STANCES.forEach((s, i) => {
      expect(sim[i] / model(s)).toBeGreaterThan(0.8);
      expect(sim[i] / model(s)).toBeLessThan(1.2);
    });
  });
});

describe("intensity", () => {
  const player = (intensity: Intensity) => ({ attack: 70, defence: 70, role: "mid", energy: 100, condition: 100, intensity });

  it("aggressive presses harder now, passive gives up immediate attack and some defence", () => {
    const [p, b, a] = (["passive", "balanced", "aggressive"] as Intensity[]).map((i) => eff.effectivePlayerStats(player(i), {}));
    expect(a.attack).toBeGreaterThan(b.attack);
    expect(b.attack).toBeGreaterThan(p.attack);
    expect(a.defence).toBe(b.defence);
    expect(b.defence).toBeGreaterThan(p.defence);
    const own = (i: Intensity) => rates(side("subject", { intensity: i }), side("opp"));
    expect(own("aggressive").home).toBeGreaterThan(own("balanced").home);
    expect(own("passive").home).toBeLessThan(own("balanced").home);
    // Fresh legs: no defensive cost at kick-off (the extra attack also wins a little more of the ball).
    expect(own("aggressive").away).toBeLessThanOrEqual(own("balanced").away);
    expect(own("passive").away).toBeGreaterThan(own("balanced").away);
  });

  it("keeps the wear cost: aggressive tires fastest and passive conserves energy and condition", () => {
    expect(BALANCE.intensity.aggressive).toMatchObject({ energyUse: 1.4, condition: 1.35 });
    expect(BALANCE.intensity.balanced).toMatchObject({ attack: 1, defence: 1, energyUse: 1, condition: 1 });
    expect(BALANCE.intensity.passive).toMatchObject({ energyUse: 0.55, condition: 0.6 });
    const after = (i: Intensity) => {
      const st = kickoff(side("subject", { intensity: i }), side("opp"), 5);
      while (st.minute < 20) eng.advanceTo(st, st.nextAt);
      const p = st.teams.home.players.find((x: { role: string }) => x.role === "gk"); // keepers never commit fouls, so never leave early
      return { energy: p.energy, condition: p.condition };
    };
    const [p, b, a] = (["passive", "balanced", "aggressive"] as Intensity[]).map(after);
    expect(a.energy).toBeLessThan(b.energy);
    expect(b.energy).toBeLessThan(p.energy);
    expect(a.condition).toBeLessThan(b.condition);
    expect(b.condition).toBeLessThan(p.condition);
    expect(b.energy).toBeCloseTo(100 - 20 * BALANCE.energyDrainPerMinute, 6);
  });
});

describe("coaching, odds and persisted v2 state", () => {
  it("a queued stance applies from the next minute, emits one event and drives the live chance model", () => {
    const st = kickoff(side("home"), side("away"), 21);
    while (st.minute < 30) eng.advanceTo(st, st.nextAt);
    const before: Rates = eng.goalRates(st);
    eng.queueStance(st, "home", "attack");
    expect(eng.goalRates(st)).toEqual(before); // pending only: nothing changes before the next minute
    const ev: Ev[] = eng.advanceTo(st, st.nextAt);
    const coaching = ev.filter((e) => e.t === "coaching");
    expect(coaching).toHaveLength(1);
    expect(coaching[0]).toMatchObject({ side: "home", stance: "attack", by: "manager", min: 31 });
    const balancedTwin = clone(st);
    balancedTwin.teams.home.stance = "balanced";
    const live: Rates = eng.goalRates(st);
    const flat: Rates = eng.goalRates(balancedTwin);
    expect(live.home).toBeGreaterThan(flat.home);
    expect(live.away).toBeGreaterThan(flat.away);
  });

  it("the kick-off odds model prices the kick-off stance with the same tempo", () => {
    const flat = rates(side("home"), side("away"));
    const open = rates(side("home", { stance: "attack" }), side("away"));
    const closed = rates(side("home", { stance: "defend" }), side("away"));
    expect(open.home).toBeGreaterThan(flat.home);
    expect(open.away).toBeGreaterThan(flat.away);
    expect(closed.home).toBeLessThan(flat.home);
    expect(closed.away).toBeLessThan(flat.away);
  });

  it("keeps the v2 state shape: no version bump or new persisted fields", () => {
    const st = kickoff(side("home", { stance: "attack" }), side("away"));
    expect(st.v).toBe(2);
    expect(Object.keys(st).sort()).toEqual(
      ["v", "fx", "seed", "rc", "seq", "timing", "teams", "phase", "minute", "nextAt", "score", "so", "stats", "possMin", "ball", "bs", "counter", "pending", "danger", "winner", "by", "finishedAt"].sort(),
    );
    expect(Object.keys(st.teams.home).sort()).toEqual(["id", "name", "abbr", "grade", "stance", "ai", "oc", "players"].sort());
  });

  it("resumes a persisted mid-match v2 state with a pending stance without resetting or rewriting the past", () => {
    const st = kickoff(side("home", { stance: "defend" }), side("away", { intensity: "aggressive" }), 33);
    const past: Ev[] = [];
    while (st.minute < 40) past.push(...eng.advanceTo(st, st.nextAt));
    eng.queueStance(st, "away", "attack");
    const saved = JSON.stringify(st);
    const pastHash = hash(past);
    const resumed = JSON.parse(saved);
    const ev: Ev[] = eng.advanceTo(resumed, 1e12);
    expect(hash(past)).toBe(pastHash);
    expect(ev[0].seq).toBe(JSON.parse(saved).seq + 1);
    expect(ev.some((e) => e.t === "kickoff")).toBe(false);
    expect(Math.min(...ev.map((e) => e.min))).toBeGreaterThanOrEqual(41);
    expect(ev[0].st.sc[0]).toBeGreaterThanOrEqual(JSON.parse(saved).score[0]);
    expect(ev[0].st.sc[1]).toBeGreaterThanOrEqual(JSON.parse(saved).score[1]);
    expect(ev.filter((e) => e.t === "coaching" && e.side === "away")).toMatchObject([{ stance: "attack", by: "manager", min: 41 }]);
    expect(resumed.phase).toBe("finished");
    // Same persisted JSON, same continuation.
    expect(hash(eng.advanceTo(JSON.parse(saved), 1e12))).toBe(hash(ev));
  });
});
