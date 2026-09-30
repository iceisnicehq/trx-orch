import {test} from 'node:test';
import {strictEqual,ok} from 'node:assert';
import {bufferedReadyAt,projectedFree,RECOVERY_WINDOW_MS,RECOVERY_BUFFER_MS} from './recovery.js';

test('260 spent recovers gradually; queue waits for 400 plus an hour',()=>{
  const now=Date.UTC(2026,8,29);
  strictEqual(projectedFree(600,340,now,now),340);
  strictEqual(projectedFree(600,340,now,now+2*60*60_000),361);
  const crossing=(60/260)*RECOVERY_WINDOW_MS;
  const next=bufferedReadyAt(600,340,now,now)!;
  ok(next>=now+crossing+RECOVERY_BUFFER_MS);
  ok(next<now+crossing+RECOVERY_BUFFER_MS+1000);
  strictEqual(bufferedReadyAt(600,340,now,next+60_000),next+60_000);
  strictEqual(bufferedReadyAt(350,340,now,now),null);
});

test('a forecast spend delays a second send without denying another wallet',()=>{
  const now=Date.UTC(2026,8,29);
  const first=now+60*60_000;
  const spend=[{at:first,points:260}];
  strictEqual(projectedFree(600,600,now,first,spend),340);
  const second=bufferedReadyAt(600,600,now,first+60*60_000,400,spend)!;
  ok(second>first+6*60*60_000);
  strictEqual(bufferedReadyAt(600,600,now,first+60*60_000),first+60*60_000);
});

test('267 used at block time and 346 available recover at 267/24 per hour',()=>{
  const spent=Date.UTC(2026,8,28,22,31,39);
  const observed=Date.UTC(2026,8,28,23,40,43);
  const known=[{at:spent,points:267}];
  const estimated=bufferedReadyAt(600,346,observed,observed,400,known)!;
  const expected=observed+(400-346)*RECOVERY_WINDOW_MS/267+RECOVERY_BUFFER_MS;
  // The integer display can differ by a point; the forecast stays close to
  // the observed 267/24 recovery rather than restarting 254/24 at observation.
  ok(Math.abs(estimated-expected)<2*60_000,`Forecast off by ${Math.round((estimated-expected)/60_000)} minutes`);
  ok(estimated<Date.UTC(2026,8,29,5,35));
  ok(estimated>Date.UTC(2026,8,29,5,30));
  strictEqual(projectedFree(600,346,observed,estimated-RECOVERY_BUFFER_MS-60_000,known)<400,true);
});

test('unknown prior spending recovers conservatively while known receipts keep their original rate',()=>{
  const now=Date.UTC(2026,8,29);
  const hour=60*60_000;
  const known=[{at:now-hour,points:267}];
  const available=300; // used 300: ~256 known, remainder from an unknown transfer
  const future=projectedFree(600,available,now,now+hour,known);
  ok(future>=310&&future<=313,`Unexpected mixed recovery ${future}`);
});
