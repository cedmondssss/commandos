import { resolve } from 'node:path';
import { safetyScore } from '@commandos/contracts';
import { SafetyLab } from '@commandos/runtime';

const lab = new SafetyLab(resolve('verification', 'safety-lab'));
const cancel = () => lab.cancel();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const report = await lab.run();
  for (const result of report.cases) console.log(`${result.status.toUpperCase().padEnd(9)} ${result.title}`);
  const score = safetyScore(report.cases);
  console.log(`\n${score.passed}/${score.total} scenarios passed. Scripted control evaluations; no model calls.`);
  console.log(`Evidence: ${lab.directory}/latest.json`);
  if (score.passed !== score.total || !score.total) process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
