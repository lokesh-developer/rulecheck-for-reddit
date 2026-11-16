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
  const isVisible = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 20 && r.height > 8 && (e.checkVisibility?.({ visibilityProperty: true }) ?? true);
  };

  // Serialised copies of the post and captcha tokens are not prose.
  const looksLikeData = (s) => {
    const t = s.trim();
    if (/^[{[]/.test(t)) { try { JSON.parse(t); return true; } catch { /* prose that starts with a bracket */ } }
    return t.length > 80 && !/\s/.test(t);
  };

  // The body is the editor the author can see. Hidden fields are never read: Reddit's page carries
  // hidden textareas (captcha tokens, serialised copies of the post) whose contents are not prose,
  // and sending one of those as "the body" makes the check judge machine text.
  function findFields() {
    const els = editables();
    const title = els.find((e) => nameOf(e) === 'title') || null;
    const url = els.find((e) => ['link', 'url'].includes(nameOf(e)) || e.type === 'url') || null;
    const usable = (e) => e !== title && e !== url && isVisible(e) && !looksLikeData(textOf(e))
      && !/captcha|token|flair|search/i.test(nameOf(e));
    const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
    const best = (list) => {
      const filled = list.filter((e) => textOf(e).trim());
      return (filled.length ? filled : list).sort((x, y) => area(y) - area(x))[0] || null;
    };
    // New Reddit's post editor lives in <shreddit-composer>: a rich-text box in rich mode,
    // a textarea in markdown mode. Anything outside it is only a fallback (old Reddit, redesigns).
    const composer = deepAll('shreddit-composer[name="body"]')[0] || deepAll('shreddit-composer')[0];
    const inComposer = composer ? els.filter((e) => {
      for (let n = e; n; n = n.parentNode || n.host) if (n === composer) return true;
      return false;
    }).filter(usable) : [];
    const outermost = (list) => list.filter((e) => !list.some((o) => o !== e && o.contains(e)));
    const body = best(outermost(inComposer)) || best(outermost(els.filter(usable)));
    return { title, body, url };
  }
  let memo = { at: 0, val: null };
  function fields() {
    const v = memo.val;
    if (!v || Date.now() - memo.at > 1000 || [v.title, v.body, v.url].some((e) => e && !e.isConnected)) {
      memo = { at: Date.now(), val: findFields() };
    }
    return memo.val;
  }
  const isPlain = (el) => el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
  const textOf = (el) => (el ? (isPlain(el) ? el.value : el.innerText) || '' : '');

  function readDraft() {
    const f = fields();
    return { title: textOf(f.title).trim(), body: textOf(f.body).trim(), url: textOf(f.url).trim() };
  }

  const squash = (s) => s.replace(/\s+/g, ' ').trim();

  // Writes into Reddit's own fields. With `quote`, swaps just that passage; without, replaces everything.
  // Reddit's fields keep their own state and ignore values set from script, so every edit is made
  // the way a person would make it: focus, select, then type or paste. The result is read back, and
  // false is returned unless the field really holds the intended text.
  async function writeField(el, text, quote) {
    if (!el) return false;
    const before = textOf(el);
    if (quote != null && !before.includes(quote)) return false;
    // Deleting a sentence shouldn't leave a double space behind.
    if (quote != null && text === '' && before.includes(`${quote} `)) quote += ' ';
    const want = quote != null ? before.replace(quote, () => text) : text;
    const landed = () => squash(textOf(el)) === squash(want);
    if (landed()) return true;

    el.focus();
    if (isPlain(el)) {
      const at = quote != null ? before.indexOf(quote) : 0;
      el.setSelectionRange(at, quote != null ? at + quote.length : before.length);
      document.execCommand(text === '' ? 'delete' : 'insertText', false, text);
      await sleep(150); // controlled fields re-render from their own state
      return landed();
    }

    // Rich editor. Each blank line would become an empty paragraph, so paragraphs are one newline apart.
    const paste = text.replace(/\n{2,}/g, '\n');
    const sel = getSelection();
    if (quote != null) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node, at = -1;
      while ((node = walker.nextNode())) { at = node.data.indexOf(quote); if (at >= 0) break; }
      if (!node) return false; // passage spans formatting; caller falls back
      sel.setBaseAndExtent(node, at, node, at + quote.length);
    } else {
      sel.setBaseAndExtent(el, 0, el, el.childNodes.length);
    }
    await sleep(80); // the editor learns about the new selection asynchronously
    if (paste === '') {
      document.execCommand('delete');
    } else {
      const dt = new DataTransfer();
      dt.setData('text/plain', paste);
      const unhandled = el.dispatchEvent(new ClipboardEvent('paste',
        { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
      if (unhandled) document.execCommand('insertText', false, paste);
    }
    await sleep(250); // editors repaint asynchronously
    return landed();
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
    const [rulesJson, about, wikiIndex, wikiRules, flairs, reqs, me] = await Promise.all([
      get(`/r/${sub}/about/rules.json`),
      opt(`/r/${sub}/about.json`),
      opt(`/r/${sub}/wiki/index.json`),
      opt(`/r/${sub}/wiki/rules.json`),
      opt(`/r/${sub}/api/link_flair_v2.json`),
      opt(`/api/v1/${sub}/post_requirements`),
      opt('/api/me.json'),
    ]);
    const a = about?.data || {};
    const u = me?.data || me || {};
    const out = {
      // Rules marked comment-only don't apply to a post.
      rules: (rulesJson.rules || []).filter((r) => r.kind !== 'comment')
        .map((r) => ({ name: r.short_name, description: r.description })),
      submitText: a.submit_text || '',
      sidebar: a.description || '',
      wiki: [wikiRules?.data?.content_md, wikiIndex?.data?.content_md].filter(Boolean).join('\n\n').slice(0, 8000),
      flairs: Array.isArray(flairs) ? flairs.map((f) => f.text).filter(Boolean).slice(0, 40) : [],
      // This endpoint can answer 200 with an error body when the session isn't accepted.
      requirements: reqs && typeof reqs === 'object' && !reqs.error && !reqs.json?.errors
        && 'title_text_max_length' in reqs ? reqs : null,
      settings: {
        submission_type: a.submission_type, subreddit_type: a.subreddit_type, allow_polls: a.allow_polls,
        restrict_posting: a.restrict_posting, allow_images: a.allow_images,
        allow_videos: a.allow_videos, over18: a.over18,
      },
      account: u.created_utc ? {
        link_karma: u.link_karma || 0, comment_karma: u.comment_karma || 0,
        total_karma: u.total_karma ?? ((u.link_karma || 0) + (u.comment_karma || 0)),
        age_days: Math.floor((Date.now() / 1000 - u.created_utc) / 86400),
        verified_email: u.has_verified_email,
      } : null,
      // Facts that need no AI at all.
      blockers: [
        a.user_is_banned && 'You are banned from this subreddit.',
        u.is_suspended && 'Your Reddit account is suspended.',
        a.subreddit_type === 'private' && !a.user_is_contributor && 'This subreddit is private and you are not an approved member.',
        a.subreddit_type === 'restricted' && a.user_is_contributor === false && a.user_is_moderator === false
          && 'Only approved users can post in this subreddit.',
      ].filter(Boolean),
    };
    rulesCache.set(sub, out);
    return out;
  }

  // Limits the moderators configured are enforced by Reddit itself at submit, so they are
  // checked here in code. They are facts about the draft, not judgements, and need no AI.
  function limitFindings(ctx, d) {
    const req = ctx.requirements || {};
    const out = [];
    const add = (rule, why, fix) => out.push({
      rule, why, fix, source: 'requirements', rule_quote: '', field: 'none', quote: '', replacement: '',
    });
    const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
    const has = (text, s) => text.toLowerCase().includes(String(s).toLowerCase());
    // Moderators write these patterns for Reddit's server; ones this browser can't run are skipped.
    const matchesAny = (patterns, text) => {
      let ran = 0;
      for (const p of patterns) {
        try { ran++; if (new RegExp(p).test(text)) return true; } catch { ran--; }
      }
      return ran === 0;
    };
    const checkText = (label, text, k) => {
      const min = req[`${k}_text_min_length`], max = req[`${k}_text_max_length`];
      if (min && text.length < min) add(`${label} too short`, `The ${k} is ${text.length} characters; this subreddit requires at least ${min}.`, `Lengthen the ${k}.`);
      if (max && text.length > max) add(`${label} too long`, `The ${k} is ${text.length} characters; this subreddit allows at most ${max}.`, `Shorten the ${k}.`);
      const need = list(req[`${k}_required_strings`]);
      if (need.length && !need.some((s) => has(text, s))) add(`${label} is missing required text`, `The ${k} must contain one of: ${need.join(', ')}`, `Add one of them to the ${k}.`);
      const banned = list(req[`${k}_blacklisted_strings`]).filter((s) => has(text, s));
      if (banned.length) add(`${label} contains banned text`, `Not allowed in the ${k} here: ${banned.join(', ')}`, 'Remove it.');
      const patterns = list(req[`${k}_regexes`]);
      if (patterns.length && !matchesAny(patterns, text)) add(`${label} format`, `The ${k} doesn't match the format this subreddit requires.`, "Check the subreddit's posting guidelines for the required format.");
    };
    if (d.title) checkText('Title', d.title, 'title');
    if (req.body_restriction_policy === 'required' && !d.body) add('Body required', 'This subreddit requires text in the post body.', 'Write a body.');
    if (req.body_restriction_policy === 'notAllowed' && d.body) add('Body not allowed', "This subreddit doesn't allow text in the post body.", 'Remove the body text.');
    if (d.body && req.body_restriction_policy !== 'notAllowed') checkText('Body', d.body, 'body');

    const hosts = [d.url, ...(d.body.match(/https?:\/\/[^\s)\]]+/g) || [])].filter(Boolean).map((u) => {
      try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, ''); } catch { return ''; }
    }).filter(Boolean);
    const under = (host, domain) => host === domain || host.endsWith(`.${domain}`);
    const blocked = hosts.filter((h) => list(req.domain_blacklist).some((dom) => under(h, dom)));
    if (blocked.length) add('Banned link', `This subreddit doesn't allow links to: ${[...new Set(blocked)].join(', ')}`, 'Remove the link.');
    const allowed = list(req.domain_whitelist);
    const outside = allowed.length ? hosts.filter((h) => !allowed.some((dom) => under(h, dom))) : [];
    if (outside.length) add('Link not on the allowed list', `Only these sites may be linked here: ${allowed.join(', ')}`, 'Remove the link.');
    if (d.url && ctx.settings.submission_type === 'self') add('Text posts only', 'This subreddit accepts text posts only, not link posts.', 'Post it as a text post.');

    for (const f of accountGate(ctx).fails) add('Account requirement', f, 'Build karma by commenting first, or post in a subreddit without this limit.');
    const notes = [];
    if (req.is_flair_required) notes.push('this subreddit requires a post flair, so pick one before posting');
    return { findings: out, notes };
  }

  // Below these, unpublished AutoModerator gates commonly remove posts. They are rules of thumb,
  // not any subreddit's real threshold, which moderators keep private.
  const LOW_KARMA = 100;
  const NEW_ACCOUNT_DAYS = 30;

  // Karma and account-age gates are the commonest reason a rule-abiding post is removed, and they
  // don't depend on the draft, so they are worked out as soon as the subreddit is known.
  function accountGate(ctx) {
    const acct = ctx.account;
    const text = [
      ...ctx.rules.map((r) => `${r.name}. ${r.description || ''}`),
      ctx.submitText, ctx.requirements?.guidelines_text, ctx.wiki, ctx.sidebar,
    ].filter(Boolean).join('\n');
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
    const mentions = [...new Set(sentences.filter((s) => /\bkarma\b|account age|days? old|weeks? old|months? old|new accounts?/i.test(s)))]
      .slice(0, 3).map((s) => (s.length > 220 ? `${s.slice(0, 220)}…` : s));
    const fails = [];
    if (acct) {
      for (const s of mentions) {
        const k = s.match(/(\d[\d,]*)\s*\+?\s*(?:[a-z]+\s+){0,2}karma|karma\s+(?:[a-z]+\s+){0,4}?(\d[\d,]*)/i);
        if (k) {
          const need = Number((k[1] || k[2]).replace(/,/g, ''));
          const [kind, have] = /comment karma/i.test(s) ? ['comment karma', acct.comment_karma]
            : /(post|link) karma/i.test(s) ? ['post karma', acct.link_karma] : ['karma', acct.total_karma];
          if (need > 0 && have < need) fails.push(`You have ${have} ${kind}; this subreddit asks for ${need}.`);
        }
        const d = s.match(/(\d+)\s*(day|week|month|year)s?(?:\s+old|\s+of age)?/i);
        if (d && /account|old/i.test(s)) {
          const need = Number(d[1]) * { day: 1, week: 7, month: 30, year: 365 }[d[2].toLowerCase()];
          if (acct.age_days < need) fails.push(`Your account is ${acct.age_days} days old; this subreddit asks for ${need} days.`);
        }
      }
    }
    const low = acct && !fails.length && (acct.total_karma < LOW_KARMA || acct.age_days < NEW_ACCOUNT_DAYS);
    return { acct, mentions, fails, low };
  }

  // A hidden karma limit can't be read, but it can be bounded: removed posts vanish from the
  // subreddit and surviving ones stay, so nobody who posted successfully was under the limit.
  // The lowest-karma recent poster is therefore a ceiling on where the limit can be.
  // Reddit serves the newest-posts list in several formats and refuses some of them to some
  // sessions, so each is tried in turn. Every one returns [{ author, created (unix seconds) }]
  // with moderators' and pinned posts left out where the format says which those are.
  async function recentPosts(sub) {
    const page = async (path) => {
      const r = await fetch(`${location.origin}${path}`, { credentials: 'include' });
      if (!r.ok) throw new Error(String(r.status));
      return r;
    };
    const real = (a) => a && a !== '[deleted]' && a !== 'AutoModerator';
    const sources = {
      async json() {
        const j = await (await page(`/r/${sub}/new.json?limit=100&raw_json=1`)).json();
        return (j?.data?.children || []).map((ch) => ch.data)
          .filter((p) => p && !p.stickied && p.distinguished !== 'moderator' && !p.removed_by_category)
          .map((p) => ({ author: p.author, created: p.created_utc }));
      },
      async feed() {
        const xml = new DOMParser().parseFromString(await (await page(`/r/${sub}/new/.rss?limit=100`)).text(), 'text/xml');
        return [...xml.querySelectorAll('entry')].map((e) => ({
          author: (e.querySelector('author > name')?.textContent || '').replace(/^\/?u\//, ''),
          created: Date.parse(e.querySelector('published, updated')?.textContent || '') / 1000,
        }));
      },
      async html() {
        const out = [];
        let path = `/r/${sub}/new/`;
        for (let i = 0; i < 4 && path; i++) { // the page lists a few posts and links to the next batch
          const doc = new DOMParser().parseFromString(await (await page(path)).text(), 'text/html');
          for (const p of doc.querySelectorAll('shreddit-post[author]')) {
            if (p.hasAttribute('stickied') || p.hasAttribute('pinned')) continue;
            out.push({ author: p.getAttribute('author'), created: Date.parse(p.getAttribute('created-timestamp') || '') / 1000 });
          }
          path = doc.querySelector('faceplate-partial[src*="more-posts"]')?.getAttribute('src') || '';
        }
        return out;
      },
    };
    const failures = [];
    for (const [name, load] of Object.entries(sources)) {
      try {
        const posts = (await load()).filter((p) => real(p.author) && Number.isFinite(p.created));
        if (posts.length >= 5) return posts;
        failures.push(`${name}: ${posts.length} posts`);
      } catch (e) {
        failures.push(`${name}: ${e.message}`);
      }
    }
    throw new Error(`Reddit wouldn't give the list of recent posts (${failures.join(', ')}).`);
  }

  const SAMPLE_AUTHORS = 40;
  async function estimateGate(sub) {
    const key = sub.toLowerCase();
    const { gateEstimates = {} } = await chrome.storage.local.get({ gateEstimates: {} });
    if (gateEstimates[key] && Date.now() - gateEstimates[key].at < 86400000) return gateEstimates[key];

    const posts = await recentPosts(sub);
    const firstPost = new Map();
    for (const p of posts) if (!firstPost.has(p.author)) firstPost.set(p.author, p);
    const authors = [...firstPost.keys()].slice(0, SAMPLE_AUTHORS);

    const people = [];
    const refused = [];
    let next = 0;
    const worker = async () => {
      while (next < authors.length) {
        const name = authors[next++];
        const r = await fetch(`${location.origin}/user/${encodeURIComponent(name)}/about.json`, { credentials: 'include' }).catch(() => null);
        if (!r?.ok) { refused.push(r?.status || 'network error'); continue; }
        const u = (await r.json().catch(() => null))?.data;
        if (!u || u.is_suspended || u.created_utc == null) continue;
        people.push({
          total: u.total_karma ?? ((u.link_karma || 0) + (u.comment_karma || 0)),
          comment: u.comment_karma || 0,
          // Age on the day they posted, which is what a limit would have tested.
          ageDays: Math.max(0, Math.floor((firstPost.get(name).created - u.created_utc) / 86400)),
        });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker)); // a few at a time, to stay polite to Reddit
    if (people.length < 5) {
      throw new Error(refused.length
        ? `found ${authors.length} recent posters, but Reddit refused their profile lookups (${refused[0]}).`
        : `only ${people.length} usable recent posters, too few to estimate from.`);
    }

    const min = (k) => Math.min(...people.map((x) => x[k]));
    const est = { at: Date.now(), n: people.length, total: min('total'), comment: min('comment'), ageDays: min('ageDays') };
    gateEstimates[key] = est;
    await chrome.storage.local.set({ gateEstimates });
    return est;
  }

  function showEstimate(box, est, acct) {
    box.replaceChildren();
    const under = acct && (acct.total_karma < est.total || acct.age_days < est.ageDays);
    box.append(el('div', `wae-rc-verdict wae-rc-${under ? 'risky' : 'no_published_rule_broken'}`,
      under ? 'You are below every recent poster who got through.' : 'Accounts like yours have posted here recently.'));
    box.append(el('div', 'wae-rc-note',
      `Of the last ${est.n} people whose posts stayed up, the lowest had ${est.total} karma (${est.comment} comment karma) and the newest account was ${est.ageDays} days old when it posted.`));
    box.append(el('div', 'wae-rc-note',
      `So any hidden limit is at most about ${est.total} karma and ${est.ageDays} days. It may be lower: this is a ceiling from a sample, not the real number, and karma shown is today's, not on the day they posted.`));
  }

  let preSub = '';
  async function preflight() {
    const sub = ui.subInput.value.trim().replace(/^\/?r\//, '');
    if (!sub || sub === preSub) return;
    preSub = sub;
    ui.pre.replaceChildren(el('div', 'wae-rc-note', `Reading r/${sub}…`));
    try {
      const ctx = await fetchContext(sub);
      const { removedIn = {} } = await chrome.storage.local.get({ removedIn: {} });
      if (preSub === sub) renderPreflight(sub, ctx, removedIn[sub.toLowerCase()]);
    } catch (e) {
      if (preSub === sub) ui.pre.replaceChildren(el('div', 'wae-rc-note', `Couldn't read r/${sub}. Check the name.`));
    }
  }

  function renderPreflight(sub, ctx, removed) {
    const box = ui.pre;
    box.replaceChildren();
    const g = accountGate(ctx);
    const warn = (cls, msg) => box.append(el('div', `wae-rc-verdict wae-rc-${cls}`, msg));
    for (const b of ctx.blockers) warn('likely_removed', b);
    for (const f of g.fails) warn('likely_removed', f);
    if (removed) {
      warn('likely_removed', `A post of yours was removed here on ${removed.on} when you had ${removed.karma} karma.`
        + (g.acct ? ` You have ${g.acct.total_karma} now.` : ''));
    } else if (g.low) {
      warn('risky', `Your account has ${g.acct.total_karma} karma and is ${g.acct.age_days} days old. Many subreddits automatically remove posts from low-karma or new accounts, and they keep the limit private.`);
    }
    if (g.acct) {
      box.append(el('div', 'wae-rc-note', `Your account: ${g.acct.total_karma} karma (${g.acct.link_karma} post, ${g.acct.comment_karma} comment), ${g.acct.age_days} days old.`));
    } else {
      box.append(el('div', 'wae-rc-note', "Couldn't read your karma. Are you logged in to Reddit?"));
    }
    for (const m of g.mentions) box.append(el('div', 'wae-rc-quote', `r/${sub} says: “${m}”`));
    if (!g.mentions.length) {
      box.append(el('div', 'wae-rc-note', `r/${sub} publishes no karma or account-age limit. It may still enforce a hidden one; no tool can read those.`));
    }
    const estBox = el('div', 'wae-rc-pre');
    const estBtn = button('wae-rc-btn2', 'Estimate the hidden karma limit', async () => {
      estBtn.disabled = true;
      estBtn.textContent = 'Looking at recent posters…';
      try {
        showEstimate(estBox, await estimateGate(sub), g.acct);
        estBtn.remove();
      } catch (e) {
        estBox.replaceChildren(el('div', 'wae-rc-note', `Couldn't estimate: ${e.message || e}`));
        estBtn.disabled = false;
        estBtn.textContent = 'Estimate the hidden karma limit';
      }
    });
    estBtn.title = 'Checks the karma of people whose recent posts stayed up. Uses Reddit only, no AI credits.';
    box.append(estBtn, estBox);
    if (g.acct && !removed) {
      box.append(button('wae-rc-link2', 'My post was removed here', async () => {
        const { removedIn = {} } = await chrome.storage.local.get({ removedIn: {} });
        removedIn[sub.toLowerCase()] = { on: new Date().toISOString().slice(0, 10), karma: g.acct.total_karma };
        await chrome.storage.local.set({ removedIn });
        renderPreflight(sub, ctx, removedIn[sub.toLowerCase()]);
      }));
    }
  }

  function sourcesLine(ctx) {
    return 'Checked: ' + [
      `${ctx.rules.length} rules`,
      ctx.submitText && 'posting guidance',
      ctx.sidebar && 'sidebar',
      ctx.wiki && 'wiki',
      ctx.flairs.length && 'flair list',
      ctx.requirements && "the moderators' posting limits",
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
    subInput.addEventListener('change', preflight);
    const fixBtn = button('wae-rc-btn', 'Fix my post', () => run(true, true));
    fixBtn.title = 'Checks the draft and rewrites it to follow the rules. You can undo it.';
    const btn = button('wae-rc-btn2', 'Just check', () => run(true));
    const pre = el('div', 'wae-rc-pre');
    const out = el('div', 'wae-rc-out');
    const foot = el('div', 'wae-rc-foot',
      'Your draft is sent to your chosen AI provider for each check. AutoModerator, karma gates and mod discretion are invisible to this tool.');
    bodyBox.append(subInput, pre, fixBtn, btn, out, foot);
    root.append(head, bodyBox);

    function setOpen(open) {
      bodyBox.hidden = !open;
      toggle.textContent = open ? '–' : '+';
    }
    ui = { subInput, pre, btn, fixBtn, out, setOpen, isOpen: () => !bodyBox.hidden };
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
      const limits = limitFindings(ctx, draft);
      const result = {
        ...res.result,
        violations: [...limits.findings, ...res.result.violations],
        verdict: limits.findings.length ? 'likely_removed' : res.result.verdict,
        cannot_verify: [...limits.notes, ...res.result.cannot_verify],
      };
      const fix = render(result, ctx, draft);
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
        // Put back anything a failed attempt disturbed before asking the user to do it by hand.
        for (const name of new Set(failed.map((e) => e.field))) {
          if (f[name] && squash(textOf(f[name])) !== squash(undo[name])) await writeField(f[name], undo[name]);
        }
        const text = failed.map((e) => (e.quote == null ? e.text : `${e.quote} → ${e.text || '(delete)'}`)).join('\n\n');
        const copied = await navigator.clipboard.writeText(text).then(() => true, () => false);
        const which = [...new Set(failed.map((e) => e.field))].join(' and ');
        say(`Couldn't change the ${which} automatically. ${copied ? 'The new text is copied; paste it in yourself.' : 'Change it by hand using the fixes below.'}`);
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
      if (v.rule_quote) item.append(el('div', 'wae-rc-quote', `The rule says: “${v.rule_quote}”`));
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
    const preview = draft.body.replace(/\s+/g, ' ').slice(0, 70);
    out.append(el('div', 'wae-rc-note', `Read from this page: title ${draft.title.length} characters, body ${draft.body.length} characters${preview ? `, starting “${preview}…”` : ''}`));
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
      if (document.activeElement !== ui.subInput) preflight();
      placeBadge();
    } else if (panel) {
      panel.remove();
      badge.remove();
      panel = badge = ui = null;
      preSub = '';
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
