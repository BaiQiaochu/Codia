export type ProductVariant = 'g-sap';

declare global {
  interface Window {
    __GSAP_PRODUCT_VARIANT__?: ProductVariant | string;
  }
}

declare const __GSAP_PRODUCT_VARIANT__: ProductVariant | string | undefined;

let testVariant: ProductVariant | null = null;

export function getProductVariant(): ProductVariant {
  if (testVariant) return testVariant;
  return 'g-sap';
}

export function setProductVariantForTests(variant: ProductVariant | null): void {
  testVariant = variant;
}
