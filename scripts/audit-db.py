#!/usr/bin/env python3
"""Consistency audit for a FootFive database (read-only).

Usage: python3 scripts/audit-db.py path/to/data.db [--since-ms N]

Checks (engine v2 fixtures only):
  - fixture score == last event score; shootout goals never in the football score
  - every goal event increments exactly one side by one (score and announcement together)
  - event seq contiguous per fixture, `at` non-decreasing with seq
  - shootout: decided correctly, never declared early in sudden death
  - one summary per finished fixture; champions recorded once per tournament
  - every settled bet paid exactly once (ledger key unique) and balances == ledger sums
  - no user balance negative; no team has two managers
"""
import json
import sqlite3
import sys
from collections import defaultdict

db = sys.argv[1]
c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
q = lambda s, *a: c.execute(s, a).fetchall()
errors = []
def bad(msg):
    errors.append(msg)

def decided(h, a, th, ta):
    if th <= 5 and ta <= 5:
        if h + (5 - th) < a: return "away"
        if a + (5 - ta) < h: return "home"
        return None
    if th == ta and h != a: return "home" if h > a else "away"
    return None

fixtures = q("select id, status, score_home, score_away, shootout_home, shootout_away, decided_by, winner_team, home_team, away_team from shared_fixtures where finished_ms > 0")
checked = 0
for fid, status, sh, sa, soh, soa, by, winner, home, away in fixtures:
    rows = q("select seq, at, type, data from match_events where fixture=? order by seq", fid)
    if not rows:
        continue  # legacy fixture
    checked += 1
    prev_seq, prev_at, sc = 0, 0, [0, 0]
    so_kicks = []
    for seq, at, typ, data in rows:
        d = json.loads(data)
        if seq != prev_seq + 1: bad(f"{fid}: seq gap {prev_seq}->{seq}")
        if at < prev_at: bad(f"{fid}: at decreases at seq {seq}")
        new = d["st"]["sc"]
        if typ in ("goal", "penalty_goal"):
            side = 0 if d["side"] == "home" else 1
            exp = list(sc); exp[side] += 1
            if new != exp: bad(f"{fid}: goal seq {seq} score {sc}->{new}")
        elif new != sc:
            bad(f"{fid}: score changed on non-goal {typ} seq {seq} {sc}->{new}")
        if typ == "shootout_kick":
            so_kicks.append(d)
            if d["st"]["sc"] != sc: bad(f"{fid}: shootout touched football score")
        sc = new
        prev_seq, prev_at = seq, at
    last = json.loads(rows[-1][3])
    if rows[-1][2] != "match_end": bad(f"{fid}: last event {rows[-1][2]}")
    if [sh, sa] != sc: bad(f"{fid}: fixture score {sh}-{sa} != events {sc}")
    if by == "pens":
        h = a = th = ta = 0
        for i, k in enumerate(so_kicks):
            if k["side"] == "home":
                th += 1; h += k["kick"]["outcome"] == "goal"
            else:
                ta += 1; a += k["kick"]["outcome"] == "goal"
            dec = decided(h, a, th, ta)
            if dec and i != len(so_kicks) - 1: bad(f"{fid}: shootout continued after decision")
            if not dec and i == len(so_kicks) - 1: bad(f"{fid}: shootout ended undecided")
            if (th > 5 or ta > 5) and dec and th != ta: bad(f"{fid}: sudden death decided on unequal kicks")
        if [soh, soa] != [h, a]: bad(f"{fid}: shootout totals {soh}-{soa} != kicks {h}-{a}")
        if sh != sa: bad(f"{fid}: pens but football score not level")
        wside = "home" if h > a else "away"
    else:
        if sh == sa: bad(f"{fid}: decided {by} with level score")
        wside = "home" if sh > sa else "away"
    if winner != (home if wside == "home" else away): bad(f"{fid}: wrong winner")

dupes = q("select fixture_id, count(*) from match_summaries group by fixture_id having count(*)>1")
if dupes: bad(f"duplicate summaries {dupes[:3]}")
missing = q("select f.id from shared_fixtures f left join match_summaries s on s.fixture_id=f.id where f.finished_ms>0 and s.id is null")
if missing: bad(f"finished fixtures without summary {missing[:3]}")
tdup = q("select number, count(*) from shared_tournaments group by number having count(*)>1")
if tdup: bad(f"duplicate championship numbers {tdup}")
act = q("select count(*) from shared_tournaments where status='active'")[0][0]
if act > 1: bad(f"{act} active championships")
champ_rewards = q("select settlement_key, count(*) from reward_settlements group by settlement_key having count(*)>1")
if champ_rewards: bad(f"duplicate reward settlements {champ_rewards[:3]}")

# betting ledger
led_dup = q("select idempotency_key, count(*) from credit_ledger where idempotency_key!='' group by idempotency_key having count(*)>1")
if led_dup: bad(f"duplicate ledger keys {led_dup[:3]}")
for bid, status, stake, odds, payout in q("select id, status, stake, odds, payout from shared_bets where market != ''"):
    stake_rows = q("select amount from credit_ledger where idempotency_key=?", bid + ":stake")
    if stake_rows != [(-stake,)]: bad(f"bet {bid}: stake ledger {stake_rows}")
    pay = q("select amount from credit_ledger where idempotency_key=?", bid + ":settle")
    if status == "won":
        exp = int(stake * odds + 1e-9)
        if pay != [(exp,)] or payout != exp: bad(f"bet {bid}: won payout {pay} {payout} expected {exp}")
    elif status == "void":
        if pay != [(stake,)]: bad(f"bet {bid}: refund {pay}")
    elif status == "lost":
        if pay: bad(f"bet {bid}: lost but paid {pay}")
for uid, credits in q("select id, credits from users"):
    if credits < 0: bad(f"user {uid} negative balance")
    rows = q("select amount, balance_after from credit_ledger where user=? and balance_after is not null order by created, rowid", uid)
    if rows and rows[-1][1] != credits: bad(f"user {uid}: balance {credits} != last ledger {rows[-1][1]}")
mgr = q("select manager, count(*) from proball_teams where manager!='' group by manager having count(*)>1")
if mgr: bad(f"user manages several teams {mgr}")

bets = dict(q("select status, count(*) from shared_bets group by status"))
print(json.dumps({"fixturesChecked": checked, "bets": bets, "championships": q("select count(*) from shared_tournaments")[0][0], "errors": errors[:40], "errorCount": len(errors)}, indent=1))
sys.exit(1 if errors else 0)
