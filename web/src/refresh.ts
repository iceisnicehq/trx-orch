/** A slow refresh must complete before another poll starts. Otherwise every
 * 5-second tick invalidates still-running responses and Connecting persists. */
export class RefreshGate {
  private running:Promise<void>|null=null;
  run(task:()=>Promise<void>):Promise<void>{
    if(this.running)return this.running;
    const job=Promise.resolve().then(task);
    const current=job.finally(()=>{if(this.running===current)this.running=null;});
    this.running=current;
    return current;
  }
}
export type Section={label:string;run:(isCurrent:()=>boolean)=>Promise<void>};
export function section<T>(label:string,load:()=>Promise<T>,apply:(value:T)=>void):Section{
  return {label,async run(isCurrent){const value=await load();if(isCurrent())apply(value);}};
}
export async function refreshSections(sections:Section[],isCurrent:()=>boolean){
  const outcomes=await Promise.allSettled(sections.map(section=>section.run(isCurrent)));
  return outcomes.flatMap((result,i)=>result.status==='rejected'?
    [`${sections[i].label}: ${result.reason instanceof Error?result.reason.message:String(result.reason)}`]:[]);
}
export async function getJson<T>(path:string,signal?:AbortSignal):Promise<T>{
  const response=await fetch(path,{cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20_000)]):AbortSignal.timeout(20_000)});
  if(!response.ok){
    const body=await response.json().catch(()=>null);
    throw Error(`${path} · HTTP ${response.status}: ${typeof body?.error==='string'?body.error:'Request failed'}`);
  }
  return response.json();
}
