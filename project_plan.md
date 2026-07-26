# FootFive / Proball Manager Project Plan

**Version:** 3.9  
**Last updated:** 25 July 2026  
**Status:** Phase 12 — **production live**; admin UI routing fixed; official team abbreviations

---

## 1. Project Summary

**Project name:** FootFive / Proball Manager

FootFive is a mobile-first mini-management game built around **one shared global Proball** — a continuous 16-team knockout championship that every account experiences together.

Users register, optionally **claim one unclaimed team** (one manager per team, one team per user), or remain **spectators**. Unclaimed teams are AI-controlled. The server runs the tournament 24/7: shared fixtures, shared scoreboard, shared results. Managers prepare lineups between rounds and use live **Defend / Balanced / Attack** coaching during their fixture. Everyone can bet fictional credits on fixtures that do not involve their managed team.

**Phase 1 private per-user careers and private tournaments are replaced** (development data only; not product direction).

The goal remains a focused **mini-manager and mobile timer game**, not a full football manager sim.

---

## 2. Single Source of Truth

This file, `project_plan.md`, is the single source of truth for the project.

When meaningful changes are made:

- Update this file when project direction, scope, architecture or core rules change.
- Update `bugs.md` when bugs are found, fixed or reopened.
- Update `new_features.md` when features are requested, planned, started or completed.
- Update `changelog.md` after meaningful completed work.

Preserve existing decisions unless a newer instruction clearly replaces them.

---

## 3. Product Direction

The game should feel like a lightweight mobile management game:

- Easy to understand in a few minutes.
- Useful short sessions throughout the day.
- Persistent progress between sessions.
- Visible countdowns and regenerating resources.
- Enough tactical control to influence matches without becoming complicated.
- Fast, dramatic match presentation.
- Strong cyberpunk sports identity.

### Shared world (source of truth)

- **One global Proball** for all accounts.
- **Up to 16 user managers** (one per team).
- **One team per user**; unclaimed teams are **AI**.
- **Spectators** may register when all teams are taken (or without claiming).
- **Shared** tournament, fixtures, scoreboard, events, records, results.
- Tournament continues **24/7** with or without browsers online.
- **Not** private per-user tournament copies.

---

## 4. Core Game Loop

1. User signs up or logs in (starts with **1000 fictional credits**).
2. User claims an available team **or** continues as spectator.
3. Shared Proball is already running (or starts automatically).
4. Between rounds: managers set lineup (management window open).
5. At kickoff: lineups freeze; match state created; **incremental simulation** begins.
6. All users see the same scoreboard; anyone can watch any fixture.
7. During live play, a manager may change coaching stance (Defend / Balanced / Attack) — affects **future segments only**.
8. Users bet on fixtures that do not involve their managed team; bets lock at kickoff and settle once.
9. Winners progress once; after the final, wait global interval and draw a new R16.
10. Team ownership and all-time records persist across tournaments.

The loop repeats indefinitely.

---

## 5. Proball Tournament Format

Each tournament contains the same 16 teams and follows this structure:

1. Round of 16
2. Quarter-finals
3. Semi-finals
4. Final

Each knockout match uses:

1. Normal time.
2. Extra time if level after normal time.
3. A penalty shootout if still level.

The winner progresses and the loser is eliminated.

### Tournament timing (global)

- Configurable waiting period between rounds (default **10 minutes** normal; short **dev** interval for testing).
- Pace and intervals live on the **global world** record — not per user.
- Countdown continues when the app is closed.
- Store absolute timestamps (`scheduled_at`, `next_segment_due_at`, `next_action_at`).
- Minute cron + route catch-up advance due simulation segments and rounds.

### Match simulation (incremental)

- Matches are **not** fully decided at kickoff.
- Advance in segments (~**5 match minutes**; ~**20 real seconds** at normal 4s/min).
- Persist match state (seed, cursor, scores, cards, coaching, stats, events so far).
- Coaching changes apply from the **next unsimulated segment** only.
- Past events never recalculate.

### Tournament restart

- After the final, show the champion, runner-up, rewards and tournament summary.
- Wait for the configured interval.
- Start a fresh Round of 16 automatically.
- Persistent team progress and all-time records remain.
- Seasonal tournament statistics reset for the new tournament.

