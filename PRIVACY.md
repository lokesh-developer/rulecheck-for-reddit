# Privacy Policy for RuleCheck for Reddit

Last updated: 17 November 2026

RuleCheck for Reddit ("the extension") is a browser extension made by We Are Engineer
(https://projects.weareengineer.com). It checks a draft Reddit post against a subreddit's rules
before you submit it. It is not affiliated with or endorsed by Reddit.

## The short version

- We Are Engineer runs no server for this extension and receives none of your data.
- The extension has no analytics, no tracking, no advertising and no accounts.
- Your draft leaves your browser only when you ask for a check, and it goes only to the AI provider
  you chose, using your own API key.

## What the extension reads

All of this is read inside your browser, from the Reddit pages and data your own logged-in session
can already see.

| Data | Why it is read |
|---|---|
| The title, body and link of the post you are drafting | To check it against the rules and to apply fixes you ask for |
| The subreddit's rules, posting guidance, wiki rules pages, flair list, posting limits and settings | To know what the subreddit requires |
| Your Reddit karma, account age and whether your email is verified | To warn you about karma and account-age limits |
| Your Reddit username | Only to look up your own recent posts. It is never sent to an AI provider |
| The titles, times, subreddits and links of your own recent posts | To warn you about posting too often or repeating a post |
| The public karma and account age of up to 40 people who recently posted in a subreddit | Only when you click "Estimate the hidden karma limit". Their usernames are not stored |

## What leaves your browser, and where it goes

**To the AI provider you chose (Google Gemini, OpenAI or Anthropic).** When you click "Fix my post"
or "Just check", or when you have turned on "Check while I type", the extension sends that provider:

- your draft's title, body and link;
- the subreddit's rules and other rule sources listed above;
- your karma, account age and email-verified status.

It does not send your username, your post history or anyone else's data. The request is made with
the API key you entered, so it is handled under your own agreement with that provider and that
provider's privacy policy:

- Google: https://policies.google.com/privacy
- OpenAI: https://openai.com/policies/privacy-policy
- Anthropic: https://www.anthropic.com/legal/privacy

**To Reddit.** The extension requests rule pages, your account details, your recent posts and, when
you ask for an estimate, recent posters' public profiles. These are ordinary requests from your own
session to reddit.com, the same site you are already using.

**To We Are Engineer or anyone else.** Nothing.

## What is stored, and where

The extension stores the following in your browser's local extension storage on your device. It is
not synced and not uploaded.

- your API keys, chosen provider and model names;
- your "Check while I type" setting;
- subreddits you marked with "My post was removed here", with the date and your karma at the time;
- karma estimates for subreddits you checked: lists of numbers without usernames, kept for one day
  before being refreshed.

Your API keys are stored unencrypted in that local storage, as is normal for browser extensions.
Anyone with access to your browser profile could read them.

## Deleting your data

Removing the extension from Chrome deletes everything it stored. You can also clear the API key
fields in the extension's settings at any time. Data already sent to an AI provider is governed by
that provider's retention policy.

## Permissions the extension asks for

- **Storage:** to keep the settings and items listed above on your device.
- **Access to reddit.com:** to show the panel on the post-submit page and read the data listed above.
- **Access to the three AI providers' API addresses:** to send a check to the one you chose.

## Limited use

The extension's use of information received from browser APIs and from the pages you visit adheres
to the Chrome Web Store User Data Policy, including its Limited Use requirements. Data is used only
to provide the rule-checking features described here. It is not sold, not transferred to third
parties except the AI provider you chose as described above, not used for advertising, and not used
to determine creditworthiness or for lending purposes. No human at We Are Engineer can read it,
because it is never sent to us.

## Children

The extension is not directed at children under 13, the minimum age Reddit requires for an account.

## Changes to this policy

If the extension starts handling data differently, this page will be updated and the date at the top
changed before the new version is published.

## Contact

Questions or requests: open an issue at
https://github.com/lokesh-developer/rulecheck-for-reddit/issues or reach us through
https://projects.weareengineer.com.
