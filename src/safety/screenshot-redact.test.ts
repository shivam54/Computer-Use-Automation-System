import { describe, it, expect, beforeEach } from "vitest";
import { extractPiiSubstrings, textContainsPii } from "./pii-patterns.js";
import { mergePixelBoxes, blurRegionsOnPng } from "./screenshot-redact.js";
import sharp from "sharp";

describe("PII patterns", () => {
  it("detects financial and identity strings", () => {
    const text = "Member Name: Jane Doe\nSavings Balance: $12,450.75\nSSN 123-45-6789";
    const hits = extractPiiSubstrings(text);
    expect(hits.some((h) => h.includes("Jane Doe"))).toBe(true);
    expect(hits.some((h) => h.includes("12,450.75"))).toBe(true);
    expect(hits.some((h) => h.includes("123-45-6789"))).toBe(true);
    expect(textContainsPii(text)).toBe(true);
  });

  it("matches currency-only value cells", () => {
    expect(textContainsPii("$12,450.75")).toBe(true);
    expect(textContainsPii("Jane Doe")).toBe(false);
  });

  it("ignores benign text", () => {
    expect(textContainsPii("Operator Sign-In")).toBe(false);
  });
});

describe("Screenshot redaction helpers", () => {
  it("merges overlapping boxes", () => {
    const merged = mergePixelBoxes([
      { x: 0, y: 0, width: 50, height: 20 },
      { x: 40, y: 0, width: 50, height: 20 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.width).toBe(90);
  });

  it("blurs regions on a PNG buffer", async () => {
    const base = await sharp({
      create: { width: 100, height: 50, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();

    const redacted = await blurRegionsOnPng(base, [{ x: 10, y: 10, width: 30, height: 10 }]);
    expect(redacted.length).toBeGreaterThan(0);
    expect(redacted.equals(base)).toBe(false);
  });
});