### Eliminated user team

When the user's team is eliminated:

- Award a consolation payment based on the round reached.
- Restore the squad's energy to full.
- Do not automatically remove all condition damage; repairs should still matter.
- Allow the user to continue viewing fixtures, betting, upgrading and preparing for the next tournament.
- The tournament continues until a champion is decided.

---

## 6. Mobile Timer Mechanic: Command Charge

The game includes a regenerating action-point resource called **Command Charge**.

### Command Charge rules

- Maximum capacity: 5 points for the initial build.
- Regeneration: approximately 1 point every 15 minutes.
- Exact values may be tuned during balancing.
- Regeneration is timestamp-based and must work while the app is closed.
- The frontend should animate the gauge smoothly.
- The server/database must validate the true available amount when points are spent.
- Do not run a continuous backend timer for each user.

### Command Charge actions

Command Charge is used for small, useful actions between rounds, such as:

- **Rapid Charge:** restore a modest amount of one player's energy.
- **Field Repair:** restore a modest amount of one player's condition.
- **Tactical Scan:** reveal a clearer opponent-strength and match-odds report.
- **Overclock Briefing:** grant a small temporary match preparation bonus.

Command Charge should supplement credits, batteries and mechanics rather than replace them.

The mechanic should encourage short return visits without becoming punitive or pay-to-win.

---

## 7. Teams

The Proball contains these 16 fictional teams:

1. New Metro City
2. Airway City
3. Virgin
4. Port Hilo
5. Metro Bay
6. Green Bay
7. Tripper City
8. Mega City One
9. Mega City Two
10. Atlan
11. Redstone
12. Swirl
13. St Marry
14. Orlean City
15. Outside City
16. Doge City

### Starting team strengths

| Team | Grade |
|---|---|
| New Metro City | A++ |
| Mega City One | A+ |
| Port Hilo | A |
| Tripper City | A |
| Outside City | A- |
| Green Bay | B+ |
| Mega City Two | B+ |
| Airway City | B |
| Virgin | B |
| St Marry | B- |
| Orlean City | B- |
| Atlan | C+ |
| Doge City | C+ |
| Metro Bay | C |
| Redstone | C |
| Swirl | C- |

At career creation, the user may choose any one of the 16 teams, including the strongest teams. Team grade affects difficulty and expected rewards, but it does not restrict selection.

Team strength should influence results, but upsets must remain possible.

---

## 8. Squad Structure

Each team has a small squad of **7 named cyborg players**:

- 5 starters.
- 2 substitutes.

The game should use clear five-a-side roles without creating a complicated formation engine.

A sensible starting structure is:

- 1 goalkeeper.
- 1 defender.
- 2 midfield or utility players.
- 1 attacker.
- 2 substitutes with varied roles.

The user can select the starting five and substitutes before a round begins.

AI teams automatically select valid line-ups.

A transfer market is not part of the MVP.

---

## 9. Cyborg Player Attributes

Each cyborg has four core attributes:

- **Attack:** attacking contribution, shooting and chance creation.
- **Defence:** tackling, blocking, saving and defensive contribution.
- **Energy:** temporary power available for matches.
- **Condition:** mechanical health and long-term damage state.

Keep the first version focused on these four attributes. Position and role weighting can make defence more important for goalkeepers and defenders without adding many extra stats.

### Attribute rules

- Attack and defence can be permanently upgraded with credits.
- Upgrade prices rise sharply at higher levels.
- Energy ranges from 0 to 100.
- Condition ranges from 0 to 100.
- Low energy reduces effective match performance.
- Low condition reduces effective match performance and may increase malfunction risk.
- Neither energy nor condition can exceed its maximum.
- All upgrade, recharge and repair costs must be validated before purchase.

---

## 10. Energy and Condition

Energy and condition are separate systems.

### Energy

- Energy is consumed during matches.
- Aggressive play consumes more energy.
- Passive play consumes less energy.
- Balanced play uses normal energy.
- Energy slowly regenerates between rounds based on elapsed time.
- Batteries can be purchased with credits and used to restore energy immediately.
- Elimination restores the user's squad to full energy.

### Condition

