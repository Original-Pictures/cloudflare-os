# Slack gatekeeper

Mediates a Gadget's **read-only** access to a user's [Slack](https://slack.com) workspace:
channels, direct messages, threads, members, and search. Runs as its own Cloudflare Worker and is
auto-discovered by the backend from its `GATEKEEPER_SLACK` binding.

Reads are the core of this gatekeeper. It also supports a **two-way** path: a workspace binding can
subscribe to inbound events (app mentions, DMs, slash commands) and post replies or new channel
messages, each queued for the user's approval. See *Two-way* under Auth below.

## Auth

OAuth 2.0 using a **user token** (`xoxp-…`), requested via `user_scope` (not a bot token) so the
agent sees exactly what the connecting user can see — including private channels, DMs, and search.

Create a Slack app (https://api.slack.com/apps) and provide its client credentials to the worker
as `CLIENT_ID` / `CLIENT_SECRET`. For local dev, `run-dev-server.js` maps `SLACK_CLIENT_ID` /
`SLACK_CLIENT_SECRET` (e.g. from a root `.dev.vars`) into those vars.

App configuration:

- **Redirect URL** must match `<BASE_URL>/oauth`, which in local dev defaults to
  `http://localhost:8787/gatekeeper/slack/oauth`.
- **Do NOT enable token rotation** (OAuth & Permissions → *Token Rotation*). It **cannot be turned
  off once enabled**, and it breaks the two-way path: bot tokens are stored as-is and never
  refreshed (see `getBotToken` / the grant handler in `slack.ts`), so a rotating `xoxe.xoxb-…` bot
  token expires after ~12h and replies stop. The user token *is* refreshed via
  `oauth.v2.access?grant_type=refresh_token` and rotation would technically work for a read-only
  user-token-only install — but keeping rotation **off** is simplest and works for both, so leave it
  off. Non-rotating tokens are returned as-is.
- Request the **User Token Scopes** the granted resources need (see below). `users:read` is always
  requested for connected-account display and user-name resolution.

### Two-way (inbound events + replies)

For app mentions, DMs, and slash commands to reach a Gadget — and for `postReply` / `postMessage`
to send — the app also needs **bot** scopes and Event Subscriptions:

- **Bot Token Scopes**: `chat:write`, `app_mentions:read`, `commands`, `im:history`, `im:read`.
- **Event Subscriptions**: Request URL `<BASE_URL>/events`, subscribed to `app_mention` and
  `message.im`. Optionally a slash command → `<BASE_URL>/commands`.
- **`SLACK_SIGNING_SECRET`** (a Wrangler secret, from *Basic Information → App Credentials*) **must
  be set on this Worker**, or `/events` and `/commands` fail closed (401) — Slack can't even verify
  the Request URL. Set it alongside `CLIENT_ID` / `CLIENT_SECRET`.
- A Gadget receives events by calling `SlackWorkspaceSession.subscribe(callback)` where `callback`
  is a **persistent stub created with `ctx.restore()`**; the user must then approve the hook.

## Resources

Access is granted at one of three granularities. Each grantable resource maps to a URL pattern
that drives both consent (which OAuth scopes are requested) and routing:

| Granularity | URL pattern | Session type |
| --- | --- | --- |
| Whole workspace | `https://*` (catch-all whole-instance) | `SlackWorkspaceSession` |
| A conversation (channel, DM, or group DM) | `https://app.slack.com/client/:teamId/:conversationId` | `SlackConversation` |
| A thread | `https://*.slack.com/archives/:conversationId/:messageId` | `SlackThread` |

Workspace grants use the framework's account-wide `https://*` pattern; more-specific conversation
and thread URLs take precedence. Channels and DMs share one "Conversation" grant.

### Scopes per resource (user token scopes)

- **Workspace**: `team:read`, conversation read scopes, `search:read`
- **Conversation**: conversation read scopes, `search:read`
- **Thread**: `channels:history`, `groups:history`, `im:history`, `mpim:history`
- **Always**: `users:read`

where the conversation read scopes are `channels`/`groups`/`im`/`mpim` `:read` + `:history`.

## API

See `src/types.d.ts` for the full Session API (the agent-facing documentation). Highlights:

- `SlackWorkspaceSession`: `getInfo`, `listChannels`, `listDirectMessages`, `listUsers`,
  `getUser`, `getConversation`, `search`, and (two-way) `subscribe`, `postReply`, `postMessage`
- `SlackConversation`: `getInfo`, `members`, `listMessages`, `getThread`, `search`
  (conversation-scoped search is **hard-restricted** to the bound conversation regardless of query)
- `SlackThread`: `getRoot`, `listReplies`

List and search methods return paginated `Cursor` objects. Known mentions are rendered with readable
names.

## Build

```
pnpm --filter @gadgets/slack-gatekeeper build
```
