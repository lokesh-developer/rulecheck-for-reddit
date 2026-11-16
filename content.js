// Shows a panel on Reddit's submit page and checks the draft against the
// subreddit's published rules. Nothing is sent anywhere until the user clicks Check.
(() => {
  const rulesCache = new Map();
  let panel = null;

  const isSubmitPage = () => /\/submit\/?$/.test(location.pathname) || /\/submit\//.test(location.pathname);
  const subFromPath = () => (location.pathname.match(/^\/r\/([A-Za-z0-9_]+)/) || [])[1] || '';

  // New Reddit builds its composer out of web components, so plain querySelector misses it.
  function deepQuery(selector, root = document) {
    const hit = root.querySelector(selector);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const inner = deepQuery(selector, el.shadowRoot);
        if (inner) return inner;
      }
    }
    return null;
  }

  function readDraft() {
    const val = (sel) => { const el = deepQuery(sel); return el ? (el.value ?? el.innerText ?? '').trim() : ''; };
    const title = val('textarea[name="title"]') || val('input[name="title"]');
    const editor = deepQuery('[contenteditable="true"][role="textbox"]') || deepQuery('[contenteditable="true"]');
    const body = val('textarea[name="text"]') || val('textarea[name="body"]') || (editor ? editor.innerText.trim() : '');
    const url = val('textarea[name="link"]') || val('input[name="url"]') || val('textarea[name="url"]');
    return { title, body, url };
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

  function buildPanel() {
    const root = el('div', 'wae-rc');
    const head = el('div', 'wae-rc-head');
    head.append(el('strong', '', 'RuleCheck'));
    const toggle = el('button', 'wae-rc-link', '–');
    toggle.title = 'Collapse';
    head.append(toggle);

    const bodyBox = el('div', 'wae-rc-body');
    const subInput = el('input', 'wae-rc-sub');
    subInput.placeholder = 'subreddit (without r/)';
    const btn = el('button', 'wae-rc-btn', 'Check draft against rules');
    const out = el('div', 'wae-rc-out');
    const foot = el('div', 'wae-rc-foot',
      'Checks published rules only. AutoModerator, karma gates and mod discretion are invisible to this tool.');
    bodyBox.append(subInput, btn, out, foot);
    root.append(head, bodyBox);

    toggle.addEventListener('click', () => {
      const hidden = bodyBox.style.display === 'none';
      bodyBox.style.display = hidden ? '' : 'none';
      toggle.textContent = hidden ? '–' : '+';
    });
    btn.addEventListener('click', () => run(subInput, btn, out));
    root._sub = subInput;
    return root;
  }

  async function run(subInput, btn, out) {
    const sub = subInput.value.trim().replace(/^\/?r\//, '');
    const draft = readDraft();
    out.replaceChildren();
    if (!sub) return void out.append(el('p', 'wae-rc-err', 'Enter the subreddit first.'));
    if (!draft.title && !draft.body) {
      return void out.append(el('p', 'wae-rc-err', "Couldn't read a draft from this page. Type a title or body first."));
    }
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const ctx = await fetchContext(sub);
      for (const b of ctx.blockers) out.append(el('div', 'wae-rc-verdict wae-rc-likely_removed', b));
      const res = await chrome.runtime.sendMessage({ type: 'rulecheck', payload: { sub, ...draft, ctx } });
      if (!res?.ok) throw new Error(res?.error || 'No response from the extension.');
      render(out, res.result, ctx.rules.length);
      out.append(el('div', 'wae-rc-note', sourcesLine(ctx)));
    } catch (e) {
      out.append(el('p', 'wae-rc-err', String(e.message || e)));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Check draft against rules';
    }
  }

  const LABELS = {
    no_published_rule_broken: 'No published rule broken',
    risky: 'Risky',
    likely_removed: 'Likely to be removed',
  };

  function render(out, result, ruleCount) {
    out.append(el('div', `wae-rc-verdict wae-rc-${result.verdict}`, LABELS[result.verdict]));
    if (!ruleCount) out.append(el('p', 'wae-rc-note', 'This subreddit publishes no structured rules; only the sidebar was checked.'));
    for (const v of result.violations) {
      const item = el('div', 'wae-rc-item');
      item.append(el('div', 'wae-rc-rule', v.rule), el('div', '', v.why));
      if (v.fix) item.append(el('div', 'wae-rc-fix', `Fix: ${v.fix}`));
      out.append(item);
    }
    if (result.cannot_verify.length) {
      out.append(el('div', 'wae-rc-note', `Can't verify: ${result.cannot_verify.join('; ')}`));
    }
  }

  function sync() {
    if (isSubmitPage()) {
      if (!panel) { panel = buildPanel(); document.body.append(panel); }
      const sub = subFromPath();
      if (sub && !panel._sub.value) panel._sub.value = sub;
    } else if (panel) {
      panel.remove();
      panel = null;
    }
  }

  // Reddit is a single-page app; there is no reliable navigation event to hook.
  sync();
  setInterval(sync, 1000);
})();
