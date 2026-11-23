// Probe: computeGroupSizing(16, {targetGroupSize:5}) — should throw (16 = 5a+4b unsolvable).
import { computeGroupSizing } from '../src/competition/draw.js';
try {
  const r = computeGroupSizing(16, { targetGroupSize: 5 });
  console.log('16/target5 UNEXPECTED SUCCESS:', JSON.stringify(r));
} catch (e) {
  console.log('16/target5 throws:', (e as Error).message);
}
console.log('20/target5:', JSON.stringify(computeGroupSizing(20, { targetGroupSize: 5 })));
try {
  computeGroupSizing(16, { targetGroupSize: 4 });
  console.log('16/target4 OK');
} catch (e) {
  console.log('16/target4 throws?!', (e as Error).message);
}
