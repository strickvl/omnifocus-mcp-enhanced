import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Request } from 'express';
import type { Config } from './config.js';

export function createAuthenticator(config: Config, testKey?: JWTVerifyGetKey) {
  const auth = config.auth;
  const key = auth.mode === 'cloudflare'
    ? testKey ?? createRemoteJWKSet(new URL(`${auth.issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 })
    : undefined;
  return async (request: Request): Promise<string | null> => {
    if (auth.mode === 'local-bearer') {
      const candidate = request.get('authorization') ?? '';
      if (candidate.length > 256) return null;
      const hash = (value: string) => createHash('sha256').update(value).digest();
      return timingSafeEqual(hash(candidate), hash(`Bearer ${auth.token}`)) ? 'local' : null;
    }
    const assertion = request.get('cf-access-jwt-assertion');
    if (!assertion || assertion.length > 16384) return null;
    try {
      const { payload } = await jwtVerify(assertion, key!, {
        algorithms: ['RS256'], issuer: auth.issuer, audience: auth.audience,
        requiredClaims: ['exp', 'iat', 'sub', 'email'], clockTolerance: 5,
      });
      if (payload.type !== 'app' || typeof payload.email !== 'string' || !auth.allowedEmails.includes(payload.email)) return null;
      return String(payload.sub);
    } catch {
      return null;
    }
  };
}
