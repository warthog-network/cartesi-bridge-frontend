import { selftest3p } from '../src/utils/server/pool3p.mjs';

const r = await selftest3p();
console.log(JSON.stringify(r, null, 2));
