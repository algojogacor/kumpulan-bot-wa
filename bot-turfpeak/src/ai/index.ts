/**
 * Flash Peak TMS - AI Pipeline & Vision Module
 * 
 * Authoritative AI observation pipeline:
 * - Common ProviderAdapter & error taxonomy
 * - Groq, Gemini, and Ollama Cloud adapters
 * - Multi-provider router with circuit breakers & manual fallback
 * - Image classifier
 * - Main match summary extractor (raw Unicode nickname preservation)
 * - Goalkeeper visual cue detector & detail extractor
 * - Caption-based goalkeeper identity resolver (strictly no stat matching!)
 * - Natural language correction parser
 * - Versioned prompt catalog
 */

export * from './adapter.js';
export * from './providers/groq.js';
export * from './providers/gemini.js';
export * from './providers/ollama.js';
export * from './providers/nvidia.js';
export * from './providers/deepseek.js';
export * from './providers/cohere.js';
export * from './providers/mistral.js';
export * from './router.js';
export * from './classifier.js';
export * from './extractors/match.js';
export * from './extractors/goalkeeper.js';
export * from './extractors/gk-identity.js';
export * from './extractors/roster.js';
export * from './correction-parser.js';
export * from './prompts/index.js';
