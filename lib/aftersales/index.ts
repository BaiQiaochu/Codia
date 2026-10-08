import path from "path";
import { AfterSalesService } from "./service.ts";

const cache = new Map();

export function getAfterSalesService(gsapHome, logger = null) {
  const dataDir = path.join(gsapHome, "aftersales");
  if (!cache.has(dataDir)) {
    cache.set(dataDir, new AfterSalesService({ dataDir, logger }));
  }
  return cache.get(dataDir);
}
