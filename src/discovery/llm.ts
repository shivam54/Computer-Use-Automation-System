import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { LLMMetricsCollector } from "../observability/llm-metrics.js";
import { acquireLlmRateLimit } from "../safety/rate-limit.js";

export type LLMProvider = "anthropic" | "openai";

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
}

export function getLLMConfigFromEnv(): LLMConfig {
  const provider = (process.env.LLM_PROVIDER ?? "anthropic") as LLMProvider;

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey.includes("your-key-here")) {
      throw new Error("Set ANTHROPIC_API_KEY in your .env file");
    }
    return {
      provider: "anthropic",
      apiKey,
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.startsWith("sk-your")) {
    throw new Error("Set OPENAI_API_KEY in your .env file");
  }
  return {
    provider: "openai",
    apiKey,
    model: process.env.OPENAI_MODEL ?? "gpt-4o",
  };
}

/** Unified JSON completion for discovery agent */
export async function completeJSON(
  config: LLMConfig,
  systemPrompt: string,
  userPrompt: string,
  metrics?: LLMMetricsCollector
): Promise<string> {
  acquireLlmRateLimit();
  const callStarted = Date.now();

  if (config.provider === "anthropic") {
    const client = new Anthropic({ apiKey: config.apiKey });
    const response = await client.messages.create({
      model: config.model,
      max_tokens: 1024,
      system: systemPrompt + "\n\nRespond with valid JSON only, no markdown fences.",
      messages: [{ role: "user", content: userPrompt }],
    });

    metrics?.record({
      latencyMs: Date.now() - callStarted,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });

    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      const types = response.content.map((b) => b.type).join(", ");
      throw new Error(`No text block in Claude response (got: ${types})`);
    }
    return block.text.trim();
  }

  const client = new OpenAI({ apiKey: config.apiKey });
  const response = await client.chat.completions.create({
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
  });

  metrics?.record({
    latencyMs: Date.now() - callStarted,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  });

  return response.choices[0]?.message?.content ?? "{}";
}
