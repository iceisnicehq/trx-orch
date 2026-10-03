import {createHash} from 'node:crypto';
import type {Audit,PrismaClient,Transfer,Wallet} from '@prisma/client';
import {approvalQueue} from './queue.js';

export type TelegramOptions={botToken:string;channelId:string;pinnedMessageId:number;dashboardUrl?:string};
const OPEN_STATUSES=['PLANNED','APPROVED','PAUSED','SUBMITTING','SUBMITTED','UNKNOWN'];
const MAX_TEXT=4096;
const TICK_MS=5000;
const fmtSun=(sun:number)=>`${(sun/1_000_000).toFixed(6)} TRX`;
const dateTime=(d:Date)=>new Intl.DateTimeFormat('en-GB',{
  timeZone:'Europe/Moscow',year:'2-digit',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',hourCycle:'h23'
}).format(d)+' MSK';
const tail=(address:string)=>address.slice(-3);

function labels(wallets:Pick<Wallet,'address'|'ordinal'>[],teacherAddress:string){
  return new Map([...wallets.map(w=>[w.address,`Node ${w.ordinal+1} (${tail(w.address)})`] as const),
    [teacherAddress,`Teacher (${tail(teacherAddress)})`] as const]);
}

export function renderQueue(phase:string,rows:Pick<Transfer,'sequence'|'kind'|'from'|'to'|'amountSun'|'scheduledAt'|'status'>[],
  wallets:Pick<Wallet,'address'|'ordinal'>[],teacherAddress:string,dashboardUrl?:string){
  const names=labels(wallets,teacherAddress),name=(address:string)=>names.get(address)??tail(address);
  const lines=[`TRX QUEUE · ${phase}`,`Times: Moscow (MSK)`,`${rows.length} open`];
  if(!rows.length)lines.push('No transfers in the queue.');
  const footer=dashboardUrl?`Dashboard: ${dashboardUrl}`:'';
  let shown=0;
  for(const row of rows){
    const line=`#${row.sequence} ${row.kind} · ${name(row.from)} → ${name(row.to)} · ${fmtSun(row.amountSun)} · ${dateTime(row.scheduledAt)} · ${row.status}`;
    const remaining=rows.length-shown-1;
    const suffix=remaining?`... ${remaining} more in the dashboard`:'',parts=[...lines,line,suffix,footer].filter(Boolean);
    if(parts.join('\n').length>MAX_TEXT)break;
    lines.push(line);shown++;
  }
  if(shown<rows.length)lines.push(`... ${rows.length-shown} more in the dashboard`);
  if(footer)lines.push(footer);
  return lines.join('\n').slice(0,MAX_TEXT);
}

export function renderAudit(audit:Audit,transfer:Transfer|null,wallets:Pick<Wallet,'address'|'ordinal'>[],teacherAddress:string){
  const names=labels(wallets,teacherAddress),name=(address:string)=>names.get(address)??tail(address);
  const clean=(detail:string)=>{
    for(const [address,label] of names)detail=detail.replaceAll(address,label);
    return detail;
  };
  if(transfer){
    const lines=[`#${transfer.sequence} ${transfer.kind} · ${audit.event}`,
      `From: ${name(transfer.from)}`,`To: ${name(transfer.to)}`,
      `Amount: ${fmtSun(transfer.amountSun)}`,
      `Time: ${dateTime(audit.event==='CONFIRMED'&&transfer.confirmedAt?transfer.confirmedAt:audit.at)}`];
    if(audit.event==='CONFIRMED'&&transfer.bandwidthUsed!==null)lines.push(`Bandwidth used: ${transfer.bandwidthUsed}`);
    if(audit.event==='CONFIRMED')lines.push('Fee: 0 Sun');
    if(transfer.txId&&['SUBMITTED','CONFIRMED','REBROADCAST','BROADCAST_UNCERTAIN'].includes(audit.event))lines.push(`TX: ${transfer.txId}`);
    if(!['QUEUED','APPROVED','SUBMITTED','CONFIRMED'].includes(audit.event))lines.push(`Detail: ${clean(audit.detail)}`);
    return lines.join('\n').slice(0,MAX_TEXT);
  }
  return `[${audit.event}] · ${dateTime(audit.at)}\n${clean(audit.detail)}`.slice(0,MAX_TEXT);
}

