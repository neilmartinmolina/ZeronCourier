import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZeronCourier, assistantReport } from '../core.mjs';
import { createBridge } from '../bridge.mjs';

function fakeEngine({ status = 'idle', pendingInput = null } = {}) {
  const engine = { status, pendingInput, sends: 0, text: 'Old report', messageId: 'old', sendError: false };
  engine.call = async (name, args) => {
    switch (name) {
      case 'list_chats': return { chats: [{ id: 'intern-chat', title: 'InternTrack task', status: engine.status, project: { name: 'InternTrack' } }, { id: 'other-chat', project: { name: 'Other' } }] };
      case 'get_chat': return { id: args.chat, title: 'InternTrack task', status: engine.status, pendingInput: engine.pendingInput, lastMessage: { id: engine.messageId, role: 'assistant', status: engine.messageStatus || 'complete', text: engine.text } };
      case 'read_chat': return { messages: [{ id: engine.messageId, role: 'assistant', status: 'complete', text: engine.text }] };
      case 'send_message': engine.sends++; if (engine.sendError) throw new Error('Connection lost after submission'); return { accepted: true };
      default: throw new Error(`Unexpected tool ${name}`);
    }
  };
  return engine;
}
const instruction = (extra = {}) => ({ chatId: 'intern-chat', text: 'Implement approved task.', requestId: 'request-0001', ...extra });

