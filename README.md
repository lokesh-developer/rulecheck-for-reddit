# RuleCheck for Reddit

Chrome extension (Manifest V3). On Reddit's submit page it reads your draft, fetches the
subreddit's published rules, and asks an LLM which rules the draft breaks and how to fix it.
By [We Are Engineer](https://projects.weareengineer.com). Unofficial; not affiliated with Reddit.

## Install for development

1. Open `chrome://extensions`, turn on Developer mode.
2. Load unpacked, select this folder.
3. Click the extension icon, paste an API key for Gemini, OpenAI or Anthropic, save.
4. Open `https://www.reddit.com/r/<subreddit>/submit`, write a draft, click the check button.

## What it cannot see

Only published rules and sidebar text. AutoModerator config, karma and account-age gates,
moderator discretion and Reddit's spam filters are invisible, so the best verdict is
"no published rule broken", never "safe".

## Not built yet

- Hosted paid tier (backend proxy, accounts, billing).
- Privacy policy page, required for the Chrome Web Store listing.
- Placeholder icons need replacing.
