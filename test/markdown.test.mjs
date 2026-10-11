import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const script = await readFile(new URL('../helper.template.user.js', import.meta.url), 'utf8');
const start = script.indexOf('  function normalizeInstruction(');
const end = script.indexOf('  function detectedMarkdown(', start);
const { normalizeInstruction, instructionTitle } = vm.runInNewContext(script.slice(start, end) + '\n({ normalizeInstruction, instructionTitle })');
test('Markdown heading supplies the title and preserves the instruction body', () => {
  const text = '# InternTrack v0.9.5-beta — P0 Security Remediation Sprint\n## Assignment isolation\n\n**Repository:** `/home/interntrack`\n\nDo the scoped work.\n```php\necho "test";\n```';
  assert.equal(instructionTitle(text), 'InternTrack v0.9.5-beta — P0 Security Remediation Sprint');
  assert.equal(normalizeInstruction(text), text);
});
test('Copied outer Markdown fences and task marker are removed without stripping inner code', () => {
  const body = '# Named task\n\n```js\nrun();\n```';
  assert.equal(normalizeInstruction('````markdown\n' + body + '\n````'), body);
  assert.equal(normalizeInstruction('ZERON_TASK\r\n' + body), body);
  assert.equal(normalizeInstruction('```md\n# Task\nBody\n```'), '# Task\nBody');
});
test('Plain text is accepted and titles are bounded', () => {
  assert.equal(instructionTitle('Inspect the project.\nThen report.'), 'Inspect the project.');
  assert.equal(normalizeInstruction('   Inspect this.   '), 'Inspect this.');
  assert.equal(instructionTitle('x'.repeat(200)).length, 98);
  assert.equal(normalizeInstruction('  '), '');
});
test('Copy confirmation uses the beginning of text rather than a later section heading', () => {
  assert.equal(instructionTitle('Instruction title at the beginning\n\n## Later mission heading\nBody'), 'Instruction title at the beginning');
});
