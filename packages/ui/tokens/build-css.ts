import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTokensCss } from './index';

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'tokens.css'), renderTokensCss());
console.log('tokens.css written');
