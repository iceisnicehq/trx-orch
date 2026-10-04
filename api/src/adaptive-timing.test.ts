import {test} from 'node:test';
import {strictEqual,ok,deepStrictEqual} from 'node:assert';
import {adaptiveMixForecast,adaptiveReturnForecast,type TimingWallet} from './adaptive-timing.js';
import {DAY} from './campaign-plan.js';

const start=Date.parse('2026-10-04T13:25:39+03:00');
function wallet(available:number,spent=267):TimingWallet{
  return {snapshot:{limit:600,available,observedAt:start},spends:available<600?[{at:start,points:spent}]:[],cost:spent,lastConfirmedAt:available<600?start:null};
}
const slot=(id:string,from:string,sequence:number)=>({id,from,sequence,pacingDelayMs:null,resourceReadyAt:null,resourceRequired:null});

test('407-point forecast removes the hourly buffer and 24-hour MIX wait while preserving strict order',()=>{
  const rows=[slot('ann','Ann',1),slot('tag','TAG',2)];
  const result=adaptiveMixForecast(rows,new Map([['Ann',wallet(333)],['TAG',wallet(600)]]),start,start,null,full=>full?60_000:300_000);
  const expected=start+(407-333)/267*DAY+300_000;
  ok(Math.abs(result.times[0].scheduledAt.getTime()-expected)<1100);
  ok(result.times[0].scheduledAt.getTime()<start+8*60*60_000);
  strictEqual(result.times[1].scheduledAt.getTime(),result.times[0].scheduledAt.getTime()+60_000);
  deepStrictEqual(result.times.map(t=>t.id),['ann','tag']);
});

test('future usage and changed receipt cost affect the next forecast for the same sender',()=>{
  const rows=[slot('first','A',1),slot('other','B',2),slot('again','A',3)];
  const forecast=(cost:number)=>adaptiveMixForecast(rows,new Map([['A',wallet(600,cost)],['B',wallet(600,cost)]]),start,start,null,()=>60_000);
  const smaller=forecast(260),larger=forecast(300);
  strictEqual(smaller.times[0].scheduledAt.getTime(),larger.times[0].scheduledAt.getTime());
  ok(larger.times[2].scheduledAt.getTime()>smaller.times[2].scheduledAt.getTime()+60*60_000);
  ok(smaller.times[2].scheduledAt.getTime()>smaller.times[0].scheduledAt.getTime());
});

test('saved readiness and random gap keep the head time stable when replayed after a restart',()=>{
  const head={...slot('first','A',1),pacingDelayMs:93_417,resourceReadyAt:new Date(start)};
  const random=()=>{throw Error('A saved gap must not be sampled again');};
  const frames=new Map([['A',wallet(600)]]);
  const before=adaptiveMixForecast([head],frames,start,start,null,random);
  const after=adaptiveMixForecast([head],frames,start+180_000,start,null,random);
  strictEqual(before.times[0].scheduledAt.getTime(),start+93_417);
  strictEqual(after.times[0].scheduledAt.getTime(),before.times[0].scheduledAt.getTime());
});

test('closing forecasts keep the saved map, daily sender spacing and a full day after MIX',()=>{
  const rows=[{id:'one',from:'A',sequence:4},{id:'two',from:'B',sequence:5},{id:'three',from:'A',sequence:6}];
  const times=adaptiveReturnForecast(rows,start,new Map([['A',start],['B',start-60_000]]),start);
  deepStrictEqual(times.map(t=>t.id),rows.map(t=>t.id));
  strictEqual(times[0].scheduledAt.getTime(),start+DAY);
  strictEqual(times[1].scheduledAt.getTime(),start+DAY);
  strictEqual(times[2].scheduledAt.getTime(),start+2*DAY);
});