test('only active InternTrack chats can be targeted', async () => {
  const mcp = fakeEngine(), zeroncourier = new ZeronCourier(mcp);
  assert.equal((await zeroncourier.chats()).length, 1);
  await assert.rejects(zeroncourier.send(instruction({ chatId: 'other-chat' })), /not an active InternTrack/);
  assert.equal(mcp.sends, 0);
});
test('busy and awaiting-input chats are never redirected', async () => {
  for (const status of ['working', 'awaitingInput', 'errored', 'unknown']) {
    const mcp = fakeEngine({ status }), zeroncourier = new ZeronCourier(mcp);
    await assert.rejects(zeroncourier.send(instruction())); assert.equal(mcp.sends, 0);
  }
  const mcp = fakeEngine({ pendingInput: { requestId: 'question' } });
  await assert.rejects(new ZeronCourier(mcp).send(instruction()), /needs an answer/); assert.equal(mcp.sends, 0);
});
test('duplicate requests and identical text cannot submit twice', async () => {
  const mcp = fakeEngine(), zeroncourier = new ZeronCourier(mcp);
  await zeroncourier.send(instruction());
  assert.equal((await zeroncourier.send(instruction())).duplicate, true);
  assert.equal((await zeroncourier.send(instruction({ requestId: 'request-0002' }))).duplicate, true);
  await assert.rejects(zeroncourier.send(instruction({ text: 'Changed text' })), /different instruction/);
  assert.equal(mcp.sends, 1);
});
test('concurrent sends and an accepted task before host pickup are blocked', async () => {
  const mcp = fakeEngine(), zeroncourier = new ZeronCourier(mcp);
  const results = await Promise.allSettled([zeroncourier.send(instruction()), zeroncourier.send(instruction({ requestId: 'request-0002', text: 'Different task' }))]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(mcp.sends, 1);
  await assert.rejects(zeroncourier.send(instruction({ requestId: 'request-0003', text: 'Next task' })), /still pending/);
});
test('delivery is persisted before send and ambiguous delivery is never replayed', async () => {
  const mcp = fakeEngine(); mcp.sendError = true;
  const snapshots = [], state = { jobs: {} };
  const zeroncourier = new ZeronCourier(mcp, { state, persist: async s => snapshots.push(JSON.parse(JSON.stringify(s))) });
  await assert.rejects(zeroncourier.send(instruction()), /Delivery was not confirmed/);
  assert.equal(snapshots[0].jobs['request-0001'].status, 'sending');
  assert.equal(state.jobs['request-0001'].status, 'delivery-unknown');
  await zeroncourier.send(instruction()); assert.equal(mcp.sends, 1);
  await assert.rejects(zeroncourier.send(instruction({ requestId: 'request-0002', text: 'New task' })), /still pending/);
  await assert.rejects(zeroncourier.report('intern-chat', 'request-0001'), /uncertain/);
});
test('reports reject busy, unfinished, and old responses; same text with a new ID is valid', async () => {
  const mcp = fakeEngine(), zeroncourier = new ZeronCourier(mcp);
  await zeroncourier.send(instruction());
  await assert.rejects(zeroncourier.report('intern-chat', 'request-0001'), /No new report/);
  mcp.status = 'working'; await assert.rejects(zeroncourier.report('intern-chat', 'request-0001'), /still working/);
  mcp.status = 'idle'; mcp.messageId = 'new';
  const report = await zeroncourier.report('intern-chat', 'request-0001');
  assert.match(report.text, /Task:/); assert.match(report.text, /Old report/);
  await zeroncourier.send(instruction({ requestId: 'request-0002', text: 'Another task.' })); assert.equal(mcp.sends, 2);
  assert.throws(() => assistantReport({ messages: [{ role: 'assistant', status: 'working', text: 'Partial' }] }), /No completed/);
});
test('report correlation survives lost browser preferences', async () => {
  const mcp = fakeEngine(), zeroncourier = new ZeronCourier(mcp);
  await zeroncourier.send(instruction()); mcp.text = 'New completed report'; mcp.messageId = 'new';
  assert.match((await zeroncourier.report('intern-chat')).text, /Task:/);
  assert.equal(zeroncourier.state.jobs['request-0001'].status, 'reported');
});
test('live status follows queued, working, completed, and imported reports without consuming them', async () => {
  const mcp = fakeEngine(), zeroncourier = new ZeronCourier(mcp);
  assert.equal((await zeroncourier.status('intern-chat')).activity, 'report-ready');
  await zeroncourier.send(instruction());
  assert.equal((await zeroncourier.status('intern-chat')).activity, 'queued');
  mcp.status = 'working'; mcp.messageId = 'new';
  assert.equal((await zeroncourier.status('intern-chat')).activity, 'working');
  assert.equal((await zeroncourier.status('intern-chat')).reportReady, false);
  mcp.status = 'idle'; mcp.messageStatus = 'working';
  assert.equal((await zeroncourier.status('intern-chat')).reportReady, false);
  mcp.messageStatus = 'complete';
  assert.equal((await zeroncourier.status('intern-chat')).activity, 'report-ready');
  assert.equal(zeroncourier.state.jobs['request-0001'].status, 'accepted');
  await zeroncourier.report('intern-chat');
  assert.equal((await zeroncourier.status('intern-chat')).activity, 'report-imported');
  assert.equal((await zeroncourier.status('intern-chat')).canSend, true);
  mcp.messageId = 'newer'; assert.equal((await zeroncourier.status('intern-chat')).reportReady, true);
});
test('live status blocks errored, input-blocked, and uncertain chats', async () => {
  const mcp = fakeEngine(), zeroncourier = new ZeronCourier(mcp);
  mcp.pendingInput = { question: true };
  assert.equal((await zeroncourier.status('intern-chat')).activity, 'awaiting-input');
  assert.equal((await zeroncourier.status('intern-chat')).canSend, false);
  mcp.pendingInput = null; mcp.status = 'errored';
  assert.equal((await zeroncourier.status('intern-chat')).activity, 'error');
  mcp.status = 'idle'; mcp.sendError = true;
  await assert.rejects(zeroncourier.send(instruction()));
  assert.equal((await zeroncourier.status('intern-chat')).activity, 'delivery-unknown');
  assert.equal((await zeroncourier.status('intern-chat')).reportReady, false);
  await assert.rejects(zeroncourier.status('other-chat'), /not an active/);
});
test('HTTP requires pairing, rejects hostile origins, and refuses malformed bodies', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'zeroncourier-test-'));
  const bridge = await createBridge({ mcp: fakeEngine(), stateDir, token: 'test-token' });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => bridge.server.close(resolve)); await rm(stateDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${bridge.server.address().port}`;
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/api/chats')).status, 401);
  const headers = { Authorization: 'Bearer test-token' };
  assert.equal((await fetch(base + '/api/chats', { headers })).status, 200);
  assert.equal((await fetch(base + '/api/chats', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(base + '/pair', { headers: { Origin: 'https://chatgpt.com' } })).status, 403);
  assert.equal((await fetch(base + '/zeroncourier.user.js', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(base + '/api/send', { method: 'POST', headers, body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/api/send', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{invalid' })).status, 400);
  assert.equal((await fetch(base + '/api/send', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(instruction()) })).status, 200);
});
