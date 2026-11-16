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
It shows how your total, post and comment karma compare with theirs, and if you recorded a removal
there, the range the hidden limit probably falls in. It reads public Reddit pages from your session
(one listing plus one request per author), uses no AI credits, and is cached for a day per subreddit.

## Reddit spam-filter risk

Separate from subreddit rules, the panel shows a Low / Medium / High risk that Reddit's own sitewide
filter removes the post, with the reasons: how much you have posted in the last 24 hours, whether this
draft repeats a recent title or link, whether you keep linking the same site, your balance of post and
comment karma, and whether the draft links to a download, a link shortener, a file host or a chat invite.
A timer shows how long to wait before posting again. The filter itself is private, so these are warning
signs and the waiting times are this tool's rule of thumb. Your recent posts are read from your own
profile in your browser and are not sent to the AI provider.

## Privacy

Each check sends the draft, the subreddit's rule sources, and your karma and account age (no username)
to the AI provider you chose, using your own key. Nothing is sent to We Are Engineer.

## What it cannot see

Only published rules and sidebar text. AutoModerator config, karma and account-age gates,
moderator discretion and Reddit's spam filters are invisible, so the best verdict is
"no published rule broken", never "safe".

## Not built yet

- Hosted paid tier (backend proxy, accounts, billing).

The privacy policy is in [PRIVACY.md](PRIVACY.md). Icon sources are in `icons/src`.
