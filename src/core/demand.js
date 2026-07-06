export const DEMAND_PATTERNS = [
  /In\s+(\d+\+?)\s+carts?/i,
  /(\d+\+?)\s+people\s+have\s+this\s+in\s+their\s+cart/i,
  /In\s+demand\.?\s*(\d+\+?)?\s*people\s+bought\s+this/i,
  /(\d+\+?)\s+sold\s+in\s+(?:the\s+)?last\s+24\s+hours/i,
  /(\d+\+?)\s+views?\s+in\s+(?:the\s+)?last\s+24\s+hours/i,
  /(\d+\+?)\s+people\s+bought\s+this/i,
  /In\s+demand/i,
  /Selling\s+fast/i,
  /Popular\s+item/i,
  /Bestseller/i,
];

export const LOW_STOCK_PATTERNS = [
  /^only \d+ left/i,
  /^low in stock/i,
  /^\d+ left in stock/i,
  /^almost gone/i,
  /^limited quantity/i,
];

export function findDemandText(text) {
  const source = String(text || "");
  for (const pattern of DEMAND_PATTERNS) {
    const match = source.match(pattern);
    if (match) return match[0];
  }
  return "";
}

export function hasGoodDemandIndicator(text) {
  if (!text) return false;
  return (
    /in \d+\+? carts?/i.test(text) ||
    /sold in (?:the )?last/i.test(text) ||
    /views in (?:the )?last/i.test(text) ||
    /people bought this/i.test(text) ||
    /in demand/i.test(text) ||
    /selling fast/i.test(text) ||
    /popular item/i.test(text) ||
    /bestseller/i.test(text)
  );
}

export function isOnlyLowStock(text) {
  if (!text) return false;
  return LOW_STOCK_PATTERNS.some((pattern) => pattern.test(text));
}

export function parseDemandValue(text) {
  if (!text) return { demandValue: 0, demandType: "" };

  const patterns = [
    [/In\s+(\d+)\+?\s+carts/i, "in_carts"],
    [/(\d[\d,]*)\s*people\s+have\s+this\s+in\s+their\s+cart/i, "people_in_cart"],
    [/In\s+demand\.?\s*(\d[\d,]*)\s*people\s+bought\s+this/i, "bought_24h"],
    [/(\d[\d,]*)\s*sold\s+in\s+(?:the\s+)?last\s+24\s+hours/i, "sold_24h"],
    [/(\d[\d,]*\+?)\s*views?\s+in\s+(?:the\s+)?last\s+24\s+hours/i, "views_24h"],
    [/(\d[\d,]*)\s*favorited\s+this/i, "favorited"],
  ];

  for (const [regex, type] of patterns) {
    const match = text.match(regex);
    if (match) {
      return {
        demandValue: Number.parseInt(match[1].replace(/[,+]/g, ""), 10),
        demandType: type,
      };
    }
  }

  return hasGoodDemandIndicator(text) ? { demandValue: 0, demandType: "other" } : { demandValue: 0, demandType: "" };
}

