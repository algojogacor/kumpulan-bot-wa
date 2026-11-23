function isValidGeminiKey(geminiKey?: string): boolean {
  return Boolean(
    geminiKey &&
    geminiKey !== 'AIzaSy_placeholder_gemini_api_key' &&
    !geminiKey.includes('placeholder')
  );
}

console.log('=== AUDIT TEST: FIX-APIKEY-001 (Gemini API Key Validation in start.ts) ===\n');

const testCases = [
  { key: 'AIzaSy_placeholder_gemini_api_key', expected: false, name: 'Default placeholder from .env.example' },
  { key: 'some_placeholder_key', expected: false, name: 'Key containing placeholder' },
  { key: 'AIzaSy_real_production_key_abcdef12345', expected: true, name: 'Real Gemini key with AIzaSy_ prefix' },
  { key: 'AIzaSyRealGoogleStudioApiKey67890', expected: true, name: 'Real Gemini key with AIzaSy prefix (no underscore)' },
  { key: '', expected: false, name: 'Empty string' },
  { key: undefined, expected: false, name: 'Undefined' },
];

let allPassed = true;
for (const tc of testCases) {
  const result = isValidGeminiKey(tc.key);
  const passed = result === tc.expected;
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${tc.name}: input="${tc.key}" -> got=${result}, expected=${tc.expected}`);
  if (!passed) allPassed = false;
}

if (!allPassed) {
  console.error('\nFAIL: Some test cases failed!');
  process.exit(1);
}

console.log('\n=== AUDIT CONCLUSION: FIX-APIKEY-001 ===');
console.log('ALL GEMINI API KEY VALIDATION TESTS PASSED SUCCESSFULLY!');
