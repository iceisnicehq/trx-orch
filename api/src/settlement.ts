export type Balance = {address:string;sun:number};
export type TargetBalance = Balance & {targetSun:number};
export type Step = {from:string;to:string;amountSun:number};
export type SettlementStep = Step & {kind:'REBALANCE'|'PAYOUT'};

/** Exact minimum transfer count for up to 17 imbalanced wallets. */
export function settleTargets(balances:TargetBalance[]):Step[] {
  if(balances.some(w=>!Number.isSafeInteger(w.sun)||w.sun<0||!Number.isSafeInteger(w.targetSun)||w.targetSun<0))throw Error('Invalid balance');
  if(balances.reduce((s,w)=>s+w.sun,0)!==balances.reduce((s,w)=>s+w.targetSun,0))throw Error('Pool is not conserved');
  const a=balances.filter(w=>w.sun!==w.targetSun);
  if(a.length>17)throw Error('Exact settlement supports at most 17 imbalanced wallets');
  const n=a.length,full=(1<<n)-1;
  if(!n)return [];
  const sum=new Float64Array(full+1);
  for(let m=1;m<=full;m++){const low=m&-m;const i=31-Math.clz32(low);sum[m]=sum[m^low]+a[i].sun-a[i].targetSun;}
  const dp=new Int16Array(full+1).fill(-1),choice=new Int32Array(full+1);
  dp[0]=0;
  function groups(mask:number):number{
    if(dp[mask]>=0)return dp[mask];
    const first=mask&-mask;
    let best=-1,pick=0;
    for(let sub=mask;sub;sub=(sub-1)&mask){
      if(!(sub&first)||sum[sub]!==0)continue;
      const score=1+groups(mask^sub);
      if(score>best){best=score;pick=sub;}
    }
    choice[mask]=pick;return dp[mask]=best;
  }
  groups(full);
  const result:Step[]=[];
  let mask=full;
  while(mask){
    const sub=choice[mask];if(!sub)throw Error('Settlement partition failed');
    const indices:number[]=[];
    for(let i=0;i<n;i++)if(sub&(1<<i))indices.push(i);
    const hub=indices.find(i=>a[i].sun<a[i].targetSun)??indices[0];
    for(const i of indices)if(i!==hub&&a[i].sun>a[i].targetSun)result.push({from:a[i].address,to:a[hub].address,amountSun:a[i].sun-a[i].targetSun});
    for(const i of indices)if(i!==hub&&a[i].sun<a[i].targetSun)result.push({from:a[hub].address,to:a[i].address,amountSun:a[i].targetSun-a[i].sun});
    mask^=sub;
  }
  return result;
}

export function settle(balances:Balance[],target=1_000_000):Step[]{
  return settleTargets(balances.map(w=>({...w,targetSun:target})));
}

/** Restore each wallet's initial dust, then pay exactly 1 TRX from every joined wallet. */
export function settlementPlan(balances:(Balance & {reserveSun:number})[],teacher:string,target=1_000_000):SettlementStep[]{
  if(!balances.length||balances.length>17||balances.some(w=>!Number.isSafeInteger(w.reserveSun)||w.reserveSun<0||w.address===teacher)||new Set(balances.map(w=>w.address)).size!==balances.length)throw Error('Invalid settlement participants');
  const internal=settleTargets(balances.map(w=>({address:w.address,sun:w.sun,targetSun:target+w.reserveSun})));
  return [...internal.map(s=>({...s,kind:'REBALANCE' as const})),...balances.map(w=>({from:w.address,to:teacher,amountSun:target,kind:'PAYOUT' as const}))];
}