export function telegramOptionsFromEnv():TelegramOptions|null{
  const botToken=process.env.TELEGRAM_BOT_TOKEN?.trim()??'';
  const channelId=process.env.TELEGRAM_CHANNEL_ID?.trim()??'';
  const pin=process.env.TELEGRAM_PINNED_MESSAGE_ID?.trim()??'';
  if(!botToken&&!channelId&&!pin)return null;
  const pinnedMessageId=Number(pin);
  if(!botToken||!channelId||!pin||!Number.isSafeInteger(pinnedMessageId)||pinnedMessageId<1||pinnedMessageId>2_147_483_647){
    console.error('Telegram disabled: set a bot token, channel ID, and positive pinned message ID together');
    return null;
  }
  const url=process.env.TELEGRAM_DASHBOARD_URL?.trim();
  let dashboardUrl:string|undefined;
  if(url){
    try{if(new URL(url).protocol==='https:'&&url.length<=300)dashboardUrl=url;
      else console.error('Telegram dashboard URL ignored: use an HTTPS URL no longer than 300 characters');}
    catch{console.error('Telegram dashboard URL ignored: invalid URL');}
  }
  return {botToken,channelId,pinnedMessageId,dashboardUrl};
}

type TelegramResponse={ok:boolean;result?:{message_id?:number}|boolean;error_code?:number;description?:string;parameters?:{retry_after?:number}};
class TelegramError extends Error {
  constructor(message:string,readonly retryAfterMs?:number){super(message);}
}

