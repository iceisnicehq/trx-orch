export type LabelNode={type:'holding'|'transfer'|'checkpoint';wallet:string;toWallet?:string;amountSun:number|null;
  nativeSun?:number;day:number;sequence?:number;section?:string;mode?:string;checkpointTitle?:string;
  attributionBasis?:'RECORDED'|'RECONSTRUCTED';attributionMethod?:'RECORDED'|'FIFO'};
export const formatShare=(sun:number|null|undefined)=>sun===null||sun===undefined?'?':
  (sun/1_000_000).toFixed(sun%1000===0?3:6);
export function flowNodeLabel(n:LabelNode,name:(address:string)=>string){
  if(n.type==='checkpoint')return (n.checkpointTitle??'Начало SMART')+'\nНовый учёт: 1.000 TRX\nЭто не перевод';
  if(n.section==='PREHISTORY'){
    const basis=n.attributionBasis==='RECONSTRUCTED'?'FIFO · расчёт':'Сохранённый учёт';
    if(n.type==='holding')return name(n.wallet)+(n.sequence?' · #'+n.sequence:' · начало')+
      '\n'+formatShare(n.amountSun)+' TRX моей ставки\n'+basis;
    return '#'+n.sequence+' · '+n.mode+'\n'+name(n.wallet)+' → '+name(n.toWallet!)+
      '\n'+formatShare(n.amountSun)+' TRX моя доля\n'+formatShare(n.nativeSun)+' TRX перевод · '+(n.attributionMethod??basis);
  }
  if(n.type==='holding')return name(n.wallet)+' · day '+n.day+'\n'+formatShare(n.amountSun)+' TRX этой ставки';
  return '#'+n.sequence+' · day '+n.day+'\n'+formatShare(n.amountSun)+' доля / '+formatShare(n.nativeSun)+' перевод';
}
export function flowEdgeLabel(amountSun:number|null,status:string){
  if(status==='CONTEXT')return 'Граница учёта; это не перевод';
  return formatShare(amountSun)+' TRX этой ставки'+(status==='HOLD'?' · остаётся на адресе':'');
}
