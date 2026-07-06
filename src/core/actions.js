import { rowsToCsv, makeExportFilename } from "./csv.js";
import { createJob, estimateJob } from "./jobs.js";

export const ACTION_MANIFEST = {
  name: "etsy-research-scraper.local-actions",
  version: "0.1.0",
  local_only: true,
  actions: {
    "job.estimate": { mutates: false, approval: "none" },
    "job.create": { mutates: true, approval: "large jobs require confirmation" },
    "job.start": { mutates: true, approval: "required" },
    "job.pause": { mutates: true, approval: "none" },
    "job.resume": { mutates: true, approval: "none" },
    "job.stop": { mutates: true, approval: "none" },
    "job.status": { mutates: false, approval: "none" },
    "jobs.list": { mutates: false, approval: "none" },
    "shop.open": { mutates: false, approval: "none" },
    "collection.stats": { mutates: false, approval: "none" },
    "export.searchCsv": { mutates: false, approval: "none" },
    "image.download": { mutates: false, approval: "none" },
    "settings.get": { mutates: false, approval: "none" },
    "settings.save": { mutates: true, approval: "none" },
    "terms.list": { mutates: false, approval: "none" },
    "session.status": { mutates: false, approval: "none" },
    "terms.add": { mutates: true, approval: "none" },
    "terms.remove": { mutates: true, approval: "none" },
    "terms.clear": { mutates: true, approval: "none" },
    "queue.run": { mutates: true, approval: "starts a scrape job" },
    "queue.continue": { mutates: true, approval: "starts a scrape job" },
    "queue.pending": { mutates: false, approval: "none" },
    "queue.retryFailed": { mutates: true, approval: "starts a scrape job" },
    "queue.removeUrl": { mutates: true, approval: "none" },
    "queue.nextRun": { mutates: false, approval: "none" },
    "export.csv": { mutates: false, approval: "downloads require confirmation when many files" },
  },
};

export async function dispatchAction(action, input = {}, adapters = {}) {
  switch (action) {
    case "manifest.get":
      return ACTION_MANIFEST;
    case "job.estimate":
      return estimateJob(input);
    case "job.create": {
      const job = createJob(input);
      await adapters.saveJob?.(job);
      return { job };
    }
    case "job.start":
      return adapters.startJob ? adapters.startJob(input.id) : { started: false, reason: "not_implemented" };
    case "job.pause":
      return adapters.setRunnerState ? adapters.setRunnerState({ paused: true }) : { paused: false };
    case "job.resume":
      return adapters.resumeJob ? adapters.resumeJob() : { resumed: false };
    case "job.stop":
      return adapters.setRunnerState ? adapters.setRunnerState({ running: false, paused: false }) : { stopped: false };
    case "job.status":
      return adapters.getJobStatus ? adapters.getJobStatus(input.id) : { status: "idle" };
    case "jobs.list":
      return { jobs: (await adapters.listJobs?.()) || [] };
    case "shop.open":
      await adapters.openShop?.();
      return { opened: true };
    case "collection.stats":
      return (await adapters.collectionStats?.()) || { total: 0 };
    case "export.searchCsv":
      return (await adapters.exportSearchCsv?.()) || { rows: 0 };
    case "image.download":
      return (await adapters.downloadImage?.(input.url, input.title)) || { ok: false };
    case "settings.get":
      return (await adapters.getSettings?.()) || {};
    case "settings.save":
      return (await adapters.saveSettings?.(input.settings || {})) || {};
    case "terms.list":
      return { terms: (await adapters.listTerms?.()) || [] };
    case "session.status":
      return (await adapters.sessionStatus?.()) || { terms: [], totals: {} };
    case "terms.add":
      return (await adapters.addTerms?.(input.terms || "")) || { terms: [] };
    case "terms.remove":
      return (await adapters.removeTerm?.(input.id)) || { terms: [] };
    case "terms.clear":
      return (await adapters.clearTerms?.()) || { terms: [] };
    case "queue.run":
      return (await adapters.runTerms?.(input.terms, input.pagesPerTerm)) || { started: false };
    case "queue.continue":
      return (await adapters.continueTerm?.(input.term, input.pagesPerTerm)) || { started: false };
    case "queue.pending":
      return (await adapters.pendingUrls?.()) || { total: 0, urls: [] };
    case "queue.retryFailed":
      return (await adapters.retryFailed?.(input.term, input.pagesPerTerm)) || { reset: 0, started: false };
    case "queue.removeUrl":
      return (await adapters.removeUrl?.(input.url, input.term)) || { removed: 0 };
    case "queue.nextRun":
      return (await adapters.nextRun?.()) || { at: 0 };
    case "export.csv": {
      const rows = (await adapters.getListings?.(input.filter || {})) || [];
      const csv = rowsToCsv(rows, input.columns);
      const filename = makeExportFilename(input.filenamePrefix || "etsy-scrape");
      await adapters.downloadText?.(filename, csv, "text/csv");
      return { filename, rows: rows.length };
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
