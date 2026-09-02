import { chromium, type Browser, type BrowserContext, type Page, type Frame } from "playwright";
import type { Locator } from "../schema/artifact.js";
import type { PolicyCheck } from "../safety/guard.js";
import { SafetyGuard, createPolicyFromEnv } from "../safety/guard.js";
import type { ActionResult, A11yNode, InteractiveElement, PageState, SessionControl, SurfaceDriver } from "./types.js";
import { screenshotWithPiiRedaction } from "../safety/screenshot-redact.js";

export type UrlPolicyCheck = (url: string) => PolicyCheck;

export class PlaywrightSurface implements SurfaceDriver, SessionControl {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private currentFrame: Page | Frame | null = null;
  private paused = false;
  private _controller: "automation" | "human" = "automation";
  private readonly urlPolicyCheck: UrlPolicyCheck;

  readonly sessionId: string;

  constructor(sessionId: string, urlPolicyCheck?: UrlPolicyCheck) {
    this.sessionId = sessionId;
    this.urlPolicyCheck = urlPolicyCheck ?? ((url) => new SafetyGuard(createPolicyFromEnv()).validateUrl(url));
  }

  async launch(headless = true): Promise<void> {
    this.browser = await chromium.launch({ headless });
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
    this.page = await this.context.newPage();
    this.currentFrame = this.page;
  }

  getController(): "automation" | "human" {
    return this._controller;
  }

  async pauseAutomation(): Promise<void> {
    this.paused = true;
    this._controller = "human";
  }

  async resumeAutomation(): Promise<void> {
    this.paused = false;
    this._controller = "automation";
  }

  private async guardAutomation(): Promise<void> {
    if (this.paused) {
      throw new Error("ESCALATED: Automation paused — human in control");
    }
  }

  private getActivePage(): Page | Frame {
    if (!this.currentFrame) throw new Error("Browser not launched");
    return this.currentFrame;
  }

  async navigate(url: string): Promise<void> {
    await this.guardAutomation();
    const policy = this.urlPolicyCheck(url);
    if (!policy.allowed) {
      throw new Error(policy.reason ?? "URL not in allowlist");
    }
    const page = this.page!;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    this.currentFrame = page;
  }

  async switchFrame(frameName: string): Promise<void> {
    await this.guardAutomation();
    const page = this.page!;
    const frame = page.frame({ name: frameName }) ?? page.frame({ url: new RegExp(frameName) });
    if (!frame) {
      // Try iframe by src attribute
      const iframeLocator = page.locator(`iframe[name="${frameName}"], iframe#${frameName}`);
      const element = await iframeLocator.elementHandle();
      if (element) {
        const contentFrame = await element.contentFrame();
        if (contentFrame) {
          this.currentFrame = contentFrame;
          return;
        }
      }
      throw new Error(`Frame not found: ${frameName}`);
    }
    this.currentFrame = frame;
  }

  async switchToMainFrame(): Promise<void> {
    this.currentFrame = this.page!;
  }

  async getState(): Promise<PageState> {
    const page = this.getActivePage();
    const url = page.url();
    const title = await page.title();
    let visibleText = await this.getPageText();
    const accessibilityTree = await this.buildA11yTree(page);
    let interactiveElements = await this.getInteractiveElements(page);
    let frameContext: string | undefined;

    // Include iframe content when workframe is loaded (main menu pattern)
    const rootPage = this.page!;
    if (rootPage !== page || url.includes("main")) {
      try {
        const frame = rootPage.frame({ name: "workframe" });
        const iframeVisible = await rootPage.locator("#workframe").isVisible();
        if (frame && iframeVisible) {
          const frameText = await frame.locator("body").innerText();
          if (frameText.trim()) {
            frameContext = "workframe";
            visibleText += `\n\n--- IFRAME (workframe) ---\n${frameText.slice(0, 3000)}`;
            const frameElements = await this.getInteractiveElements(frame);
            interactiveElements = [...interactiveElements, ...frameElements.map((e) => ({ ...e, id: e.id ? `iframe:${e.id}` : e.id }))];
          }
        }
      } catch {
        // iframe not ready
      }
    }

    return { url, title, visibleText: visibleText.slice(0, 6000), accessibilityTree, interactiveElements, frameContext };
  }

  private async getInteractiveElements(page: Page | Frame): Promise<InteractiveElement[]> {
    try {
      return await page.evaluate(() => {
        const selectors = "input, button, select, textarea, a, [onclick], [role='button']";
        return Array.from(document.querySelectorAll(selectors)).map((el) => {
          const html = el as HTMLElement;
          const input = el as HTMLInputElement;
          const isInput = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
          return {
            tag: el.tagName.toLowerCase(),
            type: input.type || undefined,
            id: el.id || undefined,
            name: input.name || undefined,
            currentValue: isInput ? input.value : undefined,
            text: !isInput ? (html.innerText || html.textContent || "").trim().slice(0, 40) || undefined : undefined,
            role: el.getAttribute("role") || undefined,
          };
        });
      });
    } catch {
      return [];
    }
  }

