// Runs on every Etsy page so a worker lane can type into the search box from
// the homepage, not only from an existing results URL. Classic script: the
// helpers are loaded first and attached to globalThis.IscaleEtsy.

const detectSearchBlock = globalThis.IscaleEtsy?.detectSearchBlock;
const parseShopPage = globalThis.IscaleEtsy?.parseShopPage;
const activateSearchSubmit = globalThis.IscaleEtsy?.activateSearchSubmit;
const formatSearchPathLog = globalThis.IscaleEtsy?.formatSearchPathLog;
const planNextPage = globalThis.IscaleEtsy?.planNextPage;
const clickPlannedNext = globalThis.IscaleEtsy?.clickPlannedNext;
const typeAndSubmitSearch = globalThis.IscaleEtsy?.typeAndSubmitSearch;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ error: "unauthorized" });
    return true;
  }
  if (message?.action === "worker.typeAndSubmit") {
    const input = message.input || {};
    typeAndSubmitSearch(document, input.term, {
      submit: false,
      keystrokeMinMs: input.keystrokeMinMs,
      keystrokeMaxMs: input.keystrokeMaxMs,
    }).then((result) => {
      console.info(formatSearchPathLog(result));
      sendResponse(result);
      if (result.ok && result.path === "search_box") {
        setTimeout(() => activateSearchSubmit(document), 40);
      }
    });
    return true;
  }
  if (message?.action === "worker.detectBlock") {
    sendResponse({ block: detectSearchBlock(document, location.href) });
    return true;
  }
  if (message?.action === "worker.extractShop") {
    sendResponse(parseShopPage(document, location.href));
    return true;
  }
  if (message?.action === "worker.clickNext") {
    const plan = planNextPage(document, message.input?.currentPage);
    console.info(formatSearchPathLog(plan));
    sendResponse(plan);
    if (plan.ok) setTimeout(() => clickPlannedNext(document, plan), 40);
    return true;
  }
  return false;
});
