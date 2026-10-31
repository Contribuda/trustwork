import test from 'node:test';
import assert from 'node:assert/strict';
import { DeploymentConfigSchema, isCountryOffered, resolveDeployment, unconfiguredDeployment } from '@trustwork/config';
import { DeploymentConfigError, loadDeployment, readPackDirectory } from '@trustwork/config/server';
import { BUILT_IN_PACKS, checkPackFile, getPack, installPacks, packs, resetPacks, RESTRICTED } from '@trustwork/country-packs';
import { dataDirectory, syntheticPack } from './helpers.js';

const problemsOf = (file: unknown, env: Record<string, string> = {}) => resolveDeployment({ file, fileName: 'trustwork.config.json', env }).problems;

test('with nothing configured: no default country, every country and language offered, English fallback, no brand decision', () => {
  const d = unconfiguredDeployment();
  assert.equal(d.countries.default, null);
  assert.equal(d.countries.offered, 'all');
  assert.equal(d.countries.featured, null);
  assert.equal(d.languages.default, 'en');
  assert.equal(d.languages.enabled, 'all');
  assert.equal(d.brand, undefined, 'the application keeps its own default overlay');
  assert.equal(d.dataDir, null);
});

test('a complete configuration file resolves; the environment overrides it', () => {
  const file = {
    schemaVersion: 1,
    revision: { number: 3, note: 'Spanish added' },
    countries: { default: 'US', offered: ['US', 'MX', 'CA'], featured: ['US'] },
    languages: { default: 'en', enabled: ['en', 'ru'], byCountry: { MX: 'en' } },
    brand: { overlay: null },
    site: { url: 'https://build.example.org' },
    dataDir: './data',
  };
  assert.ok(DeploymentConfigSchema.safeParse(file).success);
  const { deployment, problems } = resolveDeployment({ file, fileName: 'f.json' });
  assert.deepEqual(problems, []);
  assert.equal(deployment!.revision, 3);
  assert.equal(deployment!.countries.default, 'US');
  assert.deepEqual(deployment!.brand, { overlay: null });
  assert.equal(deployment!.site.url, 'https://build.example.org');
  assert.ok(isCountryOffered(deployment!, 'mx'));
  assert.ok(!isCountryOffered(deployment!, 'DE'), 'only the offered list');

  const overridden = resolveDeployment({ file, env: { TRUSTWORK_DEFAULT_COUNTRY: 'ca', TRUSTWORK_BRAND: 'stroyreputation-ru', TRUSTWORK_SITE_URL: 'https://other.example.org/hub', TRUSTWORK_DATA_DIR: '/srv/data' } }).deployment!;
  assert.equal(overridden.countries.default, 'CA');
  assert.deepEqual(overridden.brand, { overlay: 'stroyreputation-ru' });
  assert.equal(overridden.site.url, 'https://other.example.org/hub');
  assert.equal(overridden.dataDir, '/srv/data');
  assert.equal(resolveDeployment({ file, env: { TRUSTWORK_DEFAULT_COUNTRY: 'none' } }).deployment!.countries.default, null);
  assert.equal(resolveDeployment({ file: { schemaVersion: 1, brand: { overlay: 'x' } }, env: { TRUSTWORK_BRAND: 'NONE' } }).deployment!.brand!.overlay, null);
});

test('no restricted place can be a default, offered, featured or given a language, by file or environment', () => {
  for (const place of RESTRICTED.places.map((p) => p.code).filter((code) => /^[A-Z]{2}$/.test(code))) {
    assert.match(problemsOf({ schemaVersion: 1, countries: { default: place } }).join('\n'), /restricted place/, `default ${place}`);
    assert.match(problemsOf({ schemaVersion: 1, countries: { offered: ['US', place] } }).join('\n'), /restricted place/, `offered ${place}`);
    assert.match(problemsOf({ schemaVersion: 1, countries: { featured: [place] } }).join('\n'), /restricted place/, `featured ${place}`);
    assert.match(problemsOf({ schemaVersion: 1, languages: { byCountry: { [place]: 'en' } } }).join('\n'), /restricted place/, `byCountry ${place}`);
    assert.match(problemsOf(undefined, { TRUSTWORK_DEFAULT_COUNTRY: place }).join('\n'), /restricted place/, `env ${place}`);
    assert.ok(!isCountryOffered(unconfiguredDeployment(), place), `never offered: ${place}`);
  }
  // Sub-national restricted places are not countries and cannot be offered either.
  for (const code of ['UA-43', 'UA-40', 'UA-14', 'UA-09']) assert.ok(!isCountryOffered(unconfiguredDeployment(), code), code);
  assert.ok(isCountryOffered(unconfiguredDeployment(), 'UA'), 'government-controlled Ukraine stays selectable');
});

