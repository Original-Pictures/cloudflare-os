import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeEventSubscription,
  parseEventCallback,
  subscriptionMatches,
} from "./slack-events.ts";

test("channel messages preserve the event ID, thread target, and file metadata", () => {
  let event = parseEventCallback("T123", "Ev123", {
    type: "message",
    channel_type: "channel",
    channel: "C0BHL9V598R",
    user: "U123",
    text: "Meeting transcript",
    ts: "1700000000.000001",
    files: [{id: "F123", name: "transcript.txt", mimetype: "text/plain", size: 42}],
  });

  assert.deepEqual(event, {
    eventId: "Ev123",
    kind: "channel_message",
    teamId: "T123",
    channelId: "C0BHL9V598R",
    userId: "U123",
    text: "Meeting transcript",
    files: [{id: "F123", name: "transcript.txt", mimetype: "text/plain", size: 42}],
    ts: "1700000000.000001",
    threadTs: "1700000000.000001",
  });
});

test("file_shared events expose a stable file reference", () => {
  assert.deepEqual(parseEventCallback("T123", "Ev456", {
    type: "file_shared",
    channel_id: "C0BHL9V598R",
    user_id: "U123",
    file_id: "F456",
  }), {
    eventId: "Ev456",
    kind: "file_shared",
    teamId: "T123",
    channelId: "C0BHL9V598R",
    userId: "U123",
    text: "",
    files: [{id: "F456", name: "F456"}],
  });
});

test("filters are canonicalized and matched before hook delivery", () => {
  let subscription = normalizeEventSubscription({
    kinds: ["channel_message", "channel_message"],
    channelIds: ["C0BHL9V598R", "C0BHL9V598R"],
  });
  assert.deepEqual(subscription, {
    kinds: ["channel_message"],
    channelIds: ["C0BHL9V598R"],
  });
  assert.equal(subscriptionMatches(subscription, {
    kind: "channel_message",
    teamId: "T123",
    channelId: "C0BHL9V598R",
    text: "yes",
  }), true);
  assert.equal(subscriptionMatches(subscription, {
    kind: "channel_message",
    teamId: "T123",
    channelId: "COTHER",
    text: "no",
  }), false);
});

test("default subscriptions do not receive ambient channel traffic", () => {
  let subscription = normalizeEventSubscription();
  assert.equal(subscriptionMatches(subscription, {
    kind: "channel_message",
    teamId: "T123",
    channelId: "C0BHL9V598R",
    text: "not delivered",
  }), false);
});

test("ambient channel event kinds require an explicit channel allowlist", () => {
  assert.throws(
      () => normalizeEventSubscription({kinds: ["channel_message"]}),
      /must specify channelIds/);
});

test("bot messages and message mutations are ignored", () => {
  assert.equal(parseEventCallback("T123", "Ev1", {
    type: "message", channel_type: "channel", channel: "C123", bot_id: "B123",
  }), null);
  assert.equal(parseEventCallback("T123", "Ev2", {
    type: "message", channel_type: "channel", channel: "C123", subtype: "message_changed",
  }), null);
});
