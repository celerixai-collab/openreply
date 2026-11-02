import { describe, expect, it } from "vitest";
import { findBannedCopy } from "@/lib/utils/banned-copy";

describe("findBannedCopy", () => {
  it("stops copy that says the product is Mac only", () => {
    expect(findBannedCopy({ dmMessage: "目前只支援 Mac" })).toBe("只支援 Mac");
    expect(findBannedCopy({ dmMessage: "Windows 還不能用" })).toBe("Windows 還不能");
    expect(findBannedCopy({ dmMessage: "Mac 和 Windows 都能用" })).toBeNull();
    expect(findBannedCopy(null)).toBeNull();
  });
});
