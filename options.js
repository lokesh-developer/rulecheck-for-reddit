const PROVIDERS = ['gemini', 'openai', 'anthropic'];
const DEFAULTS = {
  provider: 'gemini',
  models: { gemini: 'gemini-2.5-flash', openai: 'gpt-4o-mini', anthropic: 'claude-haiku-5-5' },
  keys: { gemini: '', openai: '', anthropic: '' },
};
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(DEFAULTS).then((s) => {
  document.querySelector(`input[name=provider][value=${s.provider}]`).checked = true;
  for (const p of PROVIDERS) {
    $(`key-${p}`).value = s.keys?.[p] || '';
    $(`model-${p}`).value = s.models?.[p] || DEFAULTS.models[p];
  }
});

$('save').addEventListener('click', async () => {
  const provider = document.querySelector('input[name=provider]:checked').value;
  const keys = {}, models = {};
  for (const p of PROVIDERS) {
    keys[p] = $(`key-${p}`).value.trim();
    models[p] = $(`model-${p}`).value.trim() || DEFAULTS.models[p];
  }
  await chrome.storage.local.set({ provider, keys, models });
  $('status').textContent = 'Saved';
  setTimeout(() => ($('status').textContent = ''), 1500);
});
