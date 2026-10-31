import { existsSync, readFileSync } from 'node:fs';
import type { BrandOverlay } from '@trustwork/ui/brand';
import type { Messages } from '@trustwork/i18n-runtime/types';
import { dataPath, DeploymentConfigError, type LoadedDeployment } from '@trustwork/config/server';
import { BUILT_IN_OVERLAYS, BrandOverlayFileSchema, brandIdFor } from './index.js';

/**
 * The deployment's brand overlay (server only, CFG-001): the overlay the configuration names, from the data
 * directory (`<dataDir>/brands/<id>.json`, which may also replace a built-in overlay) or from `index.ts`. An id
 * that names no overlay, or an overlay file that does not validate, is a configuration error: the server does not
 * start rather than silently showing another brand.
 */
export function deploymentBrandOverlay(deployment: Pick<LoadedDeployment, 'brand' | 'dataDir'>, buildTime?: string): BrandOverlay | null {
  const id = brandIdFor(deployment.brand, buildTime);
  if (!id) return null;
  const file = dataPath(deployment, 'brands', `${id}.json`);
  if (file && existsSync(file)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new DeploymentConfigError([`brands/${id}.json: cannot be read as JSON (${error instanceof Error ? error.message : String(error)})`]);
    }
    const parsed = BrandOverlayFileSchema.safeParse(raw);
    if (!parsed.success) throw new DeploymentConfigError(parsed.error.issues.map((issue) => `brands/${id}.json: ${issue.path.join('.') || '(file)'}: ${issue.message}`));
    return { wordmarks: parsed.data.wordmarks, messages: parsed.data.messages as Record<string, Messages> };
  }
  const builtIn = BUILT_IN_OVERLAYS[id];
  if (!builtIn) throw new DeploymentConfigError([`brand overlay "${id}" is neither built in (${Object.keys(BUILT_IN_OVERLAYS).join(', ')}) nor in the data directory (brands/${id}.json)`]);
  return builtIn;
}
