/**
 * Start-up check (CFG-001): Next calls `register()` once when the server starts, before it serves a request. The
 * deployment configuration, the data directory's country packs, the brand overlay and the dictionaries of every
 * configured language are loaded and validated here; any problem (an invalid or restricted pack, an unknown brand,
 * a language without a dictionary) is printed as one JSON log line and the process exits, so an invalid deployment
 * never serves pages. Nothing here reaches the network.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { currentDeployment, DeploymentConfigError } = await import('@trustwork/config/server');
  const { deploymentBrandOverlay } = await import('./brand/load');
  const { dictionaryLanguages, offeredLanguages } = await import('./app/_lib/locale-negotiation');
  try {
    const deployment = currentDeployment();
    deploymentBrandOverlay(deployment);
    const available = dictionaryLanguages(deployment);
    const wanted = [deployment.languages.default, ...(deployment.languages.enabled === 'all' ? [] : deployment.languages.enabled), ...Object.values(deployment.languages.byCountry)];
    const missing = [...new Set(wanted)].filter((tag) => !available.has(tag));
    if (missing.length) throw new DeploymentConfigError(missing.map((tag) => `language ${tag} is configured but has no dictionary (apps/web/locales/${tag}/ or <dataDir>/locales/${tag}/)`));
    console.info(
      JSON.stringify({
        level: 'info',
        msg: 'deployment configuration loaded',
        file: deployment.source.file,
        dataDir: deployment.dataDir,
        revision: deployment.revision,
        defaultCountry: deployment.countries.default,
        countryPacks: deployment.packs.map((p) => p.code),
        languages: offeredLanguages(deployment),
      }),
    );
  } catch (error) {
    const problems = error instanceof DeploymentConfigError ? error.problems : [error instanceof Error ? error.message : String(error)];
    console.error(JSON.stringify({ level: 'fatal', msg: 'invalid deployment configuration; the server does not start', problems }));
    process.exit(1);
  }
}
