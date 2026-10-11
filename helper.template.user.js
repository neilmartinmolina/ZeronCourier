// ==UserScript==
// @name         ZeronCourier — Send and Bring Back
// @namespace    local.zeron.courier
// @version      1.3.1
// @description  Send a reviewed instruction to your configured project chat; bring its report back as a ChatGPT draft.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @connect      127.0.0.1
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  if (document.getElementById('zeroncourier-host')) return;
  const BASE = 'http://127.0.0.1:__ZERONCOURIER_PORT__';
  const TOKEN = '__ZERONCOURIER_TOKEN__';
  const host = document.createElement('div'); host.id = 'zeroncourier-host';
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483646;';
  document.documentElement.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    *{box-sizing:border-box} .panel{font:13px/1.45 system-ui,sans-serif;color:#e8edf5;background:#17202b;border:1px solid #425269;border-radius:14px;width:290px;padding:14px;box-shadow:0 8px 35px #0006} .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}strong{font-size:14px}button{font:600 12px system-ui;background:#8bd7be;color:#10231c;border:0;border-radius:7px;padding:10px;cursor:pointer}button.secondary{background:#2a3b50;color:#e8edf5}button:disabled{opacity:.45;cursor:wait}.tiny{padding:4px 7px;background:transparent;color:#dce5f3;font-size:18px}select{width:100%;background:#101823;color:#eef3fa;border:1px solid #425269;border-radius:6px;padding:8px;font:12px system-ui}.buttons{display:flex;gap:7px;margin-top:10px}.buttons button{flex:1}p{margin:10px 0 0;font-size:12px;color:#b9c9dc;white-space:pre-wrap}.modal{position:fixed;inset:0;background:#0009;display:grid;place-items:center;z-index:2147483647}.dialog{background:#17202b;border:1px solid #425269;border-radius:14px;padding:22px;width:min(680px,calc(100vw - 36px));font:14px system-ui;color:#e8edf5}h2{margin:0 0 10px;font-size:20px}textarea{width:100%;min-height:260px;max-height:55vh;resize:vertical;border:1px solid #536782;border-radius:8px;background:#101823;color:#eef3fa;padding:12px;font:13px/1.5 system-ui}label{display:block;margin-bottom:10px}.collapsed .body{display:none}a{color:#8bd7be}
  </style><section class="panel"><div class="top"><strong>ZeronCourier</strong><button class="tiny" id="collapse" title="Collapse panel">−</button></div><div class="body"><label for="chat">Destination: Zeron chat</label><select id="chat" aria-label="Target Zeron chat"><option value="">Choose a Zeron chat in configured project</option></select><p>Your open ChatGPT conversation is the source.</p><p id="detected" role="status"></p><div class="buttons"><button id="send">Send to Zeron</button><button id="report" class="secondary">Bring back report</button></div><div class="buttons"><button id="paste" class="secondary">Paste instruction</button><button id="refresh" class="secondary">Refresh chats</button><button id="setup" class="secondary">Setup</button></div><p id="status" role="status">Select a Zeron destination, then detect or paste an instruction.</p></div></section>`;
  const $ = selector => root.querySelector(selector);
  const status = text => { $('#status').textContent = text; };
  const liveStyle = document.createElement('style');
  liveStyle.textContent = `.live{display:flex;align-items:center;gap:9px;margin:12px 0 3px;font-weight:650;color:#adbacb}.live[data-tone="blue"]{color:#82baff}.live[data-tone="green"]{color:#8be0b7}.live[data-tone="amber"]{color:#ffd081}.live[data-tone="red"]{color:#ff9595}.live[data-tone="purple"]{color:#c6acff}.lamp{width:9px;height:9px;border-radius:50%;background:currentColor;flex:none}.live[data-loading="true"] .lamp{width:13px;height:13px;background:transparent;border:2px solid currentColor;border-right-color:transparent;animation:zeroncourier-spin .8s linear infinite}.updated{font-size:10px;color:#a4b3c6;margin:0 0 10px}@keyframes zeroncourier-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.lamp{animation:none!important}}button.ready{background:#8be0b7;color:#10231c!important}`;
  root.append(liveStyle);
  const live = document.createElement('div'); live.className = 'live'; live.setAttribute('role', 'status'); live.innerHTML = '<span class="lamp" aria-hidden="true"></span><span id="live-label">Choose a Zeron chat</span>';
  const updated = document.createElement('p'); updated.className = 'updated'; updated.textContent = 'Live status updates every 8 seconds';
  $('#chat').after(live, updated);
  let liveState = null, liveChat = '', polling = false, pollTimer, operation = false;
  function indicator(label, tone = 'gray', loading = false) {
    $('#live-label').textContent = label; live.dataset.tone = tone; live.dataset.loading = String(loading);
  }
  function buttons() {
    const occupied = busy || operation;
    $('#refresh').disabled = occupied;
    $('#paste').disabled = occupied;
    $('#send').disabled = occupied || Boolean(liveState && !liveState.canSend);
    $('#report').disabled = occupied || Boolean(liveState && !liveState.reportReady && liveState.activity !== 'report-imported');
    $('#report').textContent = liveState?.reportReady ? 'Report ready — bring back' : 'Bring back report';
    $('#report').classList.toggle('ready', Boolean(liveState?.reportReady));
    for (const direct of document.querySelectorAll('[data-zeroncourier-send="true"]')) {
      direct.disabled = $('#send').disabled; direct.style.opacity = direct.disabled ? '.45' : '1';
    }
  }
  async function pollStatus() {
    clearTimeout(pollTimer);
    const chatId = $('#chat').value, conversation = storageKey();
    if (polling) return;
    if (!chatId) { liveState = null; liveChat = ''; indicator('Choose a Zeron chat'); buttons(); return; }
    polling = true;
    if (liveChat !== chatId) { liveState = null; liveChat = chatId; indicator('Connecting to Zeron…', 'blue', true); }
    try {
      const value = await request(`/api/status?chatId=${encodeURIComponent(chatId)}`);
      if ($('#chat').value !== chatId || storageKey() !== conversation) return;
      liveState = value;
      const states = {
        working: ['Zeron is working', 'blue', true], queued: ['Task queued — waiting for Zeron', 'purple', true],
        'awaiting-input': ['Needs your answer in Zeron', 'amber'], 'delivery-unknown': ['Delivery uncertain — check Zeron', 'amber'],
        'report-ready': [value.reportKind === 'task' ? 'Report ready' : 'Latest report available', 'green'],
        'report-imported': ['Ready — report brought back', 'green'], idle: ['Ready for an instruction', 'green'],
        error: ['Agent error — check Zeron', 'red'], unknown: [`Zeron status: ${value.status || 'unknown'}`, 'amber'],
      };
      if (!operation) indicator(...(states[value.activity] || states.unknown));
      updated.textContent = `Updated ${new Date().toLocaleTimeString()} · every 8s`;
      const option = [...$('#chat').options].find(item => item.value === chatId);
      if (option) option.textContent = `${value.title || option.textContent.split(' · ')[0]} · ${value.status}`;
    } catch (error) {
      if ($('#chat').value !== chatId || storageKey() !== conversation) return;
      liveState = { canSend: false, reportReady: false };
      if (!operation) indicator('Zeron unavailable', 'red');
      updated.textContent = error.message;
    } finally {
      polling = false; buttons();
      pollTimer = setTimeout(pollStatus, document.hidden ? 25000 : 8000);
      if ($('#chat').value !== chatId && $('#chat').value) { clearTimeout(pollTimer); pollTimer = setTimeout(pollStatus, 0); }
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollStatus(); });
  let selection = '', copiedInstruction = '', busy = false, path = location.pathname;
  let copySequence = 0, lastCopyText = '', lastCopyAt = 0;
  const storageKey = () => `courier:${location.pathname}`;
  const prefs = () => GM_getValue(storageKey(), {});
  const save = update => GM_setValue(storageKey(), { ...prefs(), ...update });
  document.addEventListener('selectionchange', () => {
    const current = window.getSelection();
    if (current?.anchorNode && current.anchorNode.getRootNode() !== root && !host.contains(current.anchorNode)) selection = current.toString();
  });
  const request = (route, payload) => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: payload ? 'POST' : 'GET', url: BASE + route,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      ...(payload ? { data: JSON.stringify(payload) } : {}), timeout: 90000,
      onload(response) {
        let body; try { body = JSON.parse(response.responseText); } catch { reject(new Error('Unexpected bridge response. Check Setup.')); return; }
        if (response.status < 200 || response.status >= 300) reject(new Error(body.error || `Bridge error ${response.status}`));
        else resolve(body);
      },
      onerror: () => reject(new Error('Cannot reach the zeroncourier. Run Start ZeronCourier.ps1 on this PC.')),
      ontimeout: () => reject(new Error('The request timed out. Check Zeron before retrying a send.')),
    });
  });
  async function action(fn) {
    if (busy) return; busy = true;
    buttons();
    try { await fn(); } catch (error) { status(error.message); }
    finally { busy = false; buttons(); }
  }
  async function refresh() {
    status('Finding configured project chats…');
    const { chats } = await request('/api/chats');
    const selected = prefs().chatId;
    $('#chat').replaceChildren(new Option('Choose a Zeron chat in configured project', ''));
    for (const chat of chats) $('#chat').add(new Option(`${chat.title} · ${chat.status}`, chat.id));
    if (chats.some(c => c.id === selected)) $('#chat').value = selected;
    status(chats.length ? 'Ready. Choose your Zeron destination, then send detected Markdown or paste an instruction.' : 'No active configured project chats found in Zeron. This list does not contain ChatGPT pinned conversations.');
    pollStatus();
  }
  function target() {
    const chatId = $('#chat').value; if (!chatId) throw new Error('Choose an configured project chat first.'); return chatId;
  }
  // Pure text helpers: keep Markdown intact except an enclosing code fence or explicit task marker.
  function normalizeInstruction(text) {
    let value = String(text || '').replace(/\r\n?/g, '\n').trim();
    const fenced = value.match(/^(`{3,}|~{3,})(?:markdown|md|text)?\s*\n([\s\S]*?)\n\1\s*$/i);
    if (fenced) value = fenced[2].trim();
    return value.replace(/^ZERON_TASK\s*\n/, '').trim();
  }
  function instructionTitle(text) {
    const value = normalizeInstruction(text);
    const first = value.split('\n').find(line => line.trim() && !/^[-_*]{3,}$/.test(line.trim()));
    const line = first?.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '');
    const title = (line || 'pasted instruction').replace(/[*_`]/g, '').trim();
    return title.length > 100 ? title.slice(0, 97) + '…' : title;
  }
  function detectedMarkdown() {
    const last = [...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1);
    if (!last) return '';
    const codes = [...last.querySelectorAll('pre code, pre')].filter(node => node.tagName === 'CODE' || !node.querySelector('code'));
    const marked = codes.find(code => /^ZERON_TASK\s*\n/.test(code.textContent.trim()));
    if (marked) return normalizeInstruction(marked.textContent);
    const markdown = codes.filter(code => /language-(markdown|md)\b/i.test(code.className) || /^\s{0,3}#{1,6}\s+\S/m.test(code.textContent));
    return markdown.length ? normalizeInstruction(markdown.at(-1).textContent) : '';
  }
  function candidateInstruction() {
    if (copiedInstruction) return copiedInstruction;
    if (selection.trim()) return normalizeInstruction(selection);
    const detected = detectedMarkdown(); if (detected) return detected;
    const messages = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    const last = messages.at(-1); if (!last) return '';
    const marked = [...last.querySelectorAll('pre code')].find(code => /^ZERON_TASK\s*\n/.test(code.textContent || ''));
    return marked ? marked.textContent.replace(/^ZERON_TASK\s*\n/, '').trim() : (last.querySelector('.markdown') || last).innerText.trim();
  }
  function dialog({ title, description, text, readonly = false, confirmLabel, onConfirm, instructionPreview = false }) {
    root.querySelector('.modal')?.remove();
    const overlay = document.createElement('div'); overlay.className = 'modal';
    const box = document.createElement('section'); box.className = 'dialog'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h2'); heading.textContent = title;
    const label = document.createElement('label'); label.textContent = description;
    const area = document.createElement('textarea'); area.value = text; area.readOnly = readonly; area.setAttribute('aria-label', title);
    const buttons = document.createElement('div'); buttons.className = 'buttons';
    const confirm = document.createElement('button'); confirm.textContent = confirmLabel;
    if (instructionPreview) {
      const updateTitle = () => { heading.textContent = area.value.trim() ? `Send “${instructionTitle(area.value)}” to Zeron?` : 'Paste an instruction'; confirm.disabled = !normalizeInstruction(area.value); };
      area.addEventListener('input', updateTitle); updateTitle();
    }
    const cancel = document.createElement('button'); cancel.className = 'secondary'; cancel.textContent = 'Cancel';
    cancel.onclick = () => overlay.remove();
    confirm.onclick = async () => {
      if (confirm.disabled) return;
      confirm.disabled = true; cancel.disabled = true;
      try { await onConfirm(area.value); overlay.remove(); }
      catch (error) { status(error.message); confirm.disabled = false; cancel.disabled = false; }
    };
    buttons.append(confirm, cancel); box.append(heading, label, area, buttons); overlay.append(box); root.append(overlay);
    area.focus();
  }
  function insertDraft(text) {
    const composer = document.querySelector('#prompt-textarea[contenteditable="true"], [contenteditable="true"][data-placeholder], textarea#prompt-textarea');
    if (!composer) return false;
    const current = composer.tagName === 'TEXTAREA' ? composer.value : composer.innerText;
    if (current.trim()) return false;
    composer.focus();
    if (composer.tagName === 'TEXTAREA') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, text);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('insertText', false, text);
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    const inserted = composer.tagName === 'TEXTAREA' ? composer.value : composer.innerText;
    return inserted.includes(text.slice(0, Math.min(text.length, 100)));
  }
  function previewInstruction(paste = false, suppliedText) {
    try {
      if (busy || operation) return;
      const chatId = target();
      if (liveChat === chatId && liveState && !liveState.canSend) throw new Error('This Zeron chat cannot accept another task yet. Check its live status above.');
      const conversation = storageKey();
      if (document.querySelector('[data-testid="stop-button"]')) throw new Error('Wait for ChatGPT to finish its response before sending.');
      const instruction = suppliedText ?? (paste ? '' : candidateInstruction());
      if (!paste && !instruction) throw new Error('No instruction found. Use Paste instruction to paste Markdown or plain text.');
      // Keep one ID throughout retries of this preview, so an uncertain request cannot be replayed.
      const requestId = crypto.randomUUID();
      dialog({ title: 'Instruction to send', description: `To: ${$('#chat').selectedOptions[0].textContent}. ${paste ? 'Paste your instruction below.' : 'The full instruction is already loaded.'} Confirm to send it directly to Zeron.`, text: instruction, instructionPreview: true, confirmLabel: 'Send this instruction',
        onConfirm: async text => {
          if (storageKey() !== conversation) throw new Error('The ChatGPT conversation changed. Close this preview and try again.');
          operation = true; buttons(); indicator('Sending to Zeron…', 'blue', true);
          status('Sending this instruction directly to the selected Zeron chat…');
          let result;
          try { result = await request('/api/send', { chatId, text: normalizeInstruction(text), requestId }); }
          catch (error) { indicator('Send failed — check Zeron', 'red'); throw error; }
          finally { operation = false; buttons(); pollStatus(); }
          save({ chatId, requestId: result.job.id });
          if (result.job.status === 'delivery-unknown' || result.job.status === 'sending') {
            status('Delivery is uncertain. Check Zeron before sending anything else.'); return;
          }
          status(result.duplicate ? 'Already submitted. No duplicate instruction was sent.' : 'Instruction accepted. Use Bring back report when the agent finishes.');
          selection = '';
          if (copiedInstruction === instruction) copiedInstruction = '';
        },
      });
    } catch (error) { status(error.message); }
  }
  $('#send').onclick = () => previewInstruction();
  $('#paste').onclick = () => previewInstruction(true);
  function offerCopiedInstruction(text, conversation, sequence) {
    if (conversation !== storageKey() || sequence !== copySequence) return;
    const instruction = normalizeInstruction(text);
    if (!instruction) return;
    // A button click and a native copy event can describe the same copy operation.
    if (instruction === lastCopyText && Date.now() - lastCopyAt < 1200) return;
    if (root.querySelector('.modal')) { status('A preview is already open. Finish or cancel it, then copy your instruction again.'); return; }
    lastCopyText = instruction; lastCopyAt = Date.now(); copiedInstruction = instruction;
    $('.panel').classList.remove('collapsed'); $('#collapse').textContent = '−';
    status(`Copied “${instructionTitle(instruction)}”. ${$('#chat').value ? 'Review it before sending.' : 'Choose a Zeron destination to review and send it.'}`);
    if (!busy && $('#chat').value) previewInstruction(false, instruction);
  }
  function copyButtonSource(button) {
    // Code-block headers often sit beside the <pre>, rather than inside it.
    const message = button.closest('[data-message-author-role]');
    if (message && message.getAttribute('data-message-author-role') !== 'assistant') return '';
    let container = button.parentElement;
    for (let depth = 0; container && depth < 8; depth++, container = container.parentElement) {
      if (container === message || container === document.body) break;
      const codes = [...container.querySelectorAll('pre code, pre, [role="code"]')].filter(node => node.tagName === 'CODE' || !node.querySelector('code'));
      if (codes.length === 1) return codes[0].textContent || '';
      if (codes.length > 1) return '';
      const area = container.querySelector('textarea[readonly]');
      if (area) return area.value;
    }
    return '';
  }
  document.addEventListener('copy', event => {
    if (event.composedPath().includes(host)) return;
    const text = event.clipboardData?.getData('text/plain') || window.getSelection()?.toString();
    if (!text?.trim()) return;
    const conversation = storageKey(), sequence = ++copySequence;
    // Let the page's own handler populate clipboardData before inspecting it.
    setTimeout(() => offerCopiedInstruction(event.clipboardData?.getData('text/plain') || text, conversation, sequence), 0);
  }, true);
  document.addEventListener('click', event => {
    if (event.composedPath().includes(host)) return;
    const button = event.target instanceof Element ? event.target.closest('button, [role="button"]') : null;
    if (!button) return;
    const label = [button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-testid'), button.textContent].filter(Boolean).join(' ');
    const icon = button.querySelector('[data-lucide="copy"], [data-icon="copy"], svg[class*="copy"]');
    if (!/\bcopy\b/i.test(label) && !icon) return;
    const text = copyButtonSource(button);
    if (!text.trim()) { status('Copy detected. Use Paste instruction for this item if its text is not available on the page.'); return; }
    const conversation = storageKey(), sequence = ++copySequence;
    // Read the clicked block, not the system clipboard: no background clipboard polling.
    setTimeout(() => offerCopiedInstruction(text, conversation, sequence), 100);
  }, true);
  $('#report').onclick = () => action(async () => {
    const chatId = target(), conversation = storageKey();
    const requestId = prefs().chatId === chatId && prefs().requestId;
    status('Reading completed report…');
    operation = true; indicator('Fetching report…', 'blue', true);
    let report;
    try { report = await request(`/api/report?chatId=${encodeURIComponent(chatId)}${requestId ? `&requestId=${encodeURIComponent(requestId)}` : ''}`); }
    catch (error) { indicator('Report fetch failed', 'red'); throw error; }
    finally { operation = false; pollStatus(); }
    if (storageKey() !== conversation) throw new Error('The conversation changed while reading. Fetch the report again in the intended chat.');
    if (insertDraft(report.text)) { status('Report inserted as a draft. Review it, then send it to ChatGPT.'); return; }
    dialog({ title: 'Your Zeron report', description: 'Your existing draft was preserved. Copy this report and paste it where you want.', text: report.text, readonly: true, confirmLabel: 'Copy report',
      onConfirm: async text => { GM_setClipboard(text, 'text'); status('Report copied. Paste it into ChatGPT when ready.'); },
    });
  });
  $('#refresh').onclick = () => action(refresh);
  $('#setup').onclick = () => window.open(BASE, '_blank', 'noopener,noreferrer');
  $('#chat').onchange = () => { liveState = null; liveChat = ''; save({ chatId: $('#chat').value, requestId: null }); status('Target saved for this ChatGPT conversation.'); pollStatus(); if (copiedInstruction && $('#chat').value) previewInstruction(false, copiedInstruction); };
  $('#collapse').onclick = () => { $('.panel').classList.toggle('collapsed'); $('#collapse').textContent = $('.panel').classList.contains('collapsed') ? '+' : '−'; };
  setInterval(() => {
    if (location.pathname !== path) { path = location.pathname; selection = ''; copiedInstruction = ''; liveState = null; liveChat = ''; copySequence++; root.querySelector('.modal')?.remove(); action(refresh); }
    const detected = copiedInstruction || detectedMarkdown();
    const message = detected ? `Send “${instructionTitle(detected)}” to Zeron?\n${copiedInstruction ? 'Copied text ready.' : 'Markdown detected.'} Use Send to Zeron to review.` : 'Copy a ChatGPT code block or use Paste instruction.';
    if ($('#detected').textContent !== message) $('#detected').textContent = message;
    for (const pre of document.querySelectorAll('[data-message-author-role="assistant"] pre')) {
      if (pre.previousElementSibling?.getAttribute('data-zeroncourier-send') === 'true') continue;
      const direct = document.createElement('button'); direct.type = 'button'; direct.textContent = 'Send this block to Zeron'; direct.setAttribute('data-zeroncourier-send', 'true');
      direct.style.cssText = 'display:block;margin:8px 0;padding:7px 12px;border:1px solid #8bd7be;border-radius:7px;background:#17202b;color:#8bd7be;font:12px system-ui;cursor:pointer;';
      direct.onclick = event => { event.preventDefault(); event.stopPropagation(); previewInstruction(false, (pre.querySelector('code') || pre).textContent); };
      direct.disabled = $('#send').disabled; direct.style.opacity = direct.disabled ? '.45' : '1';
      pre.before(direct);
    }
  }, 1000);
  action(refresh);
})();
