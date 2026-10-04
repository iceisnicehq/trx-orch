import {test} from 'node:test';
import {deepStrictEqual,strictEqual,ok} from 'node:assert';
import {reconstructPrehistory,type HistoricalRow} from './legacy-attribution.js';

function row(sequence:number,from:string,to:string,amountSun:number,extra:Partial<HistoricalRow>={}):HistoricalRow{
  const at=new Date(1_700_000_000_000+sequence*1000);
  return {id:'old-'+sequence,sequence,from,to,amountSun,kind:'MIX',status:'CONFIRMED',campaignId:null,
    scheduledAt:at,plannedAt:null,confirmedAt:at,updatedAt:at,createdAt:at,bandwidthUsed:267,txId:'tx-'+sequence,allocations:[],...extra};
}
const share=(movement:{allocations:{ownerAddress:string;amountSun:number}[]},owner:string)=>
  movement.allocations.find(a=>a.ownerAddress===owner)?.amountSun??0;

test('FIFO follows only the original stake through peer hops, partial departures and combined native transfers',()=>{
  const rows=[row(1,'A','B',500000),row(2,'B','C',1500000),row(3,'C','A',500000),
    row(4,'C','D',1750000),row(5,'D','A',2000000),row(6,'D','B',750000)];
  const original=JSON.stringify(rows),result=reconstructPrehistory(rows,['A','B','C','D']);
  strictEqual(result.issues.length,0);
  const movements=result.segments[0].movements;
  deepStrictEqual(movements.filter(t=>share(t,'A')).map(t=>[t.sequence,share(t,'A')]),[[1,500000],[2,500000],[4,250000],[6,250000]]);
  strictEqual(share(movements[2],'A'),0,'An incoming payment to A can still contain none of the original A stake');
  strictEqual(share(movements[4],'A'),0,'Do not include an unrelated payment merely because it touches A');
  const positions=result.segments[0].positions;
  deepStrictEqual(positions.filter(p=>p.ownerAddress==='A').map(p=>[p.holderAddress,p.amountSun]).sort(),[['A',500000],['B',250000],['C',250000]]);
  for(const owner of ['A','B','C','D'])strictEqual(positions.filter(p=>p.ownerAddress===owner).reduce((sun,p)=>sun+p.amountSun,0),1000000);
  for(const t of movements)strictEqual(t.allocations.reduce((sun,a)=>sun+a.amountSun,0),t.amountSun);
  strictEqual(JSON.stringify(rows),original,'Reporting does not mutate the native journal or recorded allocations');
});

test('FIFO preserves incoming lot order when a transfer carries more than two original stakes',()=>{
  const result=reconstructPrehistory([row(1,'A','C',500000),row(2,'B','C',500000),
    row(3,'C','D',2000000),row(4,'D','E',1250000),row(5,'D','E',1250000)],['A','B','C','D','E']);
  strictEqual(result.issues.length,0);
  const transfers=result.segments[0].movements;
  strictEqual(share(transfers[3],'A'),0,'The original D lot and older C lot leave before incoming A');
  strictEqual(share(transfers[4],'A'),500000);
  strictEqual(share(transfers[4],'B'),0);
});

test('decimal amounts retain single-Sun precision and rebalance never secretly resets attribution',()=>{
  const result=reconstructPrehistory([row(1,'A','B',123457),row(2,'B','C',1000000),
    row(3,'B','A',123457,{kind:'REBALANCE'})],['A','B','C']);
  strictEqual(result.issues.length,0);
  const transfers=result.segments[0].movements;
  strictEqual(share(transfers[1],'A'),0);
  strictEqual(share(transfers[2],'A'),123457);
  deepStrictEqual(result.segments[0].positions.filter(p=>p.ownerAddress==='A'),[{holderAddress:'A',ownerAddress:'A',amountSun:1000000}]);
  const equalBalances=reconstructPrehistory([row(1,'A','B',1000000),row(2,'B','C',1000000),row(3,'C','A',1000000,{kind:'REBALANCE'})],['A','B','C']);
  deepStrictEqual(equalBalances.segments[0].positions.filter(p=>p.ownerAddress==='A'),[{holderAddress:'B',ownerAddress:'A',amountSun:1000000}],
    'Native balances can all equal one TRX while the chosen FIFO attribution differs');
});

test('saved SMART allocations supersede reconstruction at an explicit new accounting period',()=>{
  const result=reconstructPrehistory([row(1,'A','B',1000000),
    row(2,'A','C',250000,{campaignId:'smart',allocations:[{ownerAddress:'A',amountSun:250000}]}),
    row(3,'C','A',250000,{campaignId:'smart',kind:'RETURN',allocations:[{ownerAddress:'A',amountSun:250000}]})],['A','B','C']);
  strictEqual(result.segments.length,2);strictEqual(result.issues.length,0);
  strictEqual(result.segments[0].movements[0].attributionMethod,'FIFO');
  strictEqual(result.segments[1].movements[0].attributionMethod,'RECORDED');
  strictEqual(share(result.segments[1].movements[1],'A'),250000);
  deepStrictEqual(result.segments[1].positions.filter(p=>p.ownerAddress==='A'),[{holderAddress:'A',ownerAddress:'A',amountSun:1000000}]);
});

test('gaps and invalid saved shares stop their period without manufacturing or partially consuming funds',()=>{
  const gap=reconstructPrehistory([row(1,'A','B',500000),row(2,'A','B',1000000),
    row(3,'B','C',500000),row(4,'A','C',100000,{campaignId:'smart',allocations:[{ownerAddress:'A',amountSun:100000}]})],['A','B','C']);
  strictEqual(gap.issues[0].sequence,2);strictEqual(gap.issues[0].code,'MISSING_FUNDS');
  strictEqual(gap.segments[0].movements.length,1);
  strictEqual(gap.segments[1].movements.length,1,'A complete recorded campaign remains usable after an incomplete earlier period');
  const invalid=reconstructPrehistory([row(1,'A','B',100000,{campaignId:'smart',allocations:[{ownerAddress:'A',amountSun:100000}]}),
    row(2,'B','A',250000,{campaignId:'smart',allocations:[{ownerAddress:'A',amountSun:250000}]})],['A','B']);
  strictEqual(invalid.issues[0].code,'INVALID_ALLOCATION');
  const a=invalid.segments[0].positions.filter(p=>p.ownerAddress==='A');
  strictEqual(a.reduce((sun,p)=>sun+p.amountSun,0),1000000);
  ok(a.some(p=>p.holderAddress==='B'&&p.amountSun===100000));
});
