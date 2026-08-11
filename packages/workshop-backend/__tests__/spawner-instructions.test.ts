import {describe, expect, it} from "vitest";
import {formatSpawnerInstructions} from "../src/agent";

describe("formatSpawnerInstructions", () => {
  it("returns an empty string when unset", () => {
    expect(formatSpawnerInstructions(undefined)).toBe("");
    expect(formatSpawnerInstructions("")).toBe("");
    expect(formatSpawnerInstructions("   \n  ")).toBe("");
  });

  it("wraps instructions in a clearly-delimited, trimmed block", () => {
    const out = formatSpawnerInstructions("  You are a triage agent.  ");
    expect(out).toContain("# Agent-specific instructions");
    expect(out).toContain("<agent_instructions>\nYou are a triage agent.\n</agent_instructions>");
    // The persona is trimmed, not padded, so the cache-stable prefix stays byte-stable.
    expect(out).not.toContain("  You are a triage agent.  ");
  });

  it("preserves internal formatting of multi-line instructions", () => {
    const body = "Line one.\n\n- bullet a\n- bullet b";
    const out = formatSpawnerInstructions(body);
    expect(out).toContain(`<agent_instructions>\n${body}\n</agent_instructions>`);
  });
});