- Condition represents mechanical wear or damage.
- Fouls, intense play and random match incidents may reduce condition.
- Mechanics can be hired with credits to restore condition.
- Condition does not automatically fully reset after every tournament.
- Very low condition should visibly warn the user before team selection.

Use timestamps to calculate passive regeneration. Do not write a database update every few seconds.

---

## 11. Player Intensity

Each player can be set to one of three intensity modes before a match:

### Passive

- Reduced energy use.
- Lower attacking pressure.
- Slightly safer and more defensive behaviour.
- Lower foul and condition-damage risk.

### Balanced

- Normal performance.
- Normal energy use.
- Normal risk.

### Aggressive

- Increased attacking contribution and pressure.
- Higher energy use.
- Higher foul, card and condition-damage risk.
- May slightly reduce defensive discipline.

The exact numerical modifiers should be simple, centralised and easy to rebalance.

AI teams use Balanced intensity by default.

---

## 12. Economy and Rewards

The game uses fictional in-game credits only.

There are no real-money deposits, withdrawals, payments or cash prizes.

### Income

The user earns credits from:

- Winning matches.
- Beating a higher-tier opponent.
- Progressing to later rounds.
- Scoring goals.
- Reaching the final.
- Winning the Proball.
- Consolation payments after elimination.
- Successful fictional-credit bets.

Rewards should increase according to:

- Opponent strength.
- Tournament round.
- Match result.
- Goals scored.

### Expenses

Credits can be spent on:

- Attack upgrades.
- Defence upgrades.
- Energy batteries.
- Mechanical repairs.
- Bets.

All credit changes should create a transaction record with a type, amount, description and timestamp.

The economy should allow steady progress but prevent rapid maxing-out of a squad.

---

## 13. AI Team Management

The 15 non-user teams are AI controlled.

AI teams should:

- Select a valid starting five.
- Use Balanced player intensity.
- Keep player energy at sensible levels.
- Repair badly damaged cyborgs when affordable.
- Upgrade players gradually when AI progression is enabled.
- Never spend more credits than they possess.
- Avoid perfectly optimal behaviour so weaker AI teams remain beatable.

### AI progression flag

A career setting should control whether AI teams improve over time:

- `ai_progression_enabled = true`: AI teams slowly repair and upgrade.
- `ai_progression_enabled = false`: AI base stats remain mostly static, while energy and condition are still maintained.

AI progression must be slow enough that the user can make meaningful progress.

---

## 14. Betting System

The user may place fictional-credit bets on the winner of any other fixture in their current tournament. The user cannot bet on the fixture involving their managed team.

### MVP betting rules

- Winner-only bets.
- A user chooses one side only and cannot bet on both teams in the same fixture.
- Use one active winner bet per user per fixture for the MVP.
- Bets close and odds lock when the fixture begins.
- Users cannot stake more than their available balance.
- Bets settle automatically after the result is final.
- Penalty shootout winners count as the fixture winner for betting settlement.
- All stakes and payouts use fictional in-game credits.
- No payments, real money, cryptocurrency or cash-out features.

### Odds

Odds should be calculated from a simple transparent model using:

- Base team strength.
- Current starting-five attack and defence.
- Energy.
- Condition.
- Recent form.
- Previous Proball success.

The system may refresh odds before kickoff when team state changes.

Trusted odds calculation, stake deduction and payout settlement must not be controlled solely by browser code.

---

## 15. Match Simulation

Matches are simulated minute by minute as game logic, but the backend does not need to remain running for every displayed match minute.

### Recommended simulation approach

1. When a round becomes due, PocketBase server-side game logic generates each fixture's authoritative result, statistics and ordered event timeline once.
2. Every fixture in the round receives the same canonical `round_started_at` timestamp and event offsets that represent match time.
3. Store compact official results and event timelines in collections that normal clients cannot read directly.
4. Expose protected custom endpoints for current-round scoreboard snapshots and match-event catch-up. These endpoints use PocketBase server time and return only events whose offsets are already due.
5. Never send future events, hidden final scores or complete unfinished timelines to the browser.
6. The React frontend reconstructs the current minute, visible events and visible score from the server-approved event stream.
7. The user may open any fixture late, leave it, watch another match and return without restarting either match.
8. Completed matches remain available as replays or may be skipped directly to the result.
9. The main scoreboard uses the same protected server-side timeline calculation for every fixture.

