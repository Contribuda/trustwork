import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VECTOR_FILES, buildVectors, vectorFileText } from './vectors.js';

/** Writes the conformance vectors (see vectors.ts). Run: node --import tsx tests/federation/protocol/generate-vectors.ts */
const directory = resolve(dirname(fileURLToPath(import.meta.url)), 'vectors');
mkdirSync(directory, { recursive: true });
const vectors = buildVectors();
for (const file of VECTOR_FILES) writeFileSync(resolve(directory, file), vectorFileText(vectors[file]));
console.log(`wrote ${VECTOR_FILES.length} vector files to ${directory}`);
