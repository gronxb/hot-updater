import {describe, expect, test} from 'vitest';
import {mockDatabase} from '../src';
import {Bundle} from '@hot-updater/core';

const DEFAULT_BUNDLES_MOCK: Bundle[] = [
  {
    id: '1',
    enabled: true,
    fileUrl: 'https://example.com/bundle.js',
    shouldForceUpdate: false,
    fileHash: '1234',
    gitCommitHash: '5678',
    platform: 'ios',
    targetAppVersion: '',
    message: null,
  },
  {
    id: '2',
    enabled: true,
    fileUrl: 'https://example.com/bundle.js',
    shouldForceUpdate: false,
    fileHash: '1234',
    gitCommitHash: '5678',
    platform: 'ios',
    targetAppVersion: '',
    message: null,
  },
];

describe('mockDatabase', () => {
  test('should return a database plugin', async () => {
    const plugin = mockDatabase({})({cwd: ''});

    const bundles = await plugin.getBundles();

    expect(bundles).toEqual([]);
  });

  test('should return a database plugin with initial bundles', async () => {
    const plugin = mockDatabase({
      initialBundles: DEFAULT_BUNDLES_MOCK,
    })({cwd: ''});

    const bundles = await plugin.getBundles();

    expect(bundles).toEqual(DEFAULT_BUNDLES_MOCK);
  });

  test('should append a bundle', async () => {
    const plugin = mockDatabase({})({cwd: ''});

    await plugin.appendBundle(DEFAULT_BUNDLES_MOCK[0]);

    const bundles = await plugin.getBundles();

    expect(bundles).toEqual([DEFAULT_BUNDLES_MOCK[0]]);
  });

  test('should update a bundle', async () => {
    const plugin = mockDatabase({
      initialBundles: [DEFAULT_BUNDLES_MOCK[0]],
    })({cwd: ''});

    await plugin.updateBundle('1', {
      enabled: false,
    });

    const bundles = await plugin.getBundles();

    expect(bundles).toEqual([{
      ...DEFAULT_BUNDLES_MOCK[0],
      enabled: false,
    }]);
  });

  test('should set bundles', async () => {
    const plugin = mockDatabase({})({cwd: ''});

    await plugin.setBundles(DEFAULT_BUNDLES_MOCK);

    const bundles = await plugin.getBundles();

    expect(bundles).toEqual(DEFAULT_BUNDLES_MOCK);
  });

  test('should get bundle by id', async () => {
    const plugin = mockDatabase({
      initialBundles: DEFAULT_BUNDLES_MOCK,
    })({cwd: ''});

    const bundle = await plugin.getBundleById('1');

    expect(bundle).toEqual(DEFAULT_BUNDLES_MOCK[0]);
  });

  test('should throw error, if target bundle version not found', async () => {
    const plugin = mockDatabase({
      initialBundles: [DEFAULT_BUNDLES_MOCK[0]],
    })({cwd: ''});

    await expect(plugin.updateBundle('2', {enabled: false}))
      .rejects.toThrowError('target bundle version not found');
  });

  test('should sort bundles by id', async () => {
    const plugin = mockDatabase({
      initialBundles: [DEFAULT_BUNDLES_MOCK[1], DEFAULT_BUNDLES_MOCK[0]],
    })({cwd: ''});

    const bundles = await plugin.getBundles();

    expect(bundles).toEqual(DEFAULT_BUNDLES_MOCK);
  });
});
