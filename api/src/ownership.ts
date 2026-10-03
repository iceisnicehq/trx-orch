import type {Prisma,PrismaClient,Transfer} from '@prisma/client';
import {TARGET} from './config.js';
import type {Contribution} from './campaign-plan.js';

export class OwnershipError extends Error {}
export type Position={ownerAddress:string;holderAddress:string;amountSun:number};
export type OwnedTransfer=Pick<Transfer,'id'|'sequence'|'from'|'to'|'amountSun'|'kind'|'status'> & {allocations:Contribution[]};
const key=(holder:string,owner:string)=>`${holder}:${owner}`;

export function replayOwnership(members:string[],rows:OwnedTransfer[]):Position[]{
  const balances=new Map(members.map(address=>[key(address,address),TARGET]));
  const known=new Set(members);
  for(const t of rows){
    if(t.allocations.reduce((n,a)=>n+a.amountSun,0)!==t.amountSun||new Set(t.allocations.map(a=>a.ownerAddress)).size!==t.allocations.length)
      throw new OwnershipError(`Allocation total differs for #${t.sequence}`);
    if(!known.has(t.from)||t.kind!=='PAYOUT'&&!known.has(t.to)||t.from===t.to)
      throw new OwnershipError(`Invalid ownership route #${t.sequence}`);
    for(const a of t.allocations){
      if(!known.has(a.ownerAddress)||!Number.isSafeInteger(a.amountSun)||a.amountSun<=0)
        throw new OwnershipError(`Invalid contribution #${t.sequence}`);
      const source=key(t.from,a.ownerAddress),target=key(t.to,a.ownerAddress);
      if((balances.get(source)??0)<a.amountSun)throw new OwnershipError(`Insufficient attributed funds for #${t.sequence}`);
      balances.set(source,balances.get(source)!-a.amountSun);
      if(t.kind!=='PAYOUT')balances.set(target,(balances.get(target)??0)+a.amountSun);
      else if(a.ownerAddress!==t.from||a.amountSun!==TARGET)throw new OwnershipError('A payout must return its own complete 1 TRX stake');
    }
  }
  return [...balances].filter(([,sun])=>sun>0).map(([k,amountSun])=>{
    const [holderAddress,ownerAddress]=k.split(':');return {holderAddress,ownerAddress,amountSun};
  });
}

/** Never call on signing/broadcast: only within the transaction committing
 * a successful, solidified, zero-fee receipt. */
export async function applyConfirmedOwnership(tx:Prisma.TransactionClient,t:Transfer){
  if(!t.campaignId)return;
  const allocations=await tx.allocation.findMany({where:{transferId:t.id}});
  if(!allocations.length||allocations.some(a=>!Number.isSafeInteger(a.amountSun)||a.amountSun<=0)||allocations.reduce((n,a)=>n+a.amountSun,0)!==t.amountSun)
    throw new OwnershipError(`Missing frozen allocations for #${t.sequence}`);
  for(const a of allocations){
    const source={campaignId:t.campaignId,ownerAddress:a.ownerAddress,holderAddress:t.from};
    const removed=await tx.ownershipBalance.updateMany({where:{...source,amountSun:{gte:a.amountSun}},data:{amountSun:{decrement:a.amountSun}}});
    if(removed.count!==1)throw new OwnershipError(`Ownership deficit while confirming #${t.sequence}`);
    if(t.kind!=='PAYOUT'){
      if(!await tx.campaignMember.findUnique({where:{campaignId_address:{campaignId:t.campaignId,address:t.to}}}))
        throw new OwnershipError('Attributed funds left campaign membership');
      const target={campaignId:t.campaignId,ownerAddress:a.ownerAddress,holderAddress:t.to};
      await tx.ownershipBalance.upsert({where:{campaignId_ownerAddress_holderAddress:target},
        create:{...target,amountSun:a.amountSun},update:{amountSun:{increment:a.amountSun}}});
    }else if(a.ownerAddress!==t.from||a.amountSun!==TARGET)throw new OwnershipError('Invalid attributed teacher payout');
  }
  await tx.ownershipBalance.deleteMany({where:{campaignId:t.campaignId,amountSun:0}});
}

/** Detect corruption independently of chain-balance conservation. */
export async function verifyOwnership(db:PrismaClient,campaignId:string){
  const snapshot=await db.$transaction(async tx=>({
    members:await tx.campaignMember.findMany({where:{campaignId}}),
    confirmed:await tx.transfer.findMany({where:{campaignId,status:'CONFIRMED'},include:{allocations:true},orderBy:{sequence:'asc'}}),
    positions:await tx.ownershipBalance.findMany({where:{campaignId}})
  }));
  const expected=replayOwnership(snapshot.members.map(m=>m.address),snapshot.confirmed);
  const sorted=(positions:Position[])=>positions.filter(p=>p.amountSun>0)
    .map(p=>`${key(p.holderAddress,p.ownerAddress)}=${p.amountSun}`).sort();
  if(JSON.stringify(sorted(expected))!==JSON.stringify(sorted(snapshot.positions)))
    throw new OwnershipError('Confirmed ownership positions differ from the immutable transfer ledger');
  return snapshot.positions;
}

/** Directly return each owner's aggregated share at each holder. Incoming
 * returns belong to the recipient, so no step depends on somebody else's
 * return arriving; interrupted closing maps can be regenerated safely. */
export function attributedReturns(positions:Position[]){
  return positions.filter(p=>p.holderAddress!==p.ownerAddress&&p.amountSun>0)
    .sort((a,b)=>a.holderAddress.localeCompare(b.holderAddress)||a.ownerAddress.localeCompare(b.ownerAddress))
    .map(p=>({kind:'RETURN' as const,from:p.holderAddress,to:p.ownerAddress,amountSun:p.amountSun,
      allocations:[{ownerAddress:p.ownerAddress,amountSun:p.amountSun}]}));
}
