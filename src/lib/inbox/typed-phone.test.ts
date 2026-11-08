import { describe, expect, it } from "vitest";
import { formatTypedPhone, parseTypedPhone } from "./typed-phone";

describe("parseTypedPhone", () => {
  it("reads national Brazilian numbers", () => {
    expect(parseTypedPhone("71 98888-7777")).toBe("5571988887777");
    expect(parseTypedPhone("(071) 98888-7777")).toBe("5571988887777");
    expect(parseTypedPhone("7133334444")).toBe("557133334444");
  });

  it("keeps numbers already carrying 55", () => {
    expect(parseTypedPhone("5571988887777")).toBe("5571988887777");
    expect(parseTypedPhone("+55 71 98888-7777")).toBe("5571988887777");
  });

  it("takes other countries only with +", () => {
    expect(parseTypedPhone("+1 (415) 555-1212")).toBe("14155551212");
    expect(parseTypedPhone("+351 912 345 678")).toBe("351912345678");
    expect(parseTypedPhone("351912345678")).toBeNull();
  });

  it("ignores names, short numbers and bad Brazilian lengths", () => {
    expect(parseTypedPhone("Maria")).toBeNull();
    expect(parseTypedPhone("9888")).toBeNull();
    expect(parseTypedPhone("71 9888a-7777")).toBeNull();
    expect(parseTypedPhone("+55 71 9888")).toBeNull();
    expect(parseTypedPhone("")).toBeNull();
    expect(parseTypedPhone(null)).toBeNull();
  });
});

describe("formatTypedPhone", () => {
  it("formats Brazilian numbers", () => {
    expect(formatTypedPhone("5571988887777")).toBe("+55 71 98888-7777");
    expect(formatTypedPhone("557133334444")).toBe("+55 71 3333-4444");
  });
  it("prefixes + for the rest", () => {
    expect(formatTypedPhone("14155551212")).toBe("+14155551212");
  });
});
