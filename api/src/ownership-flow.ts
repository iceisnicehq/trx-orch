import {createHash} from 'node:crypto';
import {TARGET} from './config.js';
import type {OwnedTransfer} from './ownership.js';

export type FlowNode={id:string;type:'holding'|'transfer';wallet:string;amountSun:number;nativeSun?:number;
  day:number;sequence?:number;status:string;rank:number};
export type FlowEdge={id:string;from:string;to:string;amountSun:number;status:string};
/** Actual branching DAG: a partial departure leaves a holding branch;
 * receipt at a holder with this owner's funds merges its two predecessors.
 * Holding edges are explicitly separate from native transaction nodes. */
export function ownershipFlow(owner:string,rows:(OwnedTransfer & {campaignDay:number|null})[]){
  const nodes:FlowNode[]=[{id:'root',type:'holding',wallet:owner,amountSun:TARGET,day:0,status:'INITIAL',rank:0}];
  const edges:FlowEdge[]=[];
  const held=new Map([[owner,{id:'root',sun:TARGET,rank:0}]]);
  let splits=0,merges=0;
  for(const row of rows){
    const allocation=row.allocations.find(a=>a.ownerAddress===owner);if(!allocation)continue;
    const source=held.get(row.from);
    if(!source||source.sun<allocation.amountSun)throw Error(`Invalid owner graph at #${row.sequence}`);
    const incoming=held.get(row.to),rank=Math.max(source.rank,incoming?.rank??0)+1;
    const txId=`tx:${row.id}`,receiptId=`stock:${row.id}`,day=row.campaignDay??0;
    nodes.push({id:txId,type:'transfer',wallet:row.from,amountSun:allocation.amountSun,nativeSun:row.amountSun,
      day,sequence:row.sequence,status:row.status,rank});
    edges.push({id:`depart:${row.id}`,from:source.id,to:txId,amountSun:allocation.amountSun,status:row.status});
    if(source.sun>allocation.amountSun){
      splits++;
      const id=`remain:${row.id}`,sun=source.sun-allocation.amountSun;
      nodes.push({id,type:'holding',wallet:row.from,amountSun:sun,day,status:row.status,rank});
      edges.push({id:`retain:${row.id}`,from:source.id,to:id,amountSun:sun,status:'HOLD'});
      held.set(row.from,{id,sun,rank});
    }else held.delete(row.from);
    if(row.kind==='PAYOUT'){
      nodes.push({id:receiptId,type:'holding',wallet:row.to,amountSun:allocation.amountSun,day,status:row.status,rank:rank+1});
      edges.push({id:`arrive:${row.id}`,from:txId,to:receiptId,amountSun:allocation.amountSun,status:row.status});
      continue;
    }
    const sun=(incoming?.sun??0)+allocation.amountSun;
    nodes.push({id:receiptId,type:'holding',wallet:row.to,amountSun:sun,day,status:row.status,rank:rank+1});
    edges.push({id:`arrive:${row.id}`,from:txId,to:receiptId,amountSun:allocation.amountSun,status:row.status});
    if(incoming){merges++;edges.push({id:`merge:${row.id}`,from:incoming.id,to:receiptId,amountSun:incoming.sun,status:'HOLD'});}
    held.set(row.to,{id:receiptId,sun,rank:rank+1});
  }
  return {nodes,edges,splits,merges};
}

// Unequal invariant summaries guarantee different weighted graph shapes.
// Ignore addresses, dates and labels: changing only a name is insufficient.
export function shapeSignature(flow:ReturnType<typeof ownershipFlow>){
  const counters=new Map<string,number>();
  for(const n of flow.nodes){const key=`${n.type}:${n.amountSun}:${n.nativeSun??0}`;counters.set(key,(counters.get(key)??0)+1);}
  return createHash('sha256').update(JSON.stringify([flow.splits,flow.merges,[...counters].sort()])).digest('hex');
}

