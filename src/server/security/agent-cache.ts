import { Agent, type Dispatcher } from 'undici';
import { createSsrSafeLookup, tlsProfileKey, type DnsLookup } from './ip.js';
import type { TlsMaxVersion } from './types.js';

export interface AgentCacheOptions {
  tlsMaxVersion?: TlsMaxVersion;
  lookup?: DnsLookup;
}

const cachedAgents = new Map<string, Agent>();

export function getSsrSafeAgent(options: AgentCacheOptions = {}): Dispatcher {
  if (options.lookup) {
    // 주입된 DNS 조회 함수를 사용하는 연결은 기본 DNS 연결 풀과 섞지 않는다.
    return createAgent(options);
  }

  const key = tlsProfileKey(options.tlsMaxVersion);
  const cached = cachedAgents.get(key);
  if (cached && !cached.closed && !cached.destroyed) {
    return cached;
  }

  const agent = createAgent(options);
  cachedAgents.set(key, agent);
  return agent;
}

export async function closeSsrSafeAgents(): Promise<void> {
  const agents = [...cachedAgents.values()];
  cachedAgents.clear();
  await Promise.all(agents.map((agent) => agent.close()));
}

function createAgent(options: AgentCacheOptions): Agent {
  const connect =
    options.tlsMaxVersion === 'TLSv1.2'
      ? {
        lookup: createSsrSafeLookup({ lookup: options.lookup }),
        minVersion: 'TLSv1.2' as const,
        maxVersion: 'TLSv1.2' as const
      }
      : {
        lookup: createSsrSafeLookup({ lookup: options.lookup }),
        maxVersion: options.tlsMaxVersion
      };

  return new Agent({
    connect,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000
  });
}