export class TelegramService {
  private busy=false;
  private timer?:NodeJS.Timeout;
  private wallets?:Pick<Wallet,'address'|'ordinal'>[];
  private teacherAddress?:string;
  constructor(private db:PrismaClient,private options:TelegramOptions|null){}
  get enabled(){return this.options!==null;}
  async bootstrap(){
    if(!this.options)return;
    const {channelId,pinnedMessageId}=this.options;
    const existing=await this.db.telegramCursor.findUnique({where:{channelId}});
    if(existing){
      // Force one resync after restart, including a crash between a successful
      // Telegram edit and recording its hash. "Not modified" counts as success.
      await this.db.telegramCursor.update({where:{channelId},data:{pinnedMessageId,
        lastQueueHash:null,nextQueueAttemptAt:null,queueLastError:null}});
      return;
    }
    // Enabling notifications on an existing game starts with new events. A
    // previously approved transfer that confirms later gets a new audit entry.
    const last=await this.db.audit.findFirst({orderBy:{id:'desc'},select:{id:true}});
    await this.db.telegramCursor.create({data:{channelId,pinnedMessageId,lastAuditId:last?.id??0}});
  }
  start(){
    if(!this.options)return;
    console.log('Telegram notification worker enabled');
    void this.runOnce().catch(e=>console.error('Telegram worker:',String(e)));
    this.timer=setInterval(()=>void this.runOnce().catch(e=>console.error('Telegram worker:',String(e))),TICK_MS);
    this.timer.unref();
  }
  stop(){if(this.timer)clearInterval(this.timer);}
  private async names(){
    if(!this.wallets)this.wallets=await this.db.wallet.findMany({orderBy:{ordinal:'asc'},select:{address:true,ordinal:true}});
    this.teacherAddress=(await this.db.engineState.findUniqueOrThrow({where:{id:1},select:{teacherAddress:true}})).teacherAddress;
    return {wallets:this.wallets,teacherAddress:this.teacherAddress};
  }
  private async api(method:'editMessageText'|'sendMessage',body:Record<string,unknown>):Promise<TelegramResponse>{
    const token=this.options!.botToken;
    let result:TelegramResponse;
    try{
      const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)
      });
      result=await response.json() as TelegramResponse;
    }catch{throw new TelegramError('Telegram request failed; retry scheduled');}
    if(!result.ok){
      if(method==='editMessageText'&&result.error_code===400&&result.description?.toLowerCase().includes('message is not modified'))return {ok:true};
      const reason=(result.description??'API rejected request').replaceAll(token,'[redacted]').slice(0,200);
      throw new TelegramError(`Telegram ${result.error_code??'error'}: ${reason}`,result.parameters?.retry_after?result.parameters.retry_after*1000:undefined);
    }
    return result;
  }
  private async ingestAudits(){
    const {channelId}=this.options!;
    const {wallets,teacherAddress}=await this.names();
    await this.db.$transaction(async tx=>{
      const cursor=await tx.telegramCursor.findUniqueOrThrow({where:{channelId}});
      const events=await tx.audit.findMany({where:{id:{gt:cursor.lastAuditId}},orderBy:{id:'asc'},take:100});
      for(const event of events){
        const transfer=event.transferId?await tx.transfer.findUnique({where:{id:event.transferId}}):null;
        await tx.telegramDelivery.create({data:{channelId,auditId:event.id,text:renderAudit(event,transfer,wallets,teacherAddress),
          priority:event.event==='FATAL'?10:0}});
      }
      if(events.length)await tx.telegramCursor.update({where:{channelId},data:{lastAuditId:events.at(-1)!.id}});
    },{timeout:30_000});
  }
  private async editQueue(){
    const {channelId,pinnedMessageId,dashboardUrl}=this.options!;
    const [cursor,state,rows,{wallets,teacherAddress}]=await Promise.all([
      this.db.telegramCursor.findUniqueOrThrow({where:{channelId}}),
      this.db.engineState.findUniqueOrThrow({where:{id:1}}),
      this.db.transfer.findMany({where:{status:{in:OPEN_STATUSES}},orderBy:{sequence:'asc'}}),
      this.names()
    ]);
    const rendered=renderQueue(state.phase,approvalQueue(rows),wallets,teacherAddress,dashboardUrl);
    const hash=createHash('sha256').update(rendered).digest('hex');
    if(hash===cursor.lastQueueHash||(cursor.nextQueueAttemptAt&&cursor.nextQueueAttemptAt.getTime()>Date.now()))return;
    try{
      await this.api('editMessageText',{chat_id:channelId,message_id:pinnedMessageId,text:rendered,
        link_preview_options:{is_disabled:true}});
      await this.db.telegramCursor.update({where:{channelId},data:{lastQueueHash:hash,nextQueueAttemptAt:null,queueLastError:null}});
    }catch(e){
      const err=e instanceof TelegramError?e:new TelegramError('Telegram queue update failed');
      await this.db.telegramCursor.update({where:{channelId},data:{queueLastError:err.message,
        nextQueueAttemptAt:new Date(Date.now()+Math.max(60_000,err.retryAfterMs??0))}});
      console.error('Telegram queue:',err.message);
    }
  }
  private async sendNext(){
    const {channelId}=this.options!;
    const next=await this.db.telegramDelivery.findFirst({where:{channelId,status:'PENDING',nextAttemptAt:{lte:new Date()}},
      orderBy:[{priority:'desc'},{auditId:'asc'}]});
    if(!next)return;
    try{
      const result=await this.api('sendMessage',{chat_id:channelId,text:next.text,link_preview_options:{is_disabled:true}});
      const messageId=typeof result.result==='object'&&result.result!==null?result.result.message_id:undefined;
      if(!Number.isSafeInteger(messageId))throw new TelegramError('Telegram did not return a message ID');
      await this.db.telegramDelivery.update({where:{id:next.id},data:{status:'SENT',messageId,sentAt:new Date(),attempts:{increment:1},lastError:null}});
    }catch(e){
      const err=e instanceof TelegramError?e:new TelegramError('Telegram notification failed');
      const retry=Math.max(err.retryAfterMs??0,Math.min(60*60_000,5000*2**Math.min(next.attempts,10)));
      await this.db.telegramDelivery.update({where:{id:next.id},data:{attempts:{increment:1},lastError:err.message,nextAttemptAt:new Date(Date.now()+retry)}});
      console.error('Telegram notification:',err.message);
    }
  }
  async runOnce(){
    if(!this.options||this.busy)return;
    this.busy=true;
    try{await this.ingestAudits();await this.editQueue();await this.sendNext();}
    finally{this.busy=false;}
  }
}
