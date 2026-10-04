import {createHash} from 'node:crypto';
import {TARGET} from './config.js';

export const UNIT = 125_000;
export const DAY = 86_400_000;
export const RETURN_DAYS = 8;
export type Member = {address:string;ordinal:number};
export type Profile = {
  type:'QUARTERS'|'LATE_QUARTERS'|'EIGHTHS';
  releaseDay:number;quarterDay:number;eighthDay:number|null;
};
export type Contribution = {ownerAddress:string;amountSun:number};
export type PlanStep = {
  kind:'MIX'|'RETURN';from:string;to:string;amountSun:number;day:number;
  plannedAt:Date;allocations:Contribution[];dependsIndex:number|null;
};
export type CampaignPlan = {seed:string;profiles:Profile[];steps:PlanStep[];mixingDays:number;totalDays:number};

function random(seed:string){
  let s=createHash('sha256').update(seed).digest().readUInt32LE(0)||1;
  return()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return (s>>>0)/0x100000000;};
}
function shuffle<T>(items:T[],rnd:()=>number){
  const result=[...items];
  for(let i=result.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[result[i],result[j]]=[result[j],result[i]];}
  return result;
}
function granularity(profile:Profile,day:number){
  if(day<profile.releaseDay)return 8;
  if(day<profile.quarterDay)return 4;
  return profile.eighthDay!==null&&day>=profile.eighthDay?1:2;
}

/** Integral knapsack: favor owners whose event and branching counts lag
 * behind the mean, then combine contributions and favor new counterparties.
 * The incoming packet always remains a feasible fallback in a daily cycle. */
function packet(stock:number[],units:number,day:number,profiles:Profile[],events:number[],splits:number[],merges:number[],
  visited:Set<number>[],destination:number,destinationStock:number[],rnd:()=>number):number[]|null{
  const average=(items:number[])=>items.reduce((a,b)=>a+b,0)/items.length;
  const meanEvents=average(events),meanSplits=average(splits),meanMerges=average(merges);
  let dp:(null|{score:number;parts:number[]})[]=Array(units+1).fill(null);
  dp[0]={score:0,parts:Array(stock.length).fill(0)};
  for(let owner=0;owner<stock.length;owner++){
    const next=dp.map(x=>x&&{score:x.score,parts:[...x.parts]});
    const g=granularity(profiles[owner],day);
    for(let used=0;used<=units;used++)if(dp[used]){
      for(let count=g;count<=Math.min(stock[owner],units-used);count+=g){
        // Balance original-stake histories, rather than only sender counts.
        // Late/coarse owners get priority; overused tiny shares can wait.
        const score=dp[used]!.score+80+25*(meanEvents-events[owner])
          +(count<stock[owner]?12+25*(meanSplits-splits[owner]):0)
          +(destinationStock[owner]>0?8+12*(meanMerges-merges[owner]):0)
          +(visited[owner].has(destination)?0:3)+rnd()*3;
        if(!next[used+count]||score>next[used+count]!.score){
          const parts=[...dp[used]!.parts];parts[owner]=count;
          next[used+count]={score,parts};
        }
      }
    }
    dp=next;
  }
  return dp[units]?.parts??null;
}

/** Fixed, reproducible complete plan. Every mixing round is a random cycle:
 * one outgoing and one incoming native packet per member. The common packet
 * size preserves 1 TRX at round boundaries; its ownership composition varies.
 * Individual release/split dates differ and coarse owners never acquire
 * eighth-sized contributions. Closing transfers return attributed shares. */
