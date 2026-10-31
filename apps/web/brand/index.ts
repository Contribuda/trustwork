import { z } from 'zod';
import type { BrandOverlay } from '@trustwork/ui/brand';
import type { Messages } from '@trustwork/i18n-runtime/types';
import { deploymentWordmarks } from './wordmarks.js';
import ru from './messages/ru.json' with { type: 'json' };

/**
 * Brand overlays (owner decision 2026-10-31, ADR 010 decision 14): **Trustwork everywhere**. The only
 * exception is the Russian interface, which shows «Строй Репутация» (name, stacked lettering and the copy
 * that embeds the name). Every other language falls back to the Trustwork lockup and strings.
 *
 * Which overlay a deployment shows is runtime configuration (CFG-001): `brand.overlay` in the deployment
 * configuration or `TRUSTWORK_BRAND` (`none` for Trustwork in Russian too), read when the server starts, so one
 * image serves deployments with different brands. The build-time `NEXT_PUBLIC_TRUSTWORK_BRAND` still applies when
 * neither is set. Overlays are built in here or supplied as data (`<dataDir>/brands/<id>.json`, see `load.ts`).
 * The name and lettering «Строй Репутация» are marks of their owner; the licence grants no trademark rights to them
 * (NOTICE, AGPL-3.0 section 7(e)). See docs/oss/BRAND.md to add another overlay.
 */
export const BUILT_IN_OVERLAYS: Readonly<Record<string, BrandOverlay>> = {
  'stroyreputation-ru': {
    wordmarks: { ru: deploymentWordmarks.ru! },
    messages: { ru: ru as Messages },
  },
};

/** The overlay of a deployment that configures nothing: the Russian-interface overlay, which changes no other language. */
export const DEFAULT_BRAND_ID = 'stroyreputation-ru';

/**
 * The overlay id in effect: the runtime configuration when it says anything (`null` meaning none), else the
 * build-time variable, else the default. `none` in either place turns the overlay off.
 */
export function brandIdFor(configured: { overlay: string | null } | undefined, buildTime: string | undefined = process.env.NEXT_PUBLIC_TRUSTWORK_BRAND): string | null {
  if (configured) return configured.overlay;
  const built = buildTime?.trim();
  if (built) return built.toLowerCase() === 'none' ? null : built;
  return DEFAULT_BRAND_ID;
}

const WordmarkLinesSchema = z.strictObject({
  line1: z.array(z.string().min(1)).min(1),
  line2: z.array(z.string().min(1)),
  width1: z.number().positive(),
  width2: z.number().nonnegative(),
  viewBoxWidth: z.number().positive(),
});
type MessageTree = { [key: string]: string | readonly string[] | MessageTree };
const MessagesSchema: z.ZodType<MessageTree> = z.lazy(() => z.record(z.string(), z.union([z.string(), z.array(z.string()), MessagesSchema])));

/** A brand overlay supplied as data: `{ "wordmarks": { "<tag>": WordmarkLines }, "messages": { "<tag>": { "brand": { … } } } }`. */
export const BrandOverlayFileSchema = z.strictObject({
  $comment: z.string().optional(),
  wordmarks: z.record(z.string(), WordmarkLinesSchema).default({}),
  messages: z.record(z.string(), MessagesSchema).default({}),
});
