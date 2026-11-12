// Measure in-play odds in PocketBase's actual goja runtime with a disposable database.
// node scripts/inplay-goja-bench.mjs [root=repo] [ai|manager|both]
// POCKETBASE_BIN=/path/to/pocketbase overrides root/pocketbase/pocketbase. No browser or live database is used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createServer } from "node:net";

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const mode = process.argv[3] || "ai";
if (!["ai", "manager", "both"].includes(mode)) throw new Error("mode must be ai, manager or both");
const binary = process.env.POCKETBASE_BIN || path.join(root, "pocketbase/pocketbase");
fs.accessSync(binary, fs.constants.X_OK);
const require = createRequire(path.join(root, "package.json"));
const lib = (f) => require(path.join(root, "pocketbase/pb_hooks/lib", f));
const eng = lib("matchEngine.js"), { TEAMS } = lib("teams.js"), { defaultStarters } = lib("tournament.js");
const team = (i, ai) => {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players), ai, stance: "balanced" };
};
const models = [];
for (let h = 0; h < 16; h++) for (let a = h + 1; a < 16; a++) {
  models.push(eng.inPlayModel(eng.createMatch({ fixtureId: "b", seed: 1, kickoffAt: 0, home: team(h, mode === "ai"), away: team(a, mode !== "both") })));
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ff-goja-228-"));
let child;
try {
  const hooks = path.join(tmp, "hooks"), migrations = path.join(tmp, "migrations"), data = path.join(tmp, "data");
  fs.mkdirSync(hooks);
  fs.mkdirSync(migrations);
  fs.cpSync(path.join(root, "pocketbase/pb_hooks/lib"), path.join(hooks, "lib"), { recursive: true });
  fs.writeFileSync(path.join(hooks, "bench.pb.js"), `routerAdd('POST','/bench',function(e){
    var o=require(__hooks+'/lib/odds.js');var ms=e.requestInfo().body.models;
    var st={ph:'second_half',sc:[1,0],x:[[0,0,0,0,0,0],[0,0,0,0,0,0]],cs:['attack','balanced']};
    var cold=0,warm=0;var trials=20;var encoded=JSON.stringify(ms[0]);
    for(var i=0;i<trials;i++){
      o._clearCache();var t=Date.now();o.marketProbs(ms[0],st,75);cold+=Date.now()-t;
      t=Date.now();for(var j=0;j<100;j++)o.marketProbs(ms[0],st,75);warm+=Date.now()-t;
    }
    o.marketProbs(ms[0],st,75);var t3=Date.now();
    for(var z=0;z<200;z++)o.marketProbs(JSON.parse(encoded),st,75);
    var parsedWarm=(Date.now()-t3)/200;
    o._clearCache();var t2=Date.now();for(var k=0;k<ms.length;k++)o.pairQualify(ms[k]);
    return e.json(200,{coldMs:cold/trials,warmMs:warm/(trials*100),pairs120Ms:Date.now()-t2,trials:trials,parsedWarmMs:parsedWarm,modelBytes:encoded.length});
  });`);
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const directories = ["--dir=" + data, "--hooksDir=" + hooks, "--migrationsDir=" + migrations];
  // A fresh PocketBase server auto-opens its installer when it has no superuser. Create one before serve to suppress it.
  execFileSync(binary, ["superuser", "create", "bench@example.invalid", randomBytes(24).toString("hex"), ...directories], { stdio: "ignore" });
  child = spawn(binary, ["serve", "--http=127.0.0.1:" + port, ...directories], { stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (d) => { logs += d; });
  child.stderr.on("data", (d) => { logs += d; });
  let healthy = false;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { const response = await fetch("http://127.0.0.1:" + port + "/api/health"); if (response.ok) { healthy = true; break; } } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!healthy) throw new Error("Disposable PocketBase did not become healthy: " + logs);
  const response = await fetch("http://127.0.0.1:" + port + "/bench", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ models }), signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result) + logs);
  console.log(JSON.stringify({ root, mode, ...result }));
} finally {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  fs.rmSync(tmp, { recursive: true, force: true });
}
