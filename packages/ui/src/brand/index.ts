import type { Messages } from '@trustwork/i18n-runtime/types';
import type { WordmarkLines } from '../components/Brand/wordmark';

/**
 * Brand overlay (ADR-009): the engine renders the neutral Trustwork lockup and strings; a deployment
 * registers its own wordmarks (outlined per locale by `brand/tools/build-logo.py … deployment`) and
 * message overrides (`brand.*` keys plus any copy that embeds the brand name). Registration happens
 * on the server and in the client bundle alike; without it, nothing changes.
 */
export type BrandOverlay = {
  /** Stacked wordmark outlines per locale tag; a missing tag falls back to the engine lockup. */
  wordmarks: Record<string, WordmarkLines>;
  /** Message overrides per locale tag, layered above the deployment's dictionaries. */
  messages: Record<string, Messages>;
};

let overlay: BrandOverlay | null = null;

export function registerBrandOverlay(next: BrandOverlay | null): void {
  overlay = next;
}

export function brandOverlay(): BrandOverlay | null {
  return overlay;
}

export function overlayWordmark(tag: string): WordmarkLines | undefined {
  return overlay?.wordmarks[tag];
}

export function overlayMessages(tag: string): Messages | undefined {
  return overlay?.messages[tag];
}