This creates a genuine shared-in-time round experience without requiring a continuously running match process or database writes for every displayed second.

### Match factors

Results should consider:

- Player attack and defence.
- Energy.
- Condition.
- Player intensity.
- Team strength tier.
- Sending-offs and cards.
- Random variation.

Stronger teams should usually perform better, but surprising results must remain possible.

### Match statistics

Track at least:

- Possession.
- Shots.
- Shots on target.
- Saves.
- Misses.
- Corners.
- Fouls.
- Yellow cards.
- Sendings off.
- Penalties awarded.
- In-match penalties scored, saved and missed.
- Goals.
- Extra time.
- Penalty shootout attempts, goals, saves and misses.

---

## 16. Match Events and Commentary

Events should be short, varied, dramatic and use player names where possible.

Player names should appear for:

- Key attacks.
- Shots.
- Goals.
- Fouls.
- Yellow cards.
- Second-yellow sendings off.
- Penalties won.
- Penalties taken.
- Penalties scored, saved or missed.
- Shootout kicks.

Example style:

- P. Blue drives forward for New Metro City.
- R. Chrome slips past one defender.
- Tripper City surge into the final third.
- P. Blue scores for New Metro City!
- Yellow card for J. Vex of Doge City.
- Penalty awarded to Port Hilo!

The frontend should reveal event chains one message at a time and avoid dumping several events simultaneously.


### Live match presentation

The live match view is the most important screen in the product.

It must provide:

- A large, readable main scoreboard.
- Team names, badges, colours and current phase.
- Normal score and a separate penalty-shootout score.
- Current match minute reconstructed from canonical server timestamps.
- A paced current-event presentation.
- Recent event history.
- Match statistics.
- A compact live ticker showing the scores and phases of every other fixture in the round.
- Fast controls for jumping directly into another match.
- Catch-up, resume and skip-to-result behaviour that never changes the authoritative match state.

Opening a match must never restart it. Leaving a match must never pause it. The tournament and every fixture continue automatically if the player does nothing.

### Current-round master scoreboard

Provide a dedicated mobile-first scoreboard showing every fixture in the current round.

Each fixture shows:

- Both teams.
- Current normal score.
- Separate shootout score where applicable.
- Current minute or phase.
- Scheduled, live, half-time, extra-time, shootout or finished status.
- A clear action for opening that match.

The scoreboard updates smoothly and must remain usable at narrow mobile widths without horizontal page overflow.

### Visual direction and assets

The live view should feel like a cyberpunk sports broadcast rather than a generic dashboard.

Use engaging but performant animation for:

- Goals.
- Cards.
- Normal penalties.
- Saves and misses.
- Extra-time transitions.
- Shootout walk-ups, kicks, results and decisive reactions.

Use transforms and opacity where possible, respect reduced-motion preferences and keep the match readable on lower-powered mobile devices.

Use Grok Imagine to create a coherent original image pack for the app, including team badges, cyberpunk five-a-side arenas, match broadcast backgrounds, cyborg-player action imagery, normal-penalty scenes and shootout-pressure scenes. Optimise images for the web, save them locally in the project and do not depend on temporary remote URLs.

### Penalty presentation

Normal penalties and penalty shootouts must be dramatic, readable and clearly distinct.

A normal penalty should use a paced sequence:

1. Penalty awarded.
2. Player walk-up.
3. Tension hold.
4. Kick.
5. Goal, save or miss.
6. Correct normal-score update.
7. Kickoff restart only after a scored in-match penalty and only when the period has not ended.

A shootout should use a paced alternating sequence with a dedicated shootout scoreboard, pressure messages, saves, misses, sudden death and a decisive winner reaction.

Do not reveal several penalty events simultaneously.

---

## 17. Critical Score and Match Rules

These rules must never be broken:

