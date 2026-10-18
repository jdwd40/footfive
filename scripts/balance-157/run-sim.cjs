// #157 4-round knockout run: energy/condition carried, +REGEN energy between rounds (default 5),
// 1.6 Command Charge regained per round, opponent is AI-controlled with the beaten side's fatigue.
// N=10000 node scripts/balance-157/run-sim.cjs bal agg pas oc aggoc aggocdl ocdl agg_att pasdef_oc
const path=require('path');const R=(process.env.HOOKS||path.resolve(__dirname,'../../pocketbase/pb_hooks'))+'/lib/';process.env.TREE=process.env.TREE||path.basename(path.dirname(R));
const eng=require(R+'matchEngine.js');if(process.env.PATCH){const B=require(R+'balance.js').BALANCE;const P=JSON.parse(process.env.PATCH);for(const k in P){const path=k.split('.');let o=B;while(path.length>1)o=o[path.shift()];o[path[0]]=P[k];}}const {TEAMS}=require(R+'teams.js');
const N=+process.env.N||3000, REGEN=+(process.env.REGEN??5);
const T=TEAMS.find(t=>t.grade==='B');
const fresh=()=>T.players.map((p,i)=>({...p,id:'p'+i,is_starter:i<5,energy:100,condition:100,intensity:'balanced'}));
const chase=st=>{const m=st.minute+1,a=st.score[0],b=st.score[1];if(m>=70&&a<b)return'attack';if(m>=78&&a===b+1)return'defend';return 'balanced';};
const dl=st=>st.score[0]>st.score[1]?'defend':st.score[0]<st.score[1]?'attack':'balanced';
const S={
 bal:{}, agg:{int:'aggressive'}, pas:{int:'passive'}, oc:{oc:'every'}, oc2:{oc:'alt'},
 dl:{coach:dl}, aggdl:{int:'aggressive',coach:dl}, aggoc:{int:'aggressive',oc:'every'}, aggocdl:{int:'aggressive',oc:'every',coach:dl},
 ocdl:{oc:'every',coach:dl}, agg_att:{int:'aggressive',stance:'attack',oc:'every'},
 pasdef_oc:{int:'passive',stance:'defend',oc:'every'},
 agg_r1pas:{intByRound:['passive','aggressive','aggressive','aggressive']},
 aggF:{intByRound:['balanced','balanced','aggressive','aggressive']},
};
function play(home,away,opts,seed){
 const st=eng.createMatch({fixtureId:'g'+seed,seed:eng.hashSeed(seed),kickoffAt:0,timing:eng.buildTiming(8000,1),
  home:{name:'H',abbr:'H',grade:'B',stance:opts.stance||'balanced',oc:!!opts.ocNow,players:home},
  away:{name:'A',abbr:'A',grade:'B',stance:'balanced',ai:true,players:away}});
 let used=0;
 while(st.phase!=='finished'){ if(opts.coach&&eng.LIVE_PHASES.includes(st.phase)&&used<4){const w=opts.coach(st);if(w&&w!==(st.pending.home||st.teams.home.stance)){eng.queueStance(st,'home',w);used++;}} eng.advanceTo(st,st.nextAt);}
 const win=st.winner==='home'||st.winner===st.teams.home.id;
 const carry=(src,orig)=>orig.map(p=>{const q=src.find(x=>x.id===p.id);return q?{...p,energy:Math.round(q.energy),condition:Math.max(0,Math.round(q.condition - (q.sentOff?8:0)))}:p;});
 return {win,home:carry(st.teams.home.players,home),away:carry(st.teams.away.players,away),gf:st.score[0],ga:st.score[1]};
}
for(const k of process.argv.slice(2)){const s=S[k];let reach=[0,0,0,0,0],condLost=0,ocUsed=0,goals=0,games=0;
 for(let i=1;i<=N;i++){let me=fresh(),opp=fresh(),charges=5;
  for(let r=0;r<4;r++){reach[r]++;
   const int=s.intByRound?s.intByRound[r]:(s.int||'balanced');
   me.forEach(p=>p.intensity=int);
   let ocNow=false; if(s.oc==='every'&&charges>=2)ocNow=true; if(s.oc==='alt'&&r%2===0&&charges>=2)ocNow=true;
   if(ocNow){charges-=2;ocUsed++;me.forEach(p=>{if(p.is_starter)p.energy=Math.max(0,p.energy-8)});}
   const res=play(me,opp,{...s,ocNow},'gt'+k.length+'-'+i+'-'+r);
   games++;goals+=res.gf+res.ga;
   // carry: me, opponent = winner-of-other-tie proxy (the away side's state, balanced/AI)
   me=res.home; opp=res.away.map(p=>({...p,intensity:'balanced'}));
   me.forEach(p=>p.energy=Math.min(100,p.energy+REGEN)); opp.forEach(p=>p.energy=Math.min(100,p.energy+REGEN));
   charges=Math.min(5,charges+1.6);
   if(!res.win)break; if(r===3)reach[4]++;}
  condLost+=me.slice(0,7).reduce((a,p)=>a+(100-p.condition),0);}
 const p=x=>(100*x/N).toFixed(1);
 console.log(JSON.stringify({tree:process.env.TREE,REGEN,strat:k,QF:p(reach[1]),SF:p(reach[2]),F:p(reach[3]),champ:p(reach[4]),wins:((reach[1]+reach[2]+reach[3]+reach[4])/N).toFixed(3),condLostPerRun:(condLost/N).toFixed(1),repairCost:Math.round(12*condLost/N),ocPerRun:(ocUsed/N).toFixed(2),goalsPerGame:(goals/games).toFixed(2)}));}
