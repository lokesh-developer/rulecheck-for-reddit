// Panel + badge on Reddit's submit page. Checks the draft against the subreddit's
// rule sources after the user pauses typing, and can write fixes back into the post.
(() => {
  const DEBOUNCE_MS = 2000;   // wait this long after the last keystroke
  const MIN_GAP_MS = 6000;    // never call the provider more often than this
  const MIN_CHARS = 15;       // don't auto-check a few stray characters

  const rulesCache = new Map();
  let panel = null, badge = null, ui = null;
  let autoOn = false, timer = null, inFlight = false, pending = false;
  let lastKey = '', lastRun = 0, undo = null;

  // Checking while typing costs a provider call per pause, so it is opt-in from the settings page.
  chrome.storage.local.get({ autoCheck: false }).then((s) => { autoOn = s.autoCheck; });
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.autoCheck) return;
    autoOn = changes.autoCheck.newValue;
    if (!autoOn) clearTimeout(timer);
  });

  const isSubmitPage = () => /\/submit\/?$/.test(location.pathname) || /\/submit\//.test(location.pathname);
  const subFromPath = () => (location.pathname.match(/^\/r\/([A-Za-z0-9_]+)/) || [])[1] || '';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // New Reddit builds its composer out of web components, so plain querySelector misses it.
  function deepAll(selector, root = document, out = []) {
    for (const e of root.querySelectorAll(selector)) if (!e.closest('.wae-rc')) out.push(e);
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) deepAll(selector, e.shadowRoot, out);
    return out;
  }

  // Walking every shadow root is slow, so the list of editable elements is reused for a moment.
  let scan = { at: 0, els: [] };
  function editables() {
    if (Date.now() - scan.at > 2000 || scan.els.some((e) => !e.isConnected)) {
      scan = { at: Date.now(), els: deepAll('textarea, input[name="title"], input[name="url"], [contenteditable]:not([contenteditable="false"])') };
    }
    return scan.els;
  }
  // The field's name is sometimes on the element and sometimes on the web component wrapping it.
  const nameOf = (e) => e.getAttribute('name') || e.getRootNode().host?.getAttribute?.('name') || '';
  const isVisible = (e) => { const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 8; };

  // Reddit keeps several candidate body fields on the page at once (the rich editor, a markdown
  // textarea, hidden form mirrors), and which one holds the text depends on the editor mode.
  // So the body is whichever editable currently holds the most text, not the first match.
  function fields() {
    const els = editables();
    const title = els.find((e) => nameOf(e) === 'title') || null;
    const url = els.find((e) => ['link', 'url'].includes(nameOf(e))) || null;
    const rest = els.filter((e) => e !== title && e !== url
      && !els.some((o) => o !== e && o !== title && o.contains(e)));
    const score = (e) => textOf(e).trim().length * 4 + (isVisible(e) ? 2 : 0) + (isPlain(e) ? 0 : 1);
    const body = rest.sort((x, y) => score(y) - score(x))[0] || null;
    return { title, body, url };
  }
  const isPlain = (el) => el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
  const textOf = (el) => (el ? (isPlain(el) ? el.value : el.innerText) || '' : '');

  function readDraft() {
    const f = fields();
    return { title: textOf(f.title).trim(), body: textOf(f.body).trim(), url: textOf(f.url).trim() };
  }

  // Writes into Reddit's own fields. With `quote`, swaps just that passage; without, replaces everything.
  // Returns false when the field refused the edit, so the caller can fall back to the clipboard.
  async function writeField(el, text, quote) {
    if (!el) return false;
    const before = textOf(el);
    if (quote != null && !before.includes(quote)) return false;
    // Deleting a sentence shouldn't leave a double space behind.
    if (quote != null && text === '' && before.includes(`${quote} `)) quote += ' ';
    if (isPlain(el)) {
      const next = quote != null ? before.replace(quote, () => text) : text;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, next);
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return textOf(el) !== before;
    }
    // Rich editor: it keeps its own state, so edits have to arrive as user-like input.
    const range = document.createRange();
    if (quote != null) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node, at = -1;
      while ((node = walker.nextNode())) { at = node.data.indexOf(quote); if (at >= 0) break; }
      if (!node) return false; // passage spans formatting; caller falls back
      range.setStart(node, at);
      range.setEnd(node, at + quote.length);
    } else {
      range.selectNodeContents(el);
    }
    el.focus();
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (text === '') {
      document.execCommand('delete');
    } else {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const unhandled = el.dispatchEvent(new ClipboardEvent('paste',
        { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
      if (unhandled) document.execCommand('insertText', false, text);
    }
    await sleep(150); // editors repaint asynchronously
    return textOf(el) !== before;
  }

  // Everything here is read from the user's own logged-in session, the same data
  // their browser can already see. Only the published rules are mandatory; every
  // other source is optional because many subreddits don't have it or hide it.
  async function fetchContext(sub) {
    if (rulesCache.has(sub)) return rulesCache.get(sub);
    const get = async (path) => {
      const r = await fetch(`${location.origin}${path}`, { credentials: 'include' });
      if (!r.ok) throw new Error(`Reddit returned ${r.status} for ${path}`);
      return r.json();
    };
    const opt = (path) => get(path).catch(() => null);
    const [rulesJson, about, wikiIndex, wikiRules, hot, flairs, reqs, me] = await Promise.all([
      get(`/r/${sub}/about/rules.json`),
      opt(`/r/${sub}/about.json`),
      opt(`/r/${sub}/wiki/index.json`),
      opt(`/r/${sub}/wiki/rules.json`),
      opt(`/r/${sub}/hot.json?limit=5`),
      opt(`/r/${sub}/api/link_flair_v2.json`),
      opt(`/api/v1/${sub}/post_requirements.json`),
      opt('/api/me.json'),
    ]);
    const a = about?.data || {};
    const u = me?.data || me || {};
    const out = {
      rules: (rulesJson.rules || []).map((r) => ({ name: r.short_name, description: r.description })),
      sidebar: [a.submit_text, a.description].filter(Boolean).join('\n\n'),
      wiki: [wikiRules?.data?.content_md, wikiIndex?.data?.content_md].filter(Boolean).join('\n\n').slice(0, 8000),
      pinned: (hot?.data?.children || []).map((c) => c.data).filter((p) => p?.stickied)
        .map((p) => ({ title: p.title, text: (p.selftext || '').slice(0, 3000) })),
      flairs: Array.isArray(flairs) ? flairs.map((f) => f.text).filter(Boolean).slice(0, 40) : [],
      requirements: reqs && typeof reqs === 'object' && !reqs.error ? reqs : null,
      settings: {
        submission_type: a.submission_type, subreddit_type: a.subreddit_type,
        restrict_posting: a.restrict_posting, allow_images: a.allow_images,
        allow_videos: a.allow_videos, over18: a.over18,
      },
      account: u.created_utc ? {
        link_karma: u.link_karma, comment_karma: u.comment_karma,
        age_days: Math.floor((Date.now() / 1000 - u.created_utc) / 86400),
        verified_email: u.has_verified_email,
      } : null,
      // Facts that need no AI at all.
      blockers: [
        a.user_is_banned && 'You are banned from this subreddit.',
        a.subreddit_type === 'private' && !a.user_is_contributor && 'This subreddit is private and you are not an approved member.',
        a.subreddit_type === 'restricted' && a.user_is_contributor === false && a.user_is_moderator === false
          && 'Only approved users can post in this subreddit.',
      ].filter(Boolean),
    };
    rulesCache.set(sub, out);
    return out;
  }

  function sourcesLine(ctx) {
    return 'Checked: ' + [
      `${ctx.rules.length} rules`,
      ctx.sidebar && 'sidebar',
      ctx.wiki && 'wiki',
      ctx.pinned.length && `${ctx.pinned.length} pinned post(s)`,
      ctx.flairs.length && 'flair list',
      ctx.requirements && 'post requirements',
      ctx.account && 'your karma and account age',
    ].filter(Boolean).join(', ');
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(cls, text, onClick) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function buildPanel() {
    const root = el('div', 'wae-rc');
    const head = el('div', 'wae-rc-head');
    head.append(el('strong', '', 'RuleCheck'));
    const toggle = button('wae-rc-link', '–', () => setOpen(bodyBox.hidden));
    toggle.title = 'Collapse';
    head.append(toggle);

    const bodyBox = el('div', 'wae-rc-body');
    const subInput = el('input', 'wae-rc-sub');
    subInput.placeholder = 'subreddit (without r/)';
    subInput.addEventListener('input', schedule);
    const fixBtn = button('wae-rc-btn', 'Fix my post', () => run(true, true));
    fixBtn.title = 'Checks the draft and rewrites it to follow the rules. You can undo it.';
    const btn = button('wae-rc-btn2', 'Just check', () => run(true));
    const out = el('div', 'wae-rc-out');
    const foot = el('div', 'wae-rc-foot',
      'Your draft is sent to your chosen AI provider for each check. AutoModerator, karma gates and mod discretion are invisible to this tool.');
    bodyBox.append(subInput, fixBtn, btn, out, foot);
    root.append(head, bodyBox);

    function setOpen(open) {
      bodyBox.hidden = !open;
      toggle.textContent = open ? '–' : '+';
    }
    ui = { subInput, btn, fixBtn, out, setOpen, isOpen: () => !bodyBox.hidden };
    return root;
  }

  // The badge sits on the corner of the post editor, like a writing assistant's.
  const BADGE = {
    idle: ['·', 'RuleCheck: waiting for a draft'],
    busy: ['…', 'RuleCheck: checking'],
    error: ['!', 'RuleCheck: check failed, click for details'],
    no_published_rule_broken: ['✓', 'RuleCheck: no published rule broken'],
  };
  function setBadge(state, count) {
    if (!badge) return;
    const [text, title] = BADGE[state] || [String(count || '!'), `RuleCheck: ${count} issue(s) found, click to see them`];
    badge.textContent = text;
    badge.title = title;
    badge.dataset.state = state;
  }
  function placeBadge() {
    if (!badge) return;
    const f = fields();
    const anchor = f.body || f.title;
    const r = anchor?.getBoundingClientRect();
    const visible = r && r.width > 40 && r.bottom > 0 && r.top < innerHeight;
    badge.hidden = !visible;
    if (visible) {
      badge.style.left = `${Math.round(r.right - 34)}px`;
      badge.style.top = `${Math.round(Math.min(r.bottom, innerHeight) - 34)}px`;
    }
  }

  function schedule() {
    if (!autoOn || !panel) return;
    clearTimeout(timer);
    timer = setTimeout(() => run(false), Math.max(DEBOUNCE_MS, MIN_GAP_MS - (Date.now() - lastRun)));
  }

  async function run(manual, autofix) {
    const sub = ui.subInput.value.trim().replace(/^\/?r\//, '');
    const draft = readDraft();
    const size = draft.title.length + draft.body.length;
    if (!sub || !size || (!manual && size < MIN_CHARS)) {
      if (manual) {
        ui.out.replaceChildren(el('p', 'wae-rc-err', sub
          ? "Couldn't read a draft from this page. Type a title or body first."
          : 'Enter the subreddit first.'));
      }
      return;
    }
    const key = JSON.stringify([sub, draft]);
    if (!manual && key === lastKey) return;
    if (inFlight) { pending = true; return; }
    inFlight = true;
    lastKey = key;
    lastRun = Date.now();
    ui.btn.disabled = ui.fixBtn.disabled = true;
    (autofix ? ui.fixBtn : ui.btn).textContent = autofix ? 'Fixing…' : 'Checking…';
    setBadge('busy');
    try {
      const ctx = await fetchContext(sub);
      const res = await chrome.runtime.sendMessage({ type: 'rulecheck', payload: { sub, ...draft, ctx } });
      if (!res?.ok) throw new Error(res?.error || 'No response from the extension.');
      const fix = render(res.result, ctx, draft);
      if (autofix) await fix();
    } catch (e) {
      showError(String(e.message || e));
    } finally {
      inFlight = false;
      ui.btn.disabled = ui.fixBtn.disabled = false;
      ui.btn.textContent = 'Just check';
      ui.fixBtn.textContent = 'Fix my post';
      if (pending) { pending = false; schedule(); }
    }
  }

  function showError(message) {
    setBadge('error');
    ui.out.replaceChildren(el('p', 'wae-rc-err', message));
    if (/No API key/.test(message)) {
      ui.out.append(button('wae-rc-btn2', 'Open settings', () => chrome.runtime.sendMessage({ type: 'rulecheck-options' })));
    }
  }

  const LABELS = {
    no_published_rule_broken: 'No published rule broken',
    risky: 'Risky',
    likely_removed: 'Likely to be removed',
  };

  function render(result, ctx, draft) {
    const out = ui.out;
    out.replaceChildren();
    const note = el('div', 'wae-rc-note');
    const say = (msg) => { note.textContent = msg; };

    for (const b of ctx.blockers) out.append(el('div', 'wae-rc-verdict wae-rc-likely_removed', b));
    out.append(el('div', `wae-rc-verdict wae-rc-${result.verdict}`, LABELS[result.verdict]));
    if (!ctx.rules.length) out.append(el('p', 'wae-rc-note', 'This subreddit publishes no structured rules; only the other sources were checked.'));

    // A quick fix is only offered when the quoted passage is really in the draft.
    const quick = result.violations.filter((v) => v.field !== 'none' && v.quote && draft[v.field].includes(v.quote));
    const hasRewrite = result.rewritten_title || result.rewritten_body;

    const apply = async (edits, done) => {
      const f = fields();
      undo = { title: textOf(f.title), body: textOf(f.body) };
      const failed = [];
      for (const e of edits) {
        if (!(await writeField(f[e.field], e.text, e.quote))) failed.push(e);
      }
      if (failed.length) {
        const text = failed.map((e) => e.text).filter(Boolean).join('\n\n');
        const copied = text && await navigator.clipboard.writeText(text).then(() => true, () => false);
        say(copied
          ? "Reddit's editor refused the edit. The new text is copied; paste it in yourself."
          : "Reddit's editor refused the edit. Change it by hand using the fix above.");
      } else {
        say(done);
      }
      undoBtn.hidden = failed.length === edits.length;
    };

    const rewrite = () => apply([
      result.rewritten_title && { field: 'title', text: result.rewritten_title },
      result.rewritten_body && { field: 'body', text: result.rewritten_body },
    ].filter(Boolean), 'Post rewritten. Read it before you submit, or press Undo.');
    const applyQuick = () => apply(
      quick.map((v) => ({ field: v.field, text: v.replacement, quote: v.quote })),
      'Quick fixes applied. Read it before you submit, or press Undo.');

    const bar = el('div', 'wae-rc-bar');
    if (hasRewrite) bar.append(button('wae-rc-btn2', 'Rewrite my post', rewrite));
    if (quick.length > 1) bar.append(button('wae-rc-btn2', `Apply all ${quick.length} quick fixes`, applyQuick));
    const undoBtn = button('wae-rc-btn2', 'Undo', async () => {
      const f = fields();
      await writeField(f.title, undo.title);
      await writeField(f.body, undo.body);
      undoBtn.hidden = true;
      say('Last change undone.');
    });
    undoBtn.hidden = true;
    bar.append(undoBtn);
    out.append(bar, note);

    for (const v of result.violations) {
      const item = el('div', 'wae-rc-item');
      item.append(el('div', 'wae-rc-rule', v.rule), el('div', '', v.why));
      if (v.fix) item.append(el('div', 'wae-rc-fix', `Fix: ${v.fix}`));
      if (quick.includes(v)) {
        const change = el('div', 'wae-rc-change');
        change.append(el('del', '', v.quote));
        if (v.replacement) change.append(' → ', el('ins', '', v.replacement));
        item.append(change, button('wae-rc-btn2', v.replacement ? 'Apply' : 'Remove it', (ev) => {
          ev.currentTarget.disabled = true;
          apply([{ field: v.field, text: v.replacement, quote: v.quote }], 'Fix applied.');
        }));
      }
      out.append(item);
    }
    if (result.cannot_verify.length) {
      out.append(el('div', 'wae-rc-note', `Can't verify: ${result.cannot_verify.join('; ')}`));
    }
    out.append(el('div', 'wae-rc-note', sourcesLine(ctx)));
    // Shown so a misread draft is obvious instead of producing a confident wrong verdict.
    out.append(el('div', 'wae-rc-note', `Read from this page: title ${draft.title.length} characters, body ${draft.body.length} characters.`));
    setBadge(result.verdict, result.violations.length + ctx.blockers.length);

    // What the "Fix my post" button does once the check is back.
    return async () => {
      if (hasRewrite) return rewrite();
      if (quick.length) return applyQuick();
      say(result.violations.length
        ? "This can't be fixed by rewording. See the issues below."
        : 'Nothing to fix.');
    };
  }

  function sync() {
    if (isSubmitPage()) {
      if (!panel) {
        panel = buildPanel();
        badge = button('wae-rc-badge', '·', () => ui.setOpen(!ui.isOpen()));
        setBadge('idle');
        document.body.append(panel, badge);
      }
      const sub = subFromPath();
      if (sub && !ui.subInput.value) ui.subInput.value = sub;
      placeBadge();
    } else if (panel) {
      panel.remove();
      badge.remove();
      panel = badge = ui = null;
      clearTimeout(timer);
      lastKey = '';
    }
  }

  // Typing inside Reddit's web components still surfaces here because input events are composed.
  document.addEventListener('input', (e) => {
    if (panel && !panel.contains(e.target)) schedule();
  }, true);
  addEventListener('scroll', placeBadge, { capture: true, passive: true });
  addEventListener('resize', placeBadge, { passive: true });

  // Reddit is a single-page app; there is no reliable navigation event to hook.
  sync();
  setInterval(sync, 1000);
})();
