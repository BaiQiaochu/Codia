import path from "path";
import { AfterSalesService } from "./service.ts";

const cache = new Map();

export function getAfterSalesService(codiaHome, logger = null) {
  const dataDir = path.join(codiaHome, "aftersales");
  if (!cache.has(dataDir)) {
    cache.set(dataDir, new AfterSalesService({ dataDir, logger }));
  }
  return cache.get(dataDir);
}