test('inconsistent or malformed configuration lists every problem', () => {
  const problems = problemsOf({
    schemaVersion: 1,
    countries: { default: 'DE', offered: ['US', 'US'], featured: ['MX'] },
    languages: { default: 'ru', enabled: ['en'], byCountry: { US: 'ka' } },
  });
  for (const expected of [/countries\.default DE is not in countries\.offered/, /countries\.offered lists a country twice/, /countries\.featured MX is not in countries\.offered/, /languages\.default ru is not in languages\.enabled/, /languages\.byCountry\.US ka is not in languages\.enabled/]) {
    assert.ok(problems.some((p) => expected.test(p)), `${expected}: ${problems.join(' | ')}`);
  }
  assert.match(problemsOf({ schemaVersion: 2 }).join(), /schemaVersion/);
  assert.match(problemsOf({ schemaVersion: 1, countries: { default: 'us' } }).join(), /alpha-2/);
  assert.match(problemsOf({ schemaVersion: 1, countries: { default: 'XX' } }).join(), /not a country the engine knows/);
  assert.match(problemsOf({ schemaVersion: 1, languages: { default: 'EN_us' } }).join(), /BCP 47/);
  assert.match(problemsOf({ schemaVersion: 1, site: { url: 'ftp://example.org' } }).join(), /site\.url/);
  assert.match(problemsOf({ schemaVersion: 1, brand: { overlay: 'Not An Id' } }).join(), /brand overlay id/);
  assert.match(problemsOf(undefined, { TRUSTWORK_SITE_URL: 'not a url' }).join(), /TRUSTWORK_SITE_URL/);
  assert.match(problemsOf(undefined, { TRUSTWORK_BRAND: '../etc' }).join(), /TRUSTWORK_BRAND/);
});

test('the loader reads the file and the data directory without changing global state', () => {
  const data = dataDirectory();
  try {
    data.write('trustwork.config.json', { schemaVersion: 1, countries: { default: 'XF', featured: ['XF', 'US'] }, languages: { byCountry: { XF: 'en' } } });
    data.write('country-packs/xf.json', syntheticPack('en'));
    const loaded = loadDeployment({ env: { TRUSTWORK_DATA_DIR: data.dir }, cwd: '/' });
    assert.equal(loaded.dataDir, data.dir);
    assert.equal(loaded.countries.default, 'XF', 'a country known only from its data-directory pack can be the default');
    assert.deepEqual(loaded.packs.map((p) => p.code), ['XF']);
    assert.equal(getPack('XF'), null, 'loading alone installs nothing');

    // The file can live elsewhere and point at the data directory relative to itself.
    const other = dataDirectory();
    try {
      other.write('config/trustwork.config.json', { schemaVersion: 1, dataDir: '../data' });
      other.write('data/country-packs/xf.json', syntheticPack('en'));
      const viaFile = loadDeployment({ env: { TRUSTWORK_CONFIG: 'config/trustwork.config.json' }, cwd: other.dir });
      assert.equal(viaFile.dataDir, `${other.dir}/data`);
      assert.deepEqual(viaFile.packs.map((p) => p.code), ['XF']);
    } finally {
      other.remove();
    }
  } finally {
    data.remove();
  }
});

test('the loader refuses missing files, missing directories, featured countries without a pack and bad packs, all at once', () => {
  assert.throws(() => loadDeployment({ env: { TRUSTWORK_CONFIG: 'nowhere.json' }, cwd: '/tmp' }), (error: unknown) => error instanceof DeploymentConfigError && /nowhere\.json does not exist/.test(error.message));
  assert.throws(() => loadDeployment({ env: { TRUSTWORK_DATA_DIR: '/nonexistent/trustwork-data' } }), /data directory .* does not exist/);
  const data = dataDirectory();
  try {
    data.write('trustwork.config.json', { schemaVersion: 1, countries: { featured: ['BR'] } });
    data.write('country-packs/ru.json', { ...syntheticPack('en'), code: 'RU' });
    data.write('country-packs/xf.json', { code: 'XF' });
    assert.throws(
      () => loadDeployment({ env: { TRUSTWORK_DATA_DIR: data.dir } }),
      (error: unknown) => {
        assert.ok(error instanceof DeploymentConfigError);
        const all = error.problems.join('\n');
        assert.match(all, /RU is a restricted place/);
        assert.match(all, /country-packs\/xf\.json/);
        assert.match(all, /countries\.featured BR has no country pack/);
        return true;
      },
    );
  } finally {
    data.remove();
  }
});

test('the registry installs deployment packs next to the built-in ones and never a restricted one', () => {
  try {
    const { packs: found, problems } = readPackDirectory('/nonexistent');
    assert.deepEqual([found, problems], [[], []]);
    const xf = checkPackFile('xf.json', syntheticPack('en')).pack!;
    installPacks([xf]);
    assert.equal(getPack('xf')?.code, 'XF');
    assert.equal(packs().length, BUILT_IN_PACKS.length + 1);
    // A deployment pack replaces the built-in pack of the same code.
    const us = { ...getPack('US')!, enabled: false };
    installPacks([us]);
    assert.equal(getPack('US')?.enabled, false);
    assert.equal(packs().length, BUILT_IN_PACKS.length);
    assert.throws(() => installPacks([{ ...xf, code: 'IR' }]), /restricted place/);
    assert.throws(() => installPacks([xf, xf]), /installed twice/);
    assert.match(checkPackFile('xf.json', { ...syntheticPack('en'), code: 'CU' }).problems.join(), /restricted place/);
    assert.match(checkPackFile('XF.json', syntheticPack('en')).problems.join(), /must be named xf\.json/);
  } finally {
    resetPacks();
  }
  assert.equal(getPack('XF'), null);
  assert.equal(getPack('US')?.enabled, true);
});
