import { describe, expect, it } from "vitest";
import { noteApiCall, takeApiUsageReport } from "@/lib/meta/api-usage";

function response(url: string, headers: Record<string, string> = {}) {
  const r = new Response("{}", { headers });
  Object.defineProperty(r, "url", { value: url });
  return r;
}

describe("api usage report", () => {
  it("counts calls by kind, keeps the latest usage, and starts over after a report", () => {
    expect(takeApiUsageReport()).toBeNull();

    noteApiCall(response("https://graph.instagram.com/v25.0/123/comments?limit=50"));
    noteApiCall(response("https://graph.instagram.com/v25.0/456/comments"));
    noteApiCall(response("https://graph.instagram.com/v25.0/123/messages", { "x-app-usage": '{"call_count":40}' }));
    noteApiCall(response("https://graph.instagram.com/v25.0/123"));

    expect(takeApiUsageReport()).toBe(
      'calls={"comments":2,"messages":1,"object":1} app={"call_count":40} account=-'
    );
    expect(takeApiUsageReport()).toBeNull();
  });
});
