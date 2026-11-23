import { getDefaultConfig } from '../services/flashpeak-media/config.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

async function main() {
  console.log('=== AUDIT TEST: FIX-SEC-001B (Media HMAC Secret Hardcode Removal) ===\n');

  // 1. Static check: ensure old hardcoded hex string does not exist in config.ts
  const configSource = readFileSync(path.resolve('services/flashpeak-media/config.ts'), 'utf8');
  const forbiddenHex = 'e56ad9530df7d79427f1e39d089210eddf18c55d136ca4a3cec438eff86dc206';
  if (configSource.includes(forbiddenHex)) {
    throw new Error(`FAIL: Forbidden hardcoded hex secret still found in config.ts!`);
  }
  console.log('Static Check: No hardcoded HMAC secret constant found in config.ts. (PASS)');

  // Save current env
  const origFlashpeak = process.env.FLASHPEAK_MEDIA_SECRET;
  const origMediaHmac = process.env.MEDIA_SERVICE_HMAC_SECRET;

  try {
    // 2. Dynamic check: missing env throws error
    delete process.env.FLASHPEAK_MEDIA_SECRET;
    delete process.env.MEDIA_SERVICE_HMAC_SECRET;

    let threw = false;
    try {
      getDefaultConfig();
    } catch (err: any) {
      threw = true;
      console.log('Missing Secret Check: Correctly threw on missing secret ->', err.message);
    }
    if (!threw) {
      throw new Error('FAIL: getDefaultConfig did not throw when secret was missing!');
    }
    console.log('Result Missing Secret Check: PASS');

    // 3. Dynamic check: FLASHPEAK_MEDIA_SECRET is recognized
    process.env.FLASHPEAK_MEDIA_SECRET = 'custom-test-secret-12345';
    const cfg1 = getDefaultConfig();
    if (cfg1.hmacSecret !== 'custom-test-secret-12345') {
      throw new Error(`FAIL: Expected custom-test-secret-12345, got ${cfg1.hmacSecret}`);
    }
    console.log('Result FLASHPEAK_MEDIA_SECRET Check: PASS');

    // 4. Dynamic check: fallback to MEDIA_SERVICE_HMAC_SECRET
    delete process.env.FLASHPEAK_MEDIA_SECRET;
    process.env.MEDIA_SERVICE_HMAC_SECRET = 'legacy-hmac-secret-67890';
    const cfg2 = getDefaultConfig();
    if (cfg2.hmacSecret !== 'legacy-hmac-secret-67890') {
      throw new Error(`FAIL: Expected legacy-hmac-secret-67890, got ${cfg2.hmacSecret}`);
    }
    console.log('Result MEDIA_SERVICE_HMAC_SECRET Check: PASS');

    console.log('\n=== AUDIT CONCLUSION: FIX-SEC-001B ===');
    console.log('ALL SECURITY SECRET TESTS PASSED SUCCESSFULLY!');
  } finally {
    if (origFlashpeak !== undefined) process.env.FLASHPEAK_MEDIA_SECRET = origFlashpeak;
    else delete process.env.FLASHPEAK_MEDIA_SECRET;
    if (origMediaHmac !== undefined) process.env.MEDIA_SERVICE_HMAC_SECRET = origMediaHmac;
    else delete process.env.MEDIA_SERVICE_HMAC_SECRET;
  }
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
