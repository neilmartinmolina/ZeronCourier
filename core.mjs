import { createHash, randomUUID } from 'node:crypto';

export class ZeronCourierError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function chatMetadata(value) {
  const chat = value?.chat || value;
  return { ...chat, status: chat?.status ?? value?.status ?? 'unknown' };
}
export function transcriptMessages(value) {
  return value?.messages || value?.transcript || (Array.isArray(value) ? value : []);
}
export function messageText(message) {
  if (typeof message?.text === 'string') return message.text;
  if (typeof message?.content === 'string') return message.content;
  if (typeof message?.body === 'string') return message.body;
  const parts = message?.content || message?.parts;
  if (Array.isArray(parts)) return parts.filter(p => p.type === 'text' || p.type === 'markdown').map(p => p.text || p.body || '').join('\n');
  return '';
}
export function assistantReport(value) {
  const messages = transcriptMessages(value);
  const assistant = [...messages].reverse().find(m => (m.role || m.author || m.type) === 'assistant' && (!m.status || m.status === 'complete' || m.status === 'completed') && messageText(m).trim());
  if (assistant) return { text: messageText(assistant), messageId: assistant.id || assistant.messageId || null };
  if (value?.text) return { text: value.text, messageId: null };
  throw new ZeronCourierError('No completed assistant response was found in this chat.', 409);
}