1. Goal messages appear before, or at the same time as, score changes.
2. Final match messages do not appear before the match is actually complete.
3. In-match penalty goals update the normal match score exactly once.
4. Penalty saves and misses do not update the normal score.
5. Shootout scores remain separate from the normal full-time score.
6. Shootout goals never update the main match score.
7. Shootout events do not generate kickoff-restart events.
8. Extra time and penalty shootouts only occur when required.
9. The winning team progresses exactly once.
10. Round progression remains stable and idempotent.
11. Rewards and betting payouts are settled exactly once.

---

## 18. Records and History

Track current-tournament and all-time data.

### Team records

- Matches played.
- Wins.
- Draws.
- Losses.
- Goals for.
- Goals against.
- Shootout wins.
- Shootout losses.
- Proball appearances.
- Round of 16 exits.
- Quarter-final appearances.
- Semi-final appearances.
- Final appearances.
- Championships.
- Best tournament finish.

A match tied after extra time may count as a draw in standard W/D/L records, while the shootout winner progresses and receives a separate shootout win.

### Player records

- Appearances.
- Goals.
- Fouls.
- Yellow cards.
- Sendings off.
- Penalties scored.
- Penalties missed.
- Shootout goals and misses.

### Financial history

- Rewards.
- Upgrade costs.
- Battery purchases.
- Repair costs.
- Bets.
- Betting payouts.

---

## 19. User Accounts, Administration and Career State

Use a PocketBase auth collection for normal user account creation, login, token refresh, password reset and session restoration.

MVP account rules:

- One persistent career per account.
- The user manages one team in their own private 16-team game world.
- The user may select any one of the 16 teams.
- Career reset may be supported with clear destructive confirmation.
- No multiple save slots for the initial version.
- No shared user-controlled tournaments for the initial version.

### Administration

Create a protected in-app administrator area for trusted staff.

Administrators should be able to:

- Search and inspect user accounts.
- Create user accounts.
- Delete user accounts with confirmation.
- Disable or suspend an account if implemented.
- Adjust a user's fictional-credit balance.
- Record every manual money adjustment as a financial transaction.
- Reset or delete a user's career and team data.
- Delete selected completed tournament or match data.
- Configure automatic detailed-data retention for 7, 30 or 90 days, or disable automatic deletion.
- Trigger or inspect cleanup operations.
- Review an immutable admin audit log.

Automatic cleanup must never delete the active tournament, current fixtures, user accounts, permanent team/player progress, financial audit records required for consistency or aggregated all-time records. Its main target is old detailed match-event timelines and redundant completed-tournament detail.

Do not authenticate the browser as a PocketBase `_superuser`. Superuser credentials and impersonation tokens must remain server-side only. The in-app admin UI must call protected custom PocketBase routes that verify a trusted, server-controlled admin role before performing privileged operations.

---

## 20. Required Screens

The initial app should include:

1. Landing page.
2. Sign-up and login.
3. New career and any-team selection.
4. Main manager dashboard.
5. Squad selection screen.
6. Player detail, upgrade, battery and repair screen.
7. Fixtures and knockout bracket screen.
8. Pre-match preparation and betting screen.
9. Current-round master scoreboard showing every live fixture.
10. Live match view with other-score ticker and fast match switching.
11. Match result and rewards screen.
12. Finances and transaction history.
13. Records and tournament history.
14. Settings, including tournament pace, AI progression and user preferences.
15. Protected administrator area for account, money, career-data and retention management.

### Dashboard priorities

The dashboard should clearly show:

- Current tournament and round.
- Next fixture.
- Countdown to the next round.
- Command Charge gauge and next-point timer.
- Credits.
- Squad energy and condition warnings.
- Recent result.
- Available management actions.
- Current-round scoreboard or ticker.
- A clear route into any live fixture.
- Short tournament bracket status.

---

## 21. UI Style

The UI should be:

- Mobile-first.
- Fast and readable.
- Energetic.
- Cyberpunk sports themed.
- Slightly futuristic.
- Suitable for short mobile sessions.
- Clear rather than overloaded.
- Distinct from a generic SaaS dashboard.

Use strong sports typography, compact cards, clear progress gauges, team colour accents, readable countdowns and restrained animation.

Desktop can use more horizontal space, but mobile remains the priority.

---

## 22. Technology Stack

### Frontend

- Vite.
- React.
- TypeScript preferred.
- Tailwind CSS.
- PocketBase JavaScript SDK.
- Mobile-first responsive design.

