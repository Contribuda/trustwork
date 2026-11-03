import type { ModuleRegistry } from '../agent-modules/contracts.js';
import type { ExtensionCatalogPort, ExtensionScope } from '../agent-modules/ports.js';
import { extensionCapabilities, extensionModuleManifest, type AgentExtensionManifest } from './contracts.js';
import { agentExtensions } from './deps.js';

/**
 * The active versions of one hub, as the shared authority check reads them. A version here can be listed by the hub's agent
 * policy; only a listed version offers anything. Without a hub there is nothing to offer.
 */
export class DatabaseExtensions implements ExtensionCatalogPort {
  async activatedExtensions(scope?: ExtensionScope): Promise<ModuleRegistry['extensions']> {
    if (!scope) return [];
    const rows = await agentExtensions.active(scope.trx, scope.hubId);
    return rows.map((v) => {
      const manifest = v.manifest as AgentExtensionManifest;
      return {
        extensionVersionId: v.id, moduleKey: manifest.key, capabilities: extensionCapabilities(manifest, { extensionId: v.extension_id, version: v.version }), manifest: extensionModuleManifest(manifest, v.version),
      };
    });
  }
}
