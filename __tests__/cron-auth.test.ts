import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isCronRequest } from "@/lib/ops/cron-auth";

function request(authorization?: string) {
  return new NextRequest("https://example.test/api/cron/refresh-tokens", {
    headers: authorization ? { authorization } : {},
  });
}

describe("isCronRequest", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts the secret as a bearer token", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isCronRequest(request("Bearer s3cret"))).toBe(true);
  });

  it("refuses a wrong secret and no secret at all", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isCronRequest(request("Bearer nope"))).toBe(false);
    expect(isCronRequest(request())).toBe(false);
  });

  it("refuses everything when no secret is configured", () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("NEXTAUTH_SECRET", "");
    expect(isCronRequest(request("Bearer "))).toBe(false);
    expect(isCronRequest(request("Bearer undefined"))).toBe(false);
  });
});
