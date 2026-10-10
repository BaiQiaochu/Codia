export type ProductVariant = 'codia';

declare global {
  interface Window {
    __CODIA_PRODUCT_VARIANT__?: ProductVariant | string;
  }
}

declare const __CODIA_PRODUCT_VARIANT__: ProductVariant | string | undefined;

let testVariant: ProductVariant | null = null;

export function getProductVariant(): ProductVariant {
  if (testVariant) return testVariant;
  return 'codia';
}

export function setProductVariantForTests(variant: ProductVariant | null): void {
  testVariant = variant;
}