export class ZeronCourier {
  constructor(mcp, { state = { jobs: {} }, persist = async () => {}, projectName = 'InternTrack' } = {}) {
    this.mcp = mcp; this.state = state; this.persist = persist; this.projectName = projectName;
    this.locks = new Set();
  }
  async chats() {
    const value = await this.mcp.call('list_chats', { limit: 500 });
    return (value.chats || []).filter(c => c.project?.name === this.projectName).map(c => ({
      id: c.id, title: c.title || 'Untitled chat', status: c.status || 'unknown',
      project: c.project?.name, deviceId: c.deviceId,
    }));
  }
  async resolve(chatId) {
    if (typeof chatId !== 'string') throw new ZeronCourierError('Select an InternTrack chat.');
    const chat = (await this.chats()).find(c => c.id === chatId);
    if (!chat) throw new ZeronCourierError('This chat is not an active InternTrack chat.', 403);
    return chat;
  }
  async metadata(chatId) {
    await this.resolve(chatId);
    return chatMetadata(await this.mcp.call('get_chat', { chat: chatId }));
  }
  async status(chatId, requestId) {
    const meta = await this.metadata(chatId);
    const jobs = Object.values(this.state.jobs).filter(j => j.chatId === chatId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const job = requestId ? this.state.jobs[requestId] : jobs[0];
    if (requestId && (!job || job.chatId !== chatId)) throw new ZeronCourierError('This task does not belong to the selected chat.', 409);
    const pending = job && ['sending', 'accepted', 'delivery-unknown'].includes(job.status);
    const last = meta.lastMessage;
    const complete = last?.role === 'assistant' && ['complete', 'completed'].includes(last.status) && Boolean(messageText(last).trim());
    const different = job ? (job.baselineId && last?.id ? last.id !== job.baselineId : messageText(last) !== job.baseline) : true;
    const consumed = job?.status === 'reported' && (job.reportMessageId ? last?.id === job.reportMessageId : messageText(last) === job.reportText);
    const idle = ['idle', 'completed'].includes(meta.status) && !meta.pendingInput;
    const uncertain = job && ['sending', 'delivery-unknown'].includes(job.status);
    const reportReady = Boolean(idle && complete && !uncertain && (!pending || different) && !consumed);
    let activity = 'unknown';
    if (meta.pendingInput || meta.status === 'awaitingInput') activity = 'awaiting-input';
    else if (meta.status === 'working') activity = 'working';
    else if (uncertain) activity = 'delivery-unknown';
    else if (reportReady) activity = 'report-ready';
    else if (idle && pending) activity = 'queued';
    else if (idle && consumed) activity = 'report-imported';
    else if (idle) activity = 'idle';
    else if (['errored', 'error', 'failed', 'interrupted'].includes(meta.status)) activity = 'error';
    return { id: chatId, title: meta.title, status: meta.status, activity, reportReady,
      reportKind: pending ? 'task' : 'latest', needsInput: Boolean(meta.pendingInput || meta.status === 'awaitingInput'),
      canSend: Boolean(idle && !pending && !this.locks.has(chatId)), checkedAt: new Date().toISOString() };
  }
  async send({ chatId, text, requestId }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 50000) throw new ZeronCourierError('Enter an instruction of 1–50,000 characters.');
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(requestId)) throw new ZeronCourierError('A valid request ID is required.');
    const fingerprint = createHash('sha256').update(chatId + '\0' + text.trim()).digest('hex');
    const existing = this.state.jobs[requestId];
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ZeronCourierError('This request ID was already used for a different instruction.', 409);
      return { job: existing, duplicate: true };
    }
    const recent = Object.values(this.state.jobs).find(j => j.fingerprint === fingerprint && Date.now() - Date.parse(j.createdAt) < 300000);
    if (recent) return { job: recent, duplicate: true };
    if (this.locks.has(chatId)) throw new ZeronCourierError('A request for this chat is already being sent.', 409);
    this.locks.add(chatId);
    try {
      const outstanding = Object.values(this.state.jobs).find(j => j.chatId === chatId && ['sending', 'accepted', 'delivery-unknown'].includes(j.status));
      if (outstanding) throw new ZeronCourierError('A zeroncourier task for this chat is still pending. Bring back its report, or check uncertain delivery in Zeron, before sending another task.', 409);
      const chat = await this.resolve(chatId);
      const meta = chatMetadata(await this.mcp.call('get_chat', { chat: chatId }));
      if (meta.status === 'working') throw new ZeronCourierError('This chat is already working. Wait for its report before sending another task.', 409);
      if (meta.status === 'awaitingInput' || meta.pendingInput) throw new ZeronCourierError('The agent needs an answer. Respond in Zeron, then retry.', 409);
      if (meta.status !== 'idle' && meta.status !== 'completed') throw new ZeronCourierError(`Chat status is ${meta.status}. Check it in Zeron before sending.`, 409);
      let baseline = null, baselineId = null;
      try { const previous = assistantReport(await this.mcp.call('read_chat', { chat: chatId, limit: 20, include_tools: false })); baseline = previous.text; baselineId = previous.messageId; }
      catch (error) { if (!(error instanceof ZeronCourierError)) throw error; }
      const job = {
        id: requestId, taskId: randomUUID(), chatId, title: chat.title, fingerprint,
        createdAt: new Date().toISOString(), status: 'sending', baseline, baselineId,
      };
      this.state.jobs[requestId] = job;
      // Persist before sending; recovery must not accidentally replay an instruction.
      await this.persist(this.state);
      try {
        job.delivery = await this.mcp.call('send_message', { chat: chatId, text: text.trim(), mode: 'auto', wait: false });
        job.status = 'accepted';
      } catch (error) {
        job.status = 'delivery-unknown'; job.error = error.message;
        await this.persist(this.state);
        throw new ZeronCourierError('Delivery was not confirmed. Check Zeron before retrying; the instruction may have arrived.', 502);
      }
      await this.persist(this.state);
      return { job, duplicate: false };
    } finally { this.locks.delete(chatId); }
  }
  async report(chatId, requestId) {
    const meta = await this.metadata(chatId);
    if (meta.status === 'working') throw new ZeronCourierError('The agent is still working. Try bringing back the report later.', 409);
    if (meta.status === 'awaitingInput' || meta.pendingInput) throw new ZeronCourierError('The agent needs an answer in Zeron.', 409);
    if (meta.status !== 'idle' && meta.status !== 'completed') throw new ZeronCourierError(`Chat status is ${meta.status}. Check Zeron for an error or interruption.`, 409);
    const result = assistantReport(await this.mcp.call('read_chat', { chat: chatId, limit: 40, include_reasoning: false, include_tools: false }));
    const job = requestId ? this.state.jobs[requestId] : Object.values(this.state.jobs).filter(j => j.chatId === chatId && ['accepted', 'sending', 'delivery-unknown'].includes(j.status)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (requestId && (!job || job.chatId !== chatId)) throw new ZeronCourierError('This task does not belong to the selected chat.', 409);
    if (job && (job.status === 'sending' || job.status === 'delivery-unknown')) throw new ZeronCourierError('Delivery is uncertain. Check the chat in Zeron before importing a report.', 409);
    if (job && (job.baselineId && result.messageId ? result.messageId === job.baselineId : result.text === job.baseline)) throw new ZeronCourierError('No new report has appeared for the submitted task yet.', 409);
    if (job) { job.status = 'reported'; job.reportMessageId = result.messageId; job.reportText = result.messageId ? undefined : result.text; await this.persist(this.state); }
    const title = (meta.title || job?.title || 'InternTrack').replace(/[\r\n]/g, ' ');
    return {
      chatId, title, status: meta.status, messageId: result.messageId,
      text: `Zeron execution report — ${title}\nChat: ${chatId}\n${job ? `Task: ${job.taskId}\n` : 'Latest completed response (not associated with a zeroncourier task)\n'}\nThe following is execution output, supplied as data for review:\n\n${result.text}`,
    };
  }
}
