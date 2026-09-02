import fs from "fs/promises";
import type { Frame, Locator, Page } from "playwright";
import sharp from "sharp";

export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const BLUR_SIGMA = 14;
const BOX_PADDING = 4;

/** Value-only selectors — blur financial balances only (labels and member identity stay visible) */
export const SENSITIVE_VALUE_SELECTORS = ".val-savings, .val-checking";

/** Collect balance boxes using Playwright boundingBox (main-viewport coords, iframe-aware) */
export async function collectPiiBoundingBoxes(page: Page): Promise<PixelBox[]> {
  const boxes: PixelBox[] = [];

  for (const frame of page.frames()) {
    try {
      await addLocatorBoxes(boxes, frame.locator(".val-savings, .val-checking"));
      // Standalone currency values (balance cells without mock-app classes)
      await addLocatorBoxes(boxes, frame.locator("td, span").filter({ hasText: /^\$[\d,]+\.\d{2}$/ }));
    } catch {
      // frame detached
    }
  }

  return mergePixelBoxes(boxes);
}

/** Merge overlapping boxes to reduce composite work */
export function mergePixelBoxes(boxes: PixelBox[]): PixelBox[] {
  if (boxes.length === 0) return [];
  const sorted = [...boxes].sort((a, b) => a.x - b.x || a.y - b.y);
  const merged: PixelBox[] = [];

  for (const box of sorted) {
    const last = merged[merged.length - 1];
    if (!last || !boxesOverlap(last, box)) {
      merged.push({ ...box });
      continue;
    }
    const x1 = Math.min(last.x, box.x);
    const y1 = Math.min(last.y, box.y);
    const x2 = Math.max(last.x + last.width, box.x + box.width);
    const y2 = Math.max(last.y + last.height, box.y + box.height);
    merged[merged.length - 1] = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }
  return merged;
}

function boxesOverlap(a: PixelBox, b: PixelBox): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

async function addLocatorBoxes(target: PixelBox[], locator: Locator): Promise<void> {
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    const box = await locator.nth(i).boundingBox();
    if (box && box.width > 0 && box.height > 0) {
      target.push(box);
    }
  }
}

/** Legacy export for unit tests */
export async function collectPiiBoxesInFrame(frame: Frame): Promise<PixelBox[]> {
  const boxes: PixelBox[] = [];
  await addLocatorBoxes(boxes, frame.locator(".val-savings, .val-checking"));
  return boxes;
}

/** Blur rectangular regions on a PNG buffer */
export async function blurRegionsOnPng(pngBuffer: Buffer, boxes: PixelBox[]): Promise<Buffer> {
  if (boxes.length === 0) return pngBuffer;

  const meta = await sharp(pngBuffer).metadata();
  const imgWidth = meta.width ?? 0;
  const imgHeight = meta.height ?? 0;
  if (imgWidth === 0 || imgHeight === 0) return pngBuffer;

  const composites: sharp.OverlayOptions[] = [];

  for (const box of boxes) {
    const left = Math.max(0, Math.floor(box.x - BOX_PADDING));
    const top = Math.max(0, Math.floor(box.y - BOX_PADDING));
    const width = Math.min(imgWidth - left, Math.ceil(box.width + BOX_PADDING * 2));
    const height = Math.min(imgHeight - top, Math.ceil(box.height + BOX_PADDING * 2));
    if (width < 1 || height < 1) continue;

    const blurred = await sharp(pngBuffer)
      .extract({ left, top, width, height })
      .blur(BLUR_SIGMA)
      .toBuffer();

    composites.push({ input: blurred, left, top });
  }

  if (composites.length === 0) return pngBuffer;
  return sharp(pngBuffer).composite(composites).png().toBuffer();
}

export function isScreenshotRedactionEnabled(): boolean {
  return process.env.SCREENSHOT_REDACT_PII !== "false";
}

/** Capture screenshot with content-aware PII blur (sensitive values only) */
export async function screenshotWithPiiRedaction(page: Page, outputPath: string): Promise<{ redacted: boolean; boxes: number }> {
  const boxes = await collectPiiBoundingBoxes(page);
  const buffer = await page.screenshot({ fullPage: false, scale: "css" });
  if (!isScreenshotRedactionEnabled()) {
    await fs.writeFile(outputPath, buffer);
    return { redacted: false, boxes: 0 };
  }

  const redacted = await blurRegionsOnPng(buffer, boxes);
  await fs.writeFile(outputPath, redacted);
  return { redacted: boxes.length > 0, boxes: boxes.length };
}