export function buildCampaignPlan(members:Member[],seed:string,startedAt:Date,totalDays=36):CampaignPlan{
  if(members.length<2||members.length>17||new Set(members.map(m=>m.address)).size!==members.length)
    throw Error('A campaign needs 2–17 distinct members');
  if(!Number.isInteger(totalDays)||totalDays<18||totalDays>60||!Number.isFinite(startedAt.getTime()))
    throw Error('Campaign length must be 18–60 days');
  const n=members.length,mixingDays=totalDays-RETURN_DAYS,rnd=random(seed);
  const types=shuffle(Array.from({length:n},(_,i)=>(['EIGHTHS','QUARTERS','LATE_QUARTERS'] as const)[i%3]),rnd);
  const integer=(lo:number,hi:number)=>lo+Math.floor(rnd()*(hi-lo+1));
  const profiles:Profile[]=types.map(type=>{
    const releaseDay=integer(1,Math.max(2,Math.min(4,Math.floor(mixingDays*.16))));
    const quarterDay=type==='QUARTERS'?releaseDay:type==='LATE_QUARTERS'?
      integer(Math.ceil(mixingDays*.32),Math.ceil(mixingDays*.55)):Math.min(mixingDays-2,releaseDay+integer(1,4));
    return {type,releaseDay,quarterDay,eighthDay:type==='EIGHTHS'?
      integer(quarterDay+1,Math.max(quarterDay+1,Math.ceil(mixingDays*.7))):null};
  });
  const firstOwner=integer(0,n-1);
  profiles[firstOwner].releaseDay=1;
  if(profiles[firstOwner].type==='QUARTERS')profiles[firstOwner].quarterDay=1;
  const stock:number[][]=Array.from({length:n},(_,holder)=>Array.from({length:n},(_,owner)=>holder===owner?8:0));
  const events=Array(n).fill(0),splits=Array(n).fill(0),merges=Array(n).fill(0),visited=Array.from({length:n},(_,i)=>new Set([i]));
  const steps:PlanStep[]=[];
  for(let day=1;day<=mixingDays;day++){
    const all=Array.from({length:n},(_,i)=>i);
    const sizes=day<5?[4,6]:[4,6,8];
    const eligible=shuffle(all.filter(h=>sizes.some(q=>packet(stock[h],q,day,profiles,events,splits,merges,visited,h,stock[h],rnd)!==null)),rnd);
    if(!eligible.length)throw Error('No feasible packet at the start of a round');
    // Several changing cycles can have different native amounts on the same
    // day. Each cycle has an eligible anchor and at least two wallets.
    const groupCount=integer(1,Math.min(eligible.length,Math.floor(n/2)));
    const anchors=eligible.slice(0,groupCount),groups=anchors.map(a=>[a]);
    const others=shuffle(all.filter(h=>!anchors.includes(h)),rnd);
    for(let i=0;i<groupCount;i++)groups[i].push(others.pop()!);
    for(const h of others)groups[integer(0,groupCount-1)].push(h);
    const cycles:PlanStep[][]=[];
    for(const group of groups){
      let order=shuffle(group,rnd),units=4,first:number[]|null=null;
      outer:for(const size of shuffle(day<5?[4,6,6]:[4,6,6,8,8],rnd))for(let i=0;i<order.length;i++){
        const rotated=[...order.slice(i),...order.slice(0,i)];
        const candidate=packet(stock[rotated[0]],size,day,profiles,events,splits,merges,visited,rotated[1],stock[rotated[1]],rnd);
        if(candidate){order=rotated;units=size;first=candidate;break outer;}
      }
      if(!first)throw Error('Cycle lost its eligible anchor');
      const cycle:PlanStep[]=[];
      for(let position=0;position<order.length;position++){
        const from=order[position],to=order[(position+1)%order.length];
        const parts=position===0?first:packet(stock[from],units,day,profiles,events,splits,merges,visited,to,stock[to],rnd);
        if(!parts)throw Error('Incoming packet fallback was lost');
        const allocations=parts.flatMap((count,owner)=>count?[{ownerAddress:members[owner].address,amountSun:count*UNIT}]:[]);
        for(let owner=0;owner<n;owner++){
          if(parts[owner]){
            events[owner]++;
            if(stock[from][owner]>parts[owner])splits[owner]++;
            if(stock[to][owner]>0)merges[owner]++;
          }
          stock[from][owner]-=parts[owner];stock[to][owner]+=parts[owner];
          if(stock[from][owner]<0)throw Error('Planner overspent an ownership position');
          if(parts[owner])visited[owner].add(to);
        }
        cycle.push({kind:'MIX',from:members[from].address,to:members[to].address,amountSun:units*UNIT,
          day,plannedAt:new Date(0),allocations,dependsIndex:null});
      }
      cycles.push(cycle);
    }
    let clock=startedAt.getTime()+(day-1)*DAY+integer(0,45)*60_000;
    while(cycles.some(c=>c.length)){
      const remaining=cycles.filter(c=>c.length),cycle=remaining[integer(0,remaining.length-1)],step=cycle.shift()!;
      step.plannedAt=new Date(clock);step.dependsIndex=steps.length?steps.length-1:null;steps.push(step);
      clock+=integer(60,120)*1000; // preview for a full quota; runtime extends to 5–10 minutes when needed
    }
    if(stock.some(row=>row.reduce((a,b)=>a+b,0)!==8))throw Error('Daily cycle failed to preserve wallet balances');
  }
  // At round boundaries each holder has eight units. Grouping all of one
  // owner's units into one return needs at most eight outgoing sends/holder.
  const lastMix=steps.length-1;
  const closing:PlanStep[]=[];
  for(let holder=0;holder<n;holder++){
    const owners=shuffle(Array.from({length:n},(_,i)=>i).filter(owner=>owner!==holder&&stock[holder][owner]>0),rnd);
    for(let i=0;i<owners.length;i++){
      const owner=owners[i],amountSun=stock[holder][owner]*UNIT,day=mixingDays+1+i;
      closing.push({kind:'RETURN',from:members[holder].address,to:members[owner].address,amountSun,day,
        plannedAt:new Date(startedAt.getTime()+(day-1)*DAY+integer(0,90)*60_000),
        allocations:[{ownerAddress:members[owner].address,amountSun}],dependsIndex:lastMix});
      stock[owner][owner]+=stock[holder][owner];stock[holder][owner]=0;
    }
  }
  closing.sort((a,b)=>a.plannedAt.getTime()-b.plannedAt.getTime());
  const lastSender=new Map<string,number>();
  for(let i=0;i<steps.length;i++)lastSender.set(steps[i].from,i);
  for(const step of closing){step.dependsIndex=lastSender.get(step.from)??lastMix;lastSender.set(step.from,steps.length);steps.push(step);}
  if(stock.some((row,h)=>row.some((q,o)=>q!==(h===o?8:0))))throw Error('Not every owner was restored');
  const plan={seed,profiles,steps,mixingDays,totalDays};
  validateCampaignPlan(members,plan);
  return plan;
}

