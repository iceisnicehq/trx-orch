import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { TronWeb } from 'tronweb';
import { z } from 'zod';

export const TARGET = 1_000_000;
export const WALLET_COUNT = 17;
export const MODE = process.env.TRON_MODE ?? 'live';
const address = z.string().refine(a => TronWeb.isAddress(a), 'Invalid TRON address');
const schema = z.object({ teacherAddress: address, wallets: z.array(z.object({slot:z.number().int().min(1).max(WALLET_COUNT),address, privateKey:z.string().regex(/^[a-fA-F0-9]{64}$/)})).length(WALLET_COUNT) });
export type WalletKey = {slot:number; address:string; privateKey:string};
export type Config = {teacherAddress:string; wallets:WalletKey[]};

export async function loadConfig(): Promise<Config> {
  if (MODE === 'mock') {
    const key = (n: number) => createHash('sha256').update(`DEMO ONLY - trx orchestrator ${n}`).digest('hex');
    const keys = Array.from({length:WALLET_COUNT}, (_,i) => key(i));
    const derive=(privateKey:string):string=>{const a=TronWeb.address.fromPrivateKey(privateKey);if(!a)throw Error('Mock key derivation failed');return a;};
    return {teacherAddress:derive(key(99)),wallets:keys.map((privateKey,i) => ({slot:i+1,privateKey,address:derive(privateKey)}))};
  }
  if (MODE !== 'live') throw Error('TRON_MODE must be mock or live');
  const parsed = schema.safeParse(JSON.parse(await readFile(process.env.WALLETS_FILE ?? '/app/config/wallets.json','utf8')));
  if (!parsed.success) throw Error('Fill teacherAddress and all 17 numbered slots in config/wallets.json with valid TRON addresses and matching 64-hex private keys');
  const c=parsed.data;
  if(c.wallets.some((w,i)=>w.slot!==i+1))throw Error('Wallet slots must be ordered 1 through 17');
  const addresses = c.wallets.map(w => w.address);
  if (new Set(addresses).size !== addresses.length || addresses.includes(c.teacherAddress)) throw Error('Duplicate wallet or teacher in participants');
  for (const w of c.wallets) if (TronWeb.address.fromPrivateKey(w.privateKey) !== w.address) throw Error(`Key does not match ${w.address}`);
  const host=process.env.TRON_FULL_HOST ?? 'https://api.trongrid.io';
  if(new URL(host).hostname==='api.trongrid.io'&&!process.env.TRON_PRO_API_KEY)
    throw Error('Set TRON_PRO_API_KEY in .env for TronGrid Mainnet, or configure a trusted alternative TRON_FULL_HOST');
  return c;
}
