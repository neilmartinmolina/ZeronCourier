let token;
const status = document.querySelector('#status');
async function api(path) {
  token ||= (await (await fetch('/pair')).json()).token;
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json(); if (!response.ok) throw new Error(body.error); return body;
}
document.querySelector('#refresh').onclick = async () => {
  status.textContent = 'Connecting to Zeron…';
  try {
    const { chats } = await api('/api/chats');
    const select = document.querySelector('#chats'); select.replaceChildren(new Option('Choose your target chat', ''));
    for (const chat of chats) select.add(new Option(`${chat.title} — ${chat.status}`, chat.id));
    status.textContent = `${chats.length} configured project chat(s) found. Choose the exact chat you want to use.`;
  } catch (error) { status.textContent = error.message; }
};
document.querySelector('#report').onclick = async () => {
  const chatId = document.querySelector('#chats').value;
  if (!chatId) { status.textContent = 'Choose a chat first.'; return; }
  status.textContent = 'Reading completed response…';
  try {
    const report = await api(`/api/report?chatId=${encodeURIComponent(chatId)}`);
    document.querySelector('#report-card').style.display = 'block';
    document.querySelector('#report-text').value = report.text;
    status.textContent = 'Existing report retrieved. No task was sent.';
  } catch (error) { status.textContent = error.message; }
};
document.querySelector('#copy-report').onclick = async () => {
  try { await navigator.clipboard.writeText(document.querySelector('#report-text').value); status.textContent = 'Report copied.'; }
  catch { status.textContent = 'Select the report text and copy it manually.'; }
};
