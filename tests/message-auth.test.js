import { describe, expect, it } from "vitest";
import { authorizeMessageSender } from "../src/core/message-auth.js";

const extensionId = "abcdefghijklmnop";
const extensionOrigin = `chrome-extension://${extensionId}/`;

function authorize(action, sender) {
  return authorizeMessageSender({ action, sender, extensionId, extensionOrigin });
}

describe("authorizeMessageSender", () => {
  it("allows trusted extension pages to use the full local action surface", () => {
    expect(
      authorize("collection.clear", {
        id: extensionId,
        url: `${extensionOrigin}shop.html`,
        tab: { id: 7 },
      }),
    ).toMatchObject({ allowed: true, role: "extension_page" });
    expect(
      authorize("settings.save", {
        id: extensionId,
        origin: extensionOrigin.slice(0, -1),
      }),
    ).toMatchObject({ allowed: true, role: "extension_page" });
  });

  it("allows content scripts to ingest data and read settings", () => {
    const sender = { id: extensionId, url: "https://www.etsy.com/listing/123", tab: { id: 9 } };
    for (const action of ["listing.savePassive", "search.saveResults", "settings.get"]) {
      expect(authorize(action, sender)).toMatchObject({ allowed: true, role: "content_script" });
    }
  });

  it("blocks destructive and privileged actions from content scripts", () => {
    const sender = { id: extensionId, url: "https://www.etsy.com/search?q=mug", tab: { id: 9 } };
    for (const action of ["collection.clear", "terms.clear", "settings.save", "queue.run", "export.csv", "image.download"]) {
      expect(authorize(action, sender)).toEqual({ allowed: false, role: "content_script", reason: "action_not_allowed" });
    }
  });

  it("rejects messages without Chrome's matching extension identity", () => {
    expect(authorize("settings.get", { id: "different-extension", tab: { id: 9 } })).toEqual({
      allowed: false,
      role: "external",
      reason: "unauthorized",
    });
  });
});