export function validateCampaignPlan(members:Member[],plan:CampaignPlan){
  const holdings=new Map<string,number>(members.flatMap(h=>members.map(o=>[`${h.address}:${o.address}`,h.address===o.address?TARGET:0] as const)));
  const sends=new Map<string,number>();
  const profile=new Map(members.map((m,i)=>[m.address,plan.profiles[i]]));
  for(let i=0;i<plan.steps.length;i++){
    const s=plan.steps[i];
    if(s.from===s.to||!Number.isSafeInteger(s.amountSun)||s.amountSun<=0||s.amountSun!==s.allocations.reduce((a,b)=>a+b.amountSun,0)||
      new Set(s.allocations.map(a=>a.ownerAddress)).size!==s.allocations.length||s.dependsIndex!==null&&s.dependsIndex>=i)
      throw Error('Invalid campaign step');
    for(const a of s.allocations){
      if(!profile.has(a.ownerAddress)||!Number.isSafeInteger(a.amountSun)||a.amountSun<=0||
        a.amountSun%(granularity(profile.get(a.ownerAddress)!,s.day)*UNIT)!==0)throw Error('Invalid contribution granularity');
      const from=`${s.from}:${a.ownerAddress}`,to=`${s.to}:${a.ownerAddress}`;
      if(!holdings.has(from)||!holdings.has(to)||holdings.get(from)!<a.amountSun)throw Error('Invalid ownership balance');
      holdings.set(from,holdings.get(from)!-a.amountSun);holdings.set(to,holdings.get(to)!+a.amountSun);
    }
    const key=`${s.day}:${s.from}`;
    sends.set(key,(sends.get(key)??0)+1);
    if(sends.get(key)!>1)throw Error('More than one outgoing campaign transfer in a day');
  }
  for(const h of members)for(const o of members)if(holdings.get(`${h.address}:${o.address}`)!==(h.address===o.address?TARGET:0))
    throw Error('Campaign does not restore every original stake');
}
