// Chrome sets MessageSender.id/url; page JavaScript cannot forge them. Content
// scripts legitimately ingest Etsy data, while extension pages own destructive,
// settings, job-control, and download actions.
const CONTENT_SCRIPT_ACTIONS = new Set([
  "listing.savePassive",
  "search.saveResults",
  "settings.get",
]);

export function authorizeMessageSender({ action, sender, extensionId, extensionOrigin } = {}) {
  if (!sender || sender.id !== extensionId) {
    return { allowed: false, role: "external", reason: "unauthorized" };
  }

  const senderUrl = String(sender.url || "");
  const senderOrigin = String(sender.origin || "");
  const normalizedOrigin = String(extensionOrigin || "").replace(/\/$/, "");
  if (extensionOrigin && (senderUrl.startsWith(extensionOrigin) || senderOrigin === normalizedOrigin)) {
    return { allowed: true, role: "extension_page" };
  }

  if (sender.tab?.id != null && CONTENT_SCRIPT_ACTIONS.has(action)) {
    return { allowed: true, role: "content_script" };
  }

  return { allowed: false, role: "content_script", reason: "action_not_allowed" };
}
