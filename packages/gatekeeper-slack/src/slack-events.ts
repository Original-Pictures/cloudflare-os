import type {
  SlackEventSubscriptionOptions,
  SlackFile,
  SlackInboundEvent,
  SlackInboundEventKind,
} from "./types.d.ts";

/** Normalized, persistable filter stored alongside a Slack hook initiator. */
export type NormalizedSlackEventSubscription = {
  kinds: SlackInboundEventKind[];
  channelIds?: string[];
};

/** Event kinds delivered to subscriptions created without explicit options. */
export const LEGACY_SLACK_EVENT_KINDS: SlackInboundEventKind[] = [
  "app_mention", "direct_message", "slash_command",
];

const SLACK_EVENT_KINDS = new Set<SlackInboundEventKind>([
  ...LEGACY_SLACK_EVENT_KINDS, "channel_message", "file_shared",
]);

/** Validates and canonicalizes a caller-provided Slack event subscription. */
export function normalizeEventSubscription(
    options?: SlackEventSubscriptionOptions): NormalizedSlackEventSubscription {
  let kinds = options?.kinds ?? LEGACY_SLACK_EVENT_KINDS;
  if (!Array.isArray(kinds) || kinds.length === 0 ||
      !kinds.every((kind): kind is SlackInboundEventKind => SLACK_EVENT_KINDS.has(kind))) {
    throw new Error("Slack event subscription kinds must contain supported event kinds.");
  }
  let channelIds = options?.channelIds;
  if (channelIds !== undefined &&
      (!Array.isArray(channelIds) || channelIds.length === 0 ||
       !channelIds.every(id => typeof id === "string" && /^[CGD][A-Z0-9]+$/.test(id)))) {
    throw new Error("Slack event subscription channelIds must contain Slack conversation IDs.");
  }
  if (kinds.some(kind => kind === "channel_message" || kind === "file_shared") && !channelIds) {
    throw new Error(
        "Slack channel_message and file_shared subscriptions must specify channelIds.");
  }
  return {
    kinds: [...new Set(kinds)],
    ...(channelIds ? {channelIds: [...new Set(channelIds)]} : {}),
  };
}

/** Returns whether an event should start a hook with the supplied filter. */
export function subscriptionMatches(
    subscription: NormalizedSlackEventSubscription, event: SlackInboundEvent): boolean {
  return subscription.kinds.includes(event.kind) &&
      (!subscription.channelIds || subscription.channelIds.includes(event.channelId));
}

function inboundFile(raw: any): SlackFile | null {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  return {
    id: String(raw.id),
    name: String(raw.name ?? raw.title ?? raw.id),
    ...(raw.title ? {title: String(raw.title)} : {}),
    ...(raw.mimetype ? {mimetype: String(raw.mimetype)} : {}),
    ...(Number.isSafeInteger(raw.size) && raw.size >= 0 ? {size: raw.size} : {}),
    ...(raw.permalink ? {permalink: String(raw.permalink)} : {}),
  };
}

/** Maps one signed Slack Events API payload body to the event exposed to Gadget hooks. */
export function parseEventCallback(
    teamId: string, eventId: string | undefined, event: any): SlackInboundEvent | null {
  if (!event || typeof event !== "object") return null;
  if (event.bot_id) return null;
  if (event.type === "message" && event.subtype && event.subtype !== "file_share") return null;
  let files = Array.isArray(event.files)
      ? event.files.map(inboundFile).filter((file: SlackFile | null): file is SlackFile => !!file)
      : [];
  if (event.type === "file_shared") {
    let file = inboundFile(event.file ?? (event.file_id ? {id: event.file_id} : null));
    let channelId = String(event.channel_id ?? "");
    if (!file || !channelId) return null;
    return {
      eventId,
      kind: "file_shared",
      teamId,
      channelId,
      userId: event.user_id ? String(event.user_id) : undefined,
      text: "",
      files: [file],
    };
  }
  let base = {
    eventId,
    teamId,
    channelId: String(event.channel ?? ""),
    userId: event.user ? String(event.user) : undefined,
    text: String(event.text ?? ""),
    ...(files.length > 0 ? {files} : {}),
    ts: event.ts ? String(event.ts) : undefined,
    threadTs: event.thread_ts ? String(event.thread_ts) : (event.ts ? String(event.ts) : undefined),
  };
  if (!base.channelId) return null;
  if (event.type === "app_mention") return {kind: "app_mention", ...base};
  if (event.type === "message" && event.channel_type === "im") {
    return {kind: "direct_message", ...base};
  }
  if (event.type === "message" && event.channel_type === "channel") {
    return {kind: "channel_message", ...base};
  }
  return null;
}
