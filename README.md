# RuleCheck for Reddit

Chrome extension (Manifest V3). On Reddit's submit page it reads your draft, fetches the
subreddit's published rules, and asks an LLM which rules the draft breaks and how to fix it.
By [We Are Engineer](https://projects.weareengineer.com). Unofficial; not affiliated with Reddit.

## Install for development

1. Open `chrome://extensions`, turn on Developer mode.
2. Load unpacked, select this folder.
3. Click the extension icon, paste an API key for Gemini, OpenAI or Anthropic, save.
4. Open `https://www.reddit.com/r/<subreddit>/submit` and write a draft.

## How it works

- "Fix my post" checks the draft and rewrites it to follow the rules in one click. "Just check" only reports.
- Checking while you type is off by default because it uses more API credits. Turn it on in the settings;
  it then checks about two seconds after you stop typing, at most once every six seconds.
- A badge on the corner of the post editor shows the result: a tick, or the number of issues.
- Each issue can also offer its own one-click fix.
  "Undo" reverts the last change.

## Account check

As soon as the subreddit is known, before any AI call, the panel shows your karma and account age,
compares them with any limit the subreddit publishes, and warns when they are low enough that hidden
AutoModerator limits commonly remove posts. "My post was removed here" remembers a removal in this
browser so the warning is specific next time. Unpublished limits themselves cannot be read by any tool.

"Estimate the hidden karma limit" looks up the karma of up to 40 people whose recent posts stayed up.
The lowest of them is a ceiling on any hidden limit. It reads public Reddit pages from your session
(one listing plus one request per author), uses no AI credits, and is cached for a day per subreddit.

## Privacy

Each check sends the draft, the subreddit's rule sources, and your karma and account age (no username)
to the AI provider you chose, using your own key. Nothing is sent to We Are Engineer.

## What it cannot see

Only published rules and sidebar text. AutoModerator config, karma and account-age gates,
moderator discretion and Reddit's spam filters are invisible, so the best verdict is
"no published rule broken", never "safe".

## Not built yet

- Hosted paid tier (backend proxy, accounts, billing).
- Privacy policy page, required for the Chrome Web Store listing.
- Placeholder icons need replacing.
