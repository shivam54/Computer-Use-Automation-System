import type { Locator } from "../schema/artifact.js";

/** Surface abstraction — seam between "how we perceive/act" and "recorded flow" */
export interface PageState {
  url: string;
  title: string;
  /** Flattened accessibility tree summary */
  accessibilityTree: A11yNode[];
  /** Visible text snippets for LLM context */
  visibleText: string;
  /** Interactive elements the agent can act on */
  interactiveElements: InteractiveElement[];
  /** Which iframe context is active, if any */
  frameContext?: string;
}

export interface InteractiveElement {
  tag: string;
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  role?: string;
  /** Current value for inputs */
  currentValue?: string;
}

export interface A11yNode {
  role: string;
  name: string;
  value?: string;
  children?: A11yNode[];
}

export interface ActionResult {
  success: boolean;
  error?: string;
  extractedValue?: string;
}

export interface SurfaceDriver {
  navigate(url: string): Promise<void>;
  getState(): Promise<PageState>;
  click(locator: Locator): Promise<ActionResult>;
  fill(locator: Locator, value: string): Promise<ActionResult>;
  select(locator: Locator, value: string): Promise<ActionResult>;
  press(key: string): Promise<ActionResult>;
  waitFor(locator: Locator, timeoutMs?: number): Promise<ActionResult>;
  extract(locator: Locator): Promise<string | null>;
  switchFrame(frameName: string): Promise<void>;
  switchToMainFrame(): Promise<void>;
  screenshot(path: string): Promise<{ redacted: boolean; boxes: number }>;
  getPageText(): Promise<string>;
  readInputValue(css: string): Promise<string | null>;
  close(): Promise<void>;
}

export interface SessionControl {
  sessionId: string;
  controller: "automation" | "human";
  pauseAutomation(): Promise<void>;
  resumeAutomation(): Promise<void>;
  getController(): "automation" | "human";
}