### Backend and persistence

Use the existing PocketBase installation on the user's VPS as the application backend:

- PocketBase auth collections for user accounts.
- PocketBase regular collections backed by embedded SQLite.
- PocketBase collection API rules for record-level access control.
- PocketBase JavaScript server hooks and custom routes for trusted game mutations.
- PocketBase built-in scheduled jobs for due-round progression, retention cleanup and backups.
- PocketBase Realtime subscriptions over SSE for important record updates.
- PocketBase file storage for locally hosted game assets only where useful.
- `pb_migrations` committed to source control.
- `pb_data` excluded from source control and protected by backups.

The production app will be deployed to the user's VPS. PocketBase should run as a managed service and sit behind Nginx with HTTPS and correct proxy headers.

Do not add Supabase. Do not add a separate Node/Express API unless a proven requirement cannot be implemented safely and maintainably through PocketBase's server extensions.

Because PocketBase is under active development, pin the deployed version, review its changelog before upgrades and test migrations and backups before changing production.

---

## 23. Frontend-Heavy Architecture

Use the frontend for most presentation and non-sensitive calculations.

### Frontend responsibilities

- Countdown display.
- Smooth Command Charge gauge animation.
- Timestamp-derived energy display.
- Live match event replay and pacing.
- UI state and navigation.
- Local notifications and animations.
- Charts, records and summaries.
- Optimistic visual feedback where safe.

### Trusted backend responsibilities

The following must be validated or executed through PocketBase server hooks, custom routes or transactional server-side collection operations:

- Creating and advancing tournaments.
- Match outcome generation.
- Writing official match results.
- Rewards and financial transactions.
- Upgrade purchases.
- Battery and repair purchases.
- Command Charge spending.
- Bet placement, stake deduction and settlement.
- Ensuring operations occur only once.

Do not trust browser-provided balances, outcomes, elapsed time or payouts.

---

## 24. PocketBase VPS Runtime Strategy

The game uses the existing PocketBase installation on the user's VPS. It is not constrained by a third-party backend free tier, but it must still use CPU, memory, SQLite writes and disk space responsibly.

### Runtime efficiency rules

- Do not run a backend loop for every visible match minute.
- Do not write regenerating energy, Command Charge or match clocks every few seconds.
- Store canonical timestamps and calculate current values when read or spent.
- Generate complete authoritative match timelines once, then reveal them from the frontend according to event offsets.
- Use one PocketBase scheduled job for due-round checks rather than one job per user.
- Process only careers whose `next_round_at` is due.
- Make round processing idempotent, transactional and safe to retry.
- Use PocketBase Realtime for meaningful create/update/delete changes, not every visual timer tick.
- Use a lightweight protected scoreboard/current-events endpoint, polled at a sensible interval such as every 2–4 seconds while a round is live, to provide near-real-time scores without writing every clock tick.
- Return server time with live responses so clients can correct local clock drift.
- Keep hidden timelines inaccessible through normal collection APIs.
- Keep event payloads compact and index/filter the collections used by current-round and due-career queries.
- Store full event timelines for user-visible matches and apply retention rules to old detailed data.

### Scheduled progression

Recommended approach:

- Register one PocketBase app-level scheduled job that runs approximately once per minute.
- The job finds due careers in small batches.
- It claims or locks each due career before processing.
- It advances each relevant tournament round at most once.
- App load may call the same protected catch-up path for the current career.
- Cron and app-load catch-up must be safe when they occur at the same time.

### Deployment and operations

- Run PocketBase under systemd or another reliable process manager.
- Place it behind Nginx and HTTPS.
- Configure trusted proxy headers so PocketBase records the correct client IP.
- Keep the database and uploaded files in `pb_data`.
- Use PocketBase's built-in backup system or a tested VPS-level backup process.
- Schedule automatic backups and retain multiple recent snapshots.
- Test restore procedures before production launch.
- Commit `pb_migrations` and apply them predictably during deployment.
- Keep Grok Imagine-generated web assets in the frontend repository where practical rather than bloating database records.

---

## 25. High-Level Data Model

The exact PocketBase collection design may be refined during implementation, but it should cover:

