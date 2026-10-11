import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Manual recovery only: never replay an instruction with uncertain delivery.
const chatId = process.argv[2];
if (!chatId || process.argv[3] !== '--confirmed-reviewed-in-zeron') {
  console.error('After checking the exact chat in Zeron and stopping the zeroncourier, run: node "Resolve Delivery.mjs" CHAT_ID --confirmed-reviewed-in-zeron');
  process.exit(1);
}
let running = false;
try { const response = await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(1500) }); running = response.ok; } catch {}
if (running) throw new Error('Stop the zeroncourier first with Stop ZeronCourier.ps1 to avoid changing its ledger while running.');
const folder = resolve(dirname(fileURLToPath(import.meta.url)), 'work/zeroncourier-runtime');
const path = resolve(folder, 'jobs.json');
const state = JSON.parse(await readFile(path, 'utf8'));
const jobs = Object.values(state.jobs).filter(job => job.chatId === chatId && ['sending', 'delivery-unknown'].includes(job.status));
if (!jobs.length) throw new Error('No uncertain delivery record exists for that exact chat ID.');
for (const job of jobs) { job.status = 'manually-reviewed'; job.reviewedAt = new Date().toISOString(); }
await writeFile(path + '.tmp', JSON.stringify(state), { mode: 0o600 });
await rename(path + '.tmp', path);
console.log(`Marked ${jobs.length} uncertain delivery record(s) reviewed. No instruction was sent. Restart the zeroncourier when ready.`);
