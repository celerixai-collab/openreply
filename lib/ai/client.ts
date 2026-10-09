import Anthropic from "@anthropic-ai/sdk";

/**
 * The worker holds ANTHROPIC_API_KEY; the web app never needs it (it reads
 * `aiConfigured` from the worker heartbeat instead).
 */
export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/** The one call the assistant makes, so tests can hand in a fake client. */
export type AnthropicMessagesClient = {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming
    ): Promise<Anthropic.Message>;
  };
};

let client: Anthropic | null = null;

export function getAnthropicClient(): AnthropicMessagesClient {
  if (!client) {
    // Reads ANTHROPIC_API_KEY from the environment. The SDK retries 429, 5xx
    // and connection errors itself (maxRetries, default 2).
    client = new Anthropic({ maxRetries: 2, timeout: 90_000 });
  }
  return client;
}