  private async buildA11yTree(page: Page | Frame): Promise<A11yNode[]> {
    try {
      const snapshot = await page.locator("body").ariaSnapshot();
      return this.parseAriaSnapshot(snapshot);
    } catch {
      return [];
    }
  }

  private parseAriaSnapshot(snapshot: string): A11yNode[] {
    const lines = snapshot.split("\n").filter((l) => l.trim());
    const nodes: A11yNode[] = [];
    for (const line of lines.slice(0, 50)) {
      const match = line.match(/^\s*-?\s*(\w+)(?:\s+"([^"]*)")?/);
      if (match) {
        nodes.push({ role: match[1], name: match[2] ?? "" });
      }
    }
    return nodes;
  }

  async getPageText(): Promise<string> {
    const page = this.getActivePage();
    return (await page.locator("body").innerText()).slice(0, 8000);
  }

  private resolveLocator(locator: Locator) {
    const page = this.getActivePage();

    switch (locator.strategy) {
      case "role":
        if (!locator.role) throw new Error("role locator requires role");
        return locator.name
          ? page.getByRole(locator.role as Parameters<Page["getByRole"]>[0], { name: locator.name })
          : page.getByRole(locator.role as Parameters<Page["getByRole"]>[0]);
      case "table_row": {
        const label = locator.name ?? locator.text ?? "";
        return page.locator("tr").filter({ hasText: label }).locator("input, select, textarea").first();
      }
      case "label":
        return page.getByLabel(locator.name ?? locator.text ?? "");
      case "text":
        return page.getByText(locator.text ?? locator.name ?? "", { exact: false });
      case "css":
        return page.locator(locator.css ?? "");
      case "frame_role":
        return page.getByRole(locator.role as Parameters<Page["getByRole"]>[0], { name: locator.name });
      default:
        throw new Error(`Unknown locator strategy: ${locator.strategy}`);
    }
  }

  private async tryLocator(locator: Locator, timeoutMs = 5000) {
    const candidates = [locator, ...(locator.fallbacks ?? [])];
    for (const candidate of candidates) {
      try {
        const el = this.resolveLocator(candidate);
        await el.waitFor({ state: "visible", timeout: timeoutMs });
        return el;
      } catch {
        continue;
      }
    }
    throw new Error(`Element not found with any locator strategy`);
  }

  async click(locator: Locator): Promise<ActionResult> {
    await this.guardAutomation();
    try {
      const el = await this.tryLocator(locator);
      await el.click();
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async fill(locator: Locator, value: string): Promise<ActionResult> {
    await this.guardAutomation();
    try {
      const el = await this.tryLocator(locator);
      await el.fill(value);
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async select(locator: Locator, value: string): Promise<ActionResult> {
    await this.guardAutomation();
    try {
      const el = await this.tryLocator(locator);
      await el.selectOption(value);
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async press(key: string): Promise<ActionResult> {
    await this.guardAutomation();
    try {
      await this.getActivePage().keyboard.press(key);
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async waitFor(locator: Locator, timeoutMs = 10000): Promise<ActionResult> {
    try {
      await this.tryLocator(locator, timeoutMs);
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async extract(locator: Locator): Promise<string | null> {
    try {
      const el = await this.tryLocator(locator);
      return await el.innerText();
    } catch {
      return null;
    }
  }

  async readInputValue(locator: Locator): Promise<string | null> {
    try {
      const el = await this.tryLocator(locator);
      return await el.inputValue();
    } catch {
      return null;
    }
  }

  async readInputValueByCss(css: string): Promise<string | null> {
    try {
      return await this.getActivePage().locator(css).inputValue();
    } catch {
      return null;
    }
  }

  getActiveUrl(): string {
    return this.getActivePage().url();
  }

  /** Root page URL (not iframe) — used for domain/route allowlist enforcement */
  getRootUrl(): string {
    return this.page?.url() ?? "";
  }

  async waitForAnyText(texts: string[], timeoutMs = 8000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pageText = await this.getPageText();
      if (texts.some((t) => pageText.includes(t))) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  async waitForFrameContent(text: string, timeoutMs = 5000): Promise<boolean> {
    const rootPage = this.page!;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = rootPage.frame({ name: "workframe" });
      if (frame) {
        const content = await frame.locator("body").innerText().catch(() => "");
        if (content.includes(text)) return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  async screenshot(path: string): Promise<{ redacted: boolean; boxes: number }> {
    if (!this.page) return { redacted: false, boxes: 0 };
    return screenshotWithPiiRedaction(this.page, path);
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }
}

export async function createSurface(sessionId: string, headless = true): Promise<PlaywrightSurface> {
  const surface = new PlaywrightSurface(sessionId);
  await surface.launch(headless);
  return surface;
}
