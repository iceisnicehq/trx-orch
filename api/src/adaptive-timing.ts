import {randomInt} from 'node:crypto';
import {bufferedReadyAt,projectedFree,type ForecastSpend} from './recovery.js';
import {DAY} from './campaign-plan.js';
import type {BandwidthSnapshot} from './tron.js';

export const ADAPTIVE_BANDWIDTH=407;
export const RESOURCE_PROBE_MS=5*60_000;
export type TimingSlot={id:string;from:string;sequence:number;pacingDelayMs:number|null;
  resourceReadyAt:Date|null;resourceRequired:number|null};
export type TimingWallet={snapshot:BandwidthSnapshot;spends:ForecastSpend[];cost:number;lastConfirmedAt:number|null};
export const gapRange=(full:boolean)=>full?[60_000,120_000] as const:[300_000,600_000] as const;
export function chooseGap(full:boolean){const [min,max]=gapRange(full);return randomInt(min,max+1);}

/** Forecast only: preserve sequence even when a later sender is ready sooner.
 * Actual sends require approval, confirmed dependencies and fresh free quota.
 * Synthetic future spends use recent observed costs and are replaced after
 * every receipt. Random gaps are returned for durable persistence. */
export function adaptiveMixForecast(slots:TimingSlot[],wallets:Map<string,TimingWallet>,now:number,
  previousAt:number,previousId:string|null,randomGap=chooseGap){
  const frames=new Map([...wallets].map(([address,w])=>[address,{...w,spends:[...w.spends]}]));
  const lastSenderAt=new Map([...frames].flatMap(([address,w])=>w.lastConfirmedAt===null?[]:[[address,w.lastConfirmedAt] as const]));
  const times:{id:string;scheduledAt:Date;pacingDelayMs:number;pacingAfterId:string|null}[]=[];
  let clock=Math.max(now,previousAt),predecessor=previousId;
  for(const [i,slot] of [...slots].sort((a,b)=>a.sequence-b.sequence).entries()){
    const w=frames.get(slot.from);if(!w)throw Error('Missing resource observation for a campaign sender');
    const target=Math.max(ADAPTIVE_BANDWIDTH,slot.resourceRequired??0);
    const ready=bufferedReadyAt(w.snapshot.limit,w.snapshot.available,w.snapshot.observedAt,clock,target,w.spends,0)??now+DAY;
    const anchor=i===0&&slot.resourceReadyAt?Math.max(slot.resourceReadyAt.getTime(),previousAt):Math.max(clock,ready);
    const full=projectedFree(w.snapshot.limit,w.snapshot.available,w.snapshot.observedAt,anchor,w.spends)>=w.snapshot.limit;
    const gap=slot.pacingDelayMs??randomGap(full);
    if(!Number.isSafeInteger(gap)||gap<60_000||gap>600_000)throw Error('Invalid saved adaptive pacing gap');
    const scheduledAt=new Date(anchor+gap);
    times.push({id:slot.id,scheduledAt,pacingDelayMs:gap,pacingAfterId:predecessor});
    clock=Math.max(now,scheduledAt.getTime());predecessor=slot.id;
    w.spends.push({at:clock,points:w.cost});lastSenderAt.set(slot.from,clock);
  }
  return {times,lastSenderAt,mixEndsAt:clock};
}

/** Keep the saved closing map and its conservative daily sender slots, but
 * move their time origin to the faster MIX completion. No payouts are made. */
export function adaptiveReturnForecast(rows:{id:string;from:string;sequence:number}[],
  mixEndsAt:number,lastSenderAt:Map<string,number>,now:number){
  const last=new Map(lastSenderAt);
  return [...rows].sort((a,b)=>a.sequence-b.sequence).map(row=>{
    const at=Math.max(now,mixEndsAt+DAY,(last.get(row.from)??mixEndsAt)+DAY);
    last.set(row.from,at);return {id:row.id,scheduledAt:new Date(at)};
  });
}
