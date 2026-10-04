import {test} from 'node:test';
import {strictEqual,ok} from 'node:assert';
import {flowNodeLabel,flowEdgeLabel} from '../src/ownership-labels.ts';
const name=address=>({A:'Node 1',B:'Node 2'})[address]??address;

test('the personal prehistory label separates a tiny owner share from the full native transfer',()=>{
  const label=flowNodeLabel({type:'transfer',wallet:'A',toWallet:'B',sequence:5,day:0,section:'PREHISTORY',
    mode:'LIST',amountSun:74301,nativeSun:1000000,attributionBasis:'RECONSTRUCTED',attributionMethod:'FIFO'},name);
  ok(label.includes('0.074301 TRX моя доля'));
  ok(label.includes('1.000 TRX перевод · FIFO'));
  ok(!label.includes('Состав не сохранён'));
  strictEqual(flowEdgeLabel(74301,'CONFIRMED'),'0.074301 TRX этой ставки');
});

test('retained lots remain owner amounts and accounting boundaries cannot look like native transfers',()=>{
  const holding=flowNodeLabel({type:'holding',wallet:'B',sequence:5,amountSun:547234,day:0,
    section:'PREHISTORY',attributionBasis:'RECONSTRUCTED'},name);
  ok(holding.includes('0.547234 TRX моей ставки'));ok(holding.includes('FIFO · расчёт'));
  const boundary=flowNodeLabel({type:'checkpoint',wallet:'A',amountSun:1000000,day:0,
    checkpointTitle:'Начало выбранного SMART'},name);
  ok(boundary.includes('Это не перевод'));
  strictEqual(flowEdgeLabel(null,'CONTEXT'),'Граница учёта; это не перевод');
});
