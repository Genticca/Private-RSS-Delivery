import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/server/core/config.js';

describe('loadConfig', () => {
  it('returns loopback defaults without baking API keys into AppConfig', () => {
    const config = loadConfig({
      PRIMARY_MODEL_API_KEY: 'primary-secret'
    });

    expect(config).toEqual({
      port: 8080,
      host: '127.0.0.1',
      databasePath: './data/rss-discord-bridge.sqlite',
      isProduction: false
    });
    expect(Object.keys(config)).not.toContain('primaryModelApiKey');
    expect(Object.keys(config)).not.toContain('modelTargetLang');
    expect(Object.keys(config)).not.toContain('modelPromptLogMaxBytes');
  });

  it('parses non-secret environment overrides strictly', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '9090',
      HOST: 'localhost',
      DATABASE_PATH: '/tmp/rss.sqlite'
    });

    expect(config).toMatchObject({
      port: 9090,
      host: 'localhost',
      databasePath: '/tmp/rss.sqlite',
      isProduction: true
    });
  });


  it('loads project .env values for process env without overriding existing variables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rss-config-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'PORT=9191\nHOST=localhost\nDATABASE_PATH="./data/from-env.sqlite"\nPRIMARY_MODEL_API_KEY=secret\n');
    const previousPort = process.env.PORT;
    try {
      process.env.PORT = '9292';
      const config = loadConfig(process.env, { envFilePath: envFile });
      expect(config).toMatchObject({
        port: 9292,
        host: 'localhost',
        databasePath: './data/from-env.sqlite'
      });
      expect(Object.keys(config)).not.toContain('primaryModelApiKey');
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid numeric settings', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow('PORT must be an integer.');
    expect(() => loadConfig({ PORT: '70000' })).toThrow('PORT must be less than or equal to 65535.');
  });

  it('rejects non-loopback production hosts', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', HOST: '0.0.0.0' })).toThrow(
      'HOST must be loopback-only in production.'
    );
  });

  it.each(['0.0.0.0', '::', '[::]'])('allows production bind to %s only with the container flag', (host) => {
    const config = loadConfig({ NODE_ENV: 'production', HOST: host, ALLOW_NON_LOOPBACK_HOST: 'true' });

    expect(config.host).toBe(host);
    expect(config).not.toHaveProperty('allowNonLoopbackHost');
  });

  it('keeps empty and false container flags disabled', () => {
    for (const value of ['', '   ', 'false', ' false ']) {
      expect(loadConfig({ NODE_ENV: 'production', ALLOW_NON_LOOPBACK_HOST: value }).host).toBe('127.0.0.1');
      expect(() => loadConfig({ NODE_ENV: 'production', HOST: '0.0.0.0', ALLOW_NON_LOOPBACK_HOST: value })).toThrow(
        'HOST must be loopback-only in production.'
      );
    }
  });

  it('trims the true container flag before validating it', () => {
    expect(loadConfig({ NODE_ENV: 'production', HOST: '0.0.0.0', ALLOW_NON_LOOPBACK_HOST: ' true ' }).host).toBe('0.0.0.0');
  });

  it('rejects a specific non-loopback production address even with the container flag', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', HOST: '10.0.0.5', ALLOW_NON_LOOPBACK_HOST: 'true' })).toThrow(
      'HOST must be loopback-only in production.'
    );
  });

  it.each(['production', 'development'])('rejects invalid container flags in %s', (mode) => {
    for (const value of ['yes', 'TRUE', '1']) {
      expect(() => loadConfig({ NODE_ENV: mode, ALLOW_NON_LOOPBACK_HOST: value })).toThrow(
        'ALLOW_NON_LOOPBACK_HOST must be true or false.'
      );
    }
  });

  it('preserves development host handling for all valid container flags', () => {
    for (const value of [undefined, '', 'false', 'true']) {
      expect(loadConfig({ NODE_ENV: 'development', HOST: '10.0.0.5', ALLOW_NON_LOOPBACK_HOST: value }).host).toBe('10.0.0.5');
    }
  });
});