- `profiles`
- `careers`
- `career_settings`
- `teams`
- `career_teams`
- `players`
- `player_match_settings`
- `tournaments`
- `tournament_entries`
- `fixtures`
- `matches`
- `match_events`
- `match_statistics`
- `bets`
- `financial_transactions`
- `team_records`
- `player_records`
- `command_charge_state`
- `app_settings`
- `admin_audit_logs`
- `retention_runs`

Use PocketBase relation fields, required fields, validation rules, unique indexes where supported, timestamps and server-side consistency checks.

Store event timelines either as compact ordered event records or a compact JSON field associated with a match. Prefer ordered event records when they improve live reconstruction and retention cleanup, while avoiding unnecessary duplication.

---

## 26. Security Rules

- Configure PocketBase list, view, create, update and delete API rules on every exposed collection.
- Normal users may only access records belonging to their own account and career, except intentionally public reference data.
- Public team templates may be readable but not writable by normal users.
- Never expose PocketBase `_superuser` credentials, passwords or impersonation tokens in frontend code.
- Do not log the browser into `_superusers` for the in-app admin area.
- Validate authentication, ownership and trusted admin status inside every custom privileged route.
- Prevent normal users from changing protected fields such as role, credits, official match results, winnings, progression versions or settlement flags.
- Deny normal direct access to unrevealed match events and unfinished authoritative final scores.
- Serve live scoreboard snapshots and due event batches through protected custom routes that calculate visibility from PocketBase server time.
- Use server hooks to reject unauthorised protected-field changes even if a collection rule is misconfigured.
- Use SQLite transactions and unique/version fields to prevent negative balances, duplicate match processing, repeated rewards and repeated bet settlement.
- Rate-limit sensitive routes such as authentication, bets, purchases, catch-up and admin mutations.
- Record privileged admin actions in an immutable audit collection.
- Keep PocketBase and its host system patched, but pin and test versions before production upgrades.

---

## 27. Testing Expectations

Tests should protect real gameplay behaviour.

### Essential tests

- Account and career creation.
- Any of the 16 teams can be selected at career creation.
- Valid starting-five selection.
- Energy and condition modifiers.
- Passive, Balanced and Aggressive intensity effects.
- Timestamp-based Command Charge regeneration.
- Command Charge cannot be overspent.
- Credits cannot become negative.
- Upgrade prices and caps.
- Bet locking and settlement.
- A user cannot bet on both sides of one fixture.
- A user cannot bet on the fixture involving their managed team.
- Match outcome integrity.
- Goal-message and score synchronisation.
- Extra time and shootout rules.
- Separate normal and shootout scores.
- Idempotent round advancement.
- Rewards and bets settle once.
- Eliminated-team behaviour.
- Tournament restarts correctly.
- Offline catch-up works.
- Unfinished fixtures never expose future events or hidden final scores.
- Opening a live match late reconstructs the correct minute, score and revealed events.
- Switching between live matches never restarts or pauses them.
- Other-match scores update while watching one fixture.
- The master scoreboard shows all current-round fixtures correctly.
- Normal penalties and shootouts reveal events in the correct order.
- Admin routes reject normal users.
- Admin money adjustments create both a balance change and audit record.
- Retention cleanup preserves active tournaments and aggregated records.
- PocketBase collection rules prevent cross-user access.
- Full tournament simulation from Round of 16 to champion.

---

## 28. MVP Includes

- PocketBase authentication.
- One career per user.
- 16-team repeating knockout championship.
- One user-managed team selected from any of the 16 teams.
- 15 AI teams.
- Seven-player cyborg squads.
- Starting-five selection.
- Attack, defence, energy and condition.
- Player upgrades.
- Batteries and repairs.
- Passive, Balanced and Aggressive player intensity.
- Command Charge timer mechanic.
- Configurable time between rounds.
- Persistent countdowns and offline catch-up.
- Autonomous simultaneous current-round matches.
- Current-round master scoreboard.
- Ability to watch any match and jump between live fixtures.
- Live other-score updates while watching a fixture.
- Minute-based match simulation and frontend live reconstruction/replay.
- Rich match events, imagery, animations and statistics.
- Extra time and shootouts.
- Rewards, transactions and records.
- Fictional-credit winner betting on other fixtures.
- Protected account and data administration.
- Configurable 7, 30 or 90-day detailed-data retention.
- Mobile-first cyberpunk interface focused on the live match view.

