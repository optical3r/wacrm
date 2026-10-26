import { afterEach, describe, expect, it } from "vitest";
import { COEXY_META_PROXY_BASE, isCoexy, metaApiBase } from "./provider";

describe("whatsapp provider", () => {
  const saved = process.env.WHATSAPP_PROVIDER;
  afterEach(() => {
    if (saved === undefined) delete process.env.WHATSAPP_PROVIDER;
    else process.env.WHATSAPP_PROVIDER = saved;
  });

  it("defaults to Meta's Graph API", () => {
    delete process.env.WHATSAPP_PROVIDER;
    expect(isCoexy()).toBe(false);
    expect(metaApiBase("v21.0")).toBe("https://graph.facebook.com/v21.0");
  });

  it("uses Coexy's meta-proxy when WHATSAPP_PROVIDER=coexy", () => {
    process.env.WHATSAPP_PROVIDER = " Coexy ";
    expect(isCoexy()).toBe(true);
    expect(metaApiBase("v21.0")).toBe(COEXY_META_PROXY_BASE);
  });
});
