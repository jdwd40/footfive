// #157 management balance harness: B-grade squad vs an identical copy, seeds mg1..N.
// N=10000 node scripts/balance-157/mirror-sim.cjs base agg pas oc aggoc aggattoc aggdl pasdefoc
// HOOKS=/abs/pb_hooks to point at another checkout; PATCH='{"overclockBonus":1.1}' to try a coefficient.
const path=require('path');const R=(process.env.HOOKS||path.resolve(__dirname,'../../pocketbase/pb_hooks'))+'/lib/';process.env.TREE=process.env.TREE||path.basename(path.dirname(R));
const eng=require(R+'matchEngine.js');if(process.env.PATCH){const B=require(R+'balance.js').BALANCE;const P=JSON.parse(process.env.PATCH);for(const k in P){const path=k.split('.');let o=B;while(path.length>1)o=o[path.shift()];o[path[0]]=P[k];}}const {TEAMS}=require(R+'teams.js');
const N=+process.env.N||500;
const T=TEAMS.find(t=>t.grade==='B');
function team(mod){const t={name:'H',abbr:'H',grade:T.grade,stance:'balanced',oc:false,players:T.players.map((p,i)=>({...p,id:'p'+i,is_starter:i<5,energy:100,condition:100,intensity:'balanced'}))};mod&&mod(t);return t;}
function run(label,homeMod,coach,awayMod){let w=0,d=0,l=0,W=0,gf=0,ga=0,et=0,so=0,g120=0;
for(let s=1;s<=N;s++){const away={...team(awayMod),name:'A',abbr:'A'};
 const st=eng.createMatch({fixtureId:'f'+s,seed:eng.hashSeed('mg'+s),kickoffAt:0,timing:eng.buildTiming(8000,1),home:team(homeMod),away});
 let ft=null,used=0;
 while(st.phase!=='finished'){ if(!ft&&['et_break','shootout','finished','extra_time_1'].includes(st.phase))ft=[...st.score];
  if(coach&&eng.LIVE_PHASES.includes(st.phase)&&used<4){const want=coach(st);if(want&&want!==(st.pending.home||st.teams.home.stance)){eng.queueStance(st,'home',want);used++;}}
  eng.advanceTo(st,st.nextAt);}
 if(!ft)ft=[...st.score];gf+=ft[0];ga+=ft[1];
 if(ft[0]>ft[1])w++;else if(ft[0]<ft[1])l++;else d++; if(st.winner==='home'||st.winner===st.teams.home.id)W++;}
const p=x=>+(100*x/N).toFixed(1);
console.log(JSON.stringify({tree:process.env.TREE,N,label,w:p(w),d:p(d),l:p(l),gf:+(gf/N).toFixed(3),ga:+(ga/N).toFixed(3),tot:+((gf+ga)/N).toFixed(3),adv:p(W)}));}
const all=f=>t=>t.players.forEach(f);
const and=(...fs)=>t=>fs.forEach(f=>f&&f(t));
const OC=t=>{t.oc=true;t.players.forEach(p=>p.is_starter&&(p.energy=Math.max(0,p.energy-8)))};
const ATT=t=>t.stance='attack', DEF=t=>t.stance='defend';
const AGG=all(p=>p.intensity='aggressive'), PAS=all(p=>p.intensity='passive');
const AI=t=>{t.ai=true};
const chase=st=>{const m=st.minute+1,a=st.score[0],b=st.score[1];if(m>=70&&a<b)return'attack';if(m>=78&&a===b+1)return'defend';return 'balanced';};
const dl=st=>st.score[0]>st.score[1]?'defend':st.score[0]<st.score[1]?'attack':'balanced';
const chase60=st=>{const a=st.score[0],b=st.score[1];if(st.minute+1>=60&&a<b)return'attack';return 'balanced';};
const lead_def=st=>st.score[0]>st.score[1]?'defend':'balanced';
const ROWS={
 base:['baseline (mirror, B grade)'],
 att:['default stance attack',ATT],
 def:['default stance defend',DEF],
 agg:['all starters aggressive',AGG],
 pas:['all starters passive',PAS],
 oc:['overclock (-8 energy)',OC],
 e60:['starters energy 60',all(p=>p.energy=60)],
 e78:['energy 60 +rapid charge (78)',all(p=>p.energy=78)],
 e100:['energy 60 +battery (100)',all(p=>p.energy=100)],
 c50:['starters condition 50',all(p=>p.condition=50)],
 c65:['cond 50 + field repair (65)',all(p=>p.condition=65)],
 worst:['worst lineup (2 subs in)',t=>{t.players[5].is_starter=true;t.players[6].is_starter=true;t.players[0].is_starter=false;t.players[1].is_starter=false}],
 up10:['upgrade +10 atk on 3 outfield',t=>t.players.slice(0,3).forEach(p=>p.attack+=10)],
 up1:['upgrade +1 atk one player',t=>t.players[0].attack+=1],
 up5all:['upgrade +5 atk&def all 5 starters',t=>t.players.slice(0,5).forEach(p=>{p.attack+=5;p.defence+=5})],
 chase:['live: chase when behind 70+',null,chase],
 dl:['live: defend leading/attack trailing',null,dl],
 att1:['live: attack from 1\'',null,()=>'attack'],
 chase60:['live: attack when behind 60+',null,chase60],
 leaddef:['live: defend whenever leading',null,lead_def],
 // combos
 pasdefoc:['combo passive+defend+OC',and(PAS,DEF,OC)],
 aggattoc:['combo aggressive+attack+OC',and(AGG,ATT,OC)],
 aggchase:['combo aggressive + chase 70+',AGG,chase],
 pasdl:['combo passive + defend-lead/attack-trail',PAS,dl],
 aggdl:['combo aggressive + defend-lead/attack-trail',AGG,dl],
 ocdl:['combo OC + defend-lead/attack-trail',OC,dl],
 pasdef:['combo passive+defend',and(PAS,DEF)],
 aggatt:['combo aggressive+attack',and(AGG,ATT)],
 aggoc:['combo aggressive+OC',and(AGG,OC)],
 pasoc:['combo passive+OC',and(PAS,OC)],
 e60oc:['energy 60 + OC (52)',and(all(p=>p.energy=60),OC)],
 bothatt:['both teams attack stance (goals)',ATT,null,ATT],
 bothdef:['both teams defend stance (goals)',DEF,null,DEF],
 // vs AI-controlled opponent (aiStance chases)
 aibase:['vs AI opp: baseline',null,null,AI],
 aichase:['vs AI opp: chase 70+',null,chase,AI],
 aidl:['vs AI opp: defend-lead/attack-trail',null,dl,AI],
 aiatt:['vs AI opp: default attack',ATT,null,AI],
 aidef:['vs AI opp: default defend',DEF,null,AI],
 aipas:['vs AI opp: all passive',PAS,null,AI],
 aiagg:['vs AI opp: all aggressive',AGG,null,AI],
 aipasdl:['vs AI opp: passive + DL coach',PAS,dl,AI],
 aiai:['AI vs AI (mirror)',AI,null,AI],
};
for(const k of process.argv.slice(2)){const r=ROWS[k];if(!r){console.error('no row',k);continue;}run(r[0],r[1],r[2],r[3]);}