---

## 29. Out of Scope for MVP

Do not add these unless explicitly requested later:

- Real-money gambling or payments.
- Cash withdrawals.
- Cryptocurrency or blockchain.
- Multiplayer user-versus-user tournaments.
- Shared global leagues.
- Player transfer market.
- Player contracts or wages.
- Stadium management.
- Sponsorship negotiations.
- Deep formations.
- Complex training schedules.
- Staff hiring beyond simple mechanics/repair actions.
- Multiple save slots.
- Full football-manager complexity.
- Native mobile apps.

---

## 30. Development Priorities

Build in this order:

1. PocketBase collections, migrations, authentication and collection rules.
2. Career creation with selection of any team.
3. Canonical tournament timing and simultaneous current-round fixtures.
4. Reliable trusted match simulation and stored event timelines.
5. Main current-round scoreboard and live reconstruction of all matches.
6. Engaging mobile live-match view, match switching, other-score ticker and penalty presentation.
7. Round advancement, scheduled processing and offline catch-up.
8. Squad selection, intensity, energy and condition.
9. Rewards, upgrades, batteries and repairs.
10. Command Charge timer mechanic.
11. Betting and settlement for other fixtures.
12. Records, history, admin tools and retention cleanup.
13. Grok Imagine asset integration, mobile performance polish and balancing.
14. VPS deployment, backups, restore test and production audit.

The live match view is the product's highest-priority experience, but its visual polish must sit on reliable canonical match and score logic.

---

## 31. MVP Success Criteria

The MVP is successful when:

- A user can sign up, choose any of the 16 teams and start a persistent career.
- A full 16-team tournament runs reliably from Round of 16 to champion.
- A new tournament begins automatically after the configured interval.
- Progress remains correct when the app is closed and reopened.
- The user can manage seven cyborgs and select five starters.
- Energy, condition and intensity affect performance.
- Upgrades, batteries and repairs work without invalid balances.
- Command Charge regenerates correctly while offline.
- AI teams maintain themselves and optionally improve slowly.
- Every current-round fixture autoplays from canonical timestamps even when the user does nothing.
- The main scoreboard displays all live fixtures and updates their scores and phases correctly.
- The user can watch any game, jump between games and receive other-score updates without restarting matches.
- Matches produce readable named-player events, engaging mobile animations, coherent imagery and believable statistics.
- Normal penalties and frequent shootouts feel exciting while remaining readable.
- Goals, extra time and shootout scores remain correct.
- Rewards and records persist over repeated tournaments.
- Fictional-credit bets lock and settle correctly.
- PocketBase runtime and SQLite writes remain efficient on the VPS.
- PocketBase collection rules prevent users from accessing another user's career.
- Admin account, money and cleanup actions are protected and audited.
- Automated retention can clean old detailed data without deleting active or permanent records.
- PocketBase backups and restore procedures are tested.
- The mobile interface feels energetic, readable and distinctly cyberpunk.

---

## 32. Implementation status

### Phase 1 (replaced)

Private per-user careers/tournaments. Retained only as historical note; schema leftovers may remain unused.

### Phase 2

- Shared world, claims, incremental sim, coaching, betting.

### Phase 3

- Dual wallets, squad UI, Command Charge, rewards, AI maintain.

### Phase 4 (current) — live flagship UX

- Shared round store (one scoreboard poll for cards, ticker, switcher).
- Event reveal queue: ordered, deduped, paced; catch-up without full replay.
- Visible score from **revealed** events only (goals sync with text).
- Penalty focus + dedicated shootout board; FT score never altered by pens.
- Mobile-first hierarchy; reduced-motion; aria-live for major events.
- Measured KO sample (~19% shootouts) — no forced outcomes.

### Live client rules

- Poll match ~2s, scoreboard ~3s; pause while tab hidden; refresh on focus.
- Stale HTTP responses discarded via request id.
- Switch fixture recreates queue for that fixture; does not pause server sim.

### Phase 5 focus

- Records centre; admin tools; retention; optional per-kick shootout API; Phase 1 table drop.
