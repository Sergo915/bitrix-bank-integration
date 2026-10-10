// Shadow-mode comparison runner.
//
// Deliberately NOT wired into GET /api/receipts: that endpoint already performs dozens of
// sequential Bitrix calls, so adding a second parser to it would make a slow request slower.
// Run it on demand instead:
//
//   node src/tools/shadowCompare.js              # offline, uses the golden corpus
//   node src/tools/shadowCompare.js --live       # also measures real Bitrix data
//   node src/tools/shadowCompare.js --live --limit 200
//
// Nothing here writes to Bitrix and nothing here affects production results.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { parsePurpose } from '../services/matchEngine.js';
import { parsePurposeV2 } from '../services/purposePatternsV2.js';
import { smartFindValue } from '../services/smartMatch.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const COMPARED_FIELDS = [
  'building', 'apartment', 'addressNumber', 'entrance', 'floor',
  'preliminaryNumber', 'registrationNumber', 'contractDate', 'area', 'project'
];
// Mirrors DEAL_FIELDS in matchEngine.js; duplicated here so the tool cannot alter the engine.
const STRUCTURED_DEAL_FIELDS = {
  apartment: 'UF_CRM_65BE4878488D4',
  floor: 'UF_CRM_1686473759',
  area: 'UF_CRM_1686299562903',
  section: 'UF_CRM_1779963968563'
};
const KIND_BY_FIELD = { apartment: 'apartment', floor: 'floor', area: 'area', section: 'label' };

function readCorpus() {
  const golden = JSON.parse(readFileSync(resolve(currentDir, '../../test/golden/parsePurpose.golden.json'), 'utf8'));

  return golden.map((entry) => entry.input);
}

function compareParsers(purposes) {
  const report = {
    total: purposes.length,
    legacyOnly: 0,
    v2Only: 0,
    bothAgree: 0,
    disagree: 0,
    perField: {},
    disagreements: []
  };

  for (const field of COMPARED_FIELDS) {
    report.perField[field] = { legacyOnly: 0, v2Only: 0, different: 0, equal: 0 };
  }

  for (const purpose of purposes) {
    const legacy = parsePurpose(purpose);
    const next = parsePurposeV2(purpose);
    let differed = false;

    for (const field of COMPARED_FIELDS) {
      const before = legacy[field];
      const after = next[field];
      const bucket = report.perField[field];

      if (before === after) {
        bucket.equal += 1;
        continue;
      }

      differed = true;

      if (before !== null && after === null) bucket.legacyOnly += 1;
      else if (before === null && after !== null) bucket.v2Only += 1;
      else bucket.different += 1;

      report.disagreements.push({ purpose, field, legacy: before, v2: after });
    }

    if (differed) report.disagree += 1;
    else report.bothAgree += 1;
  }

  report.legacyOnly = Object.values(report.perField).reduce((sum, bucket) => sum + bucket.legacyOnly, 0);
  report.v2Only = Object.values(report.perField).reduce((sum, bucket) => sum + bucket.v2Only, 0);

  return report;
}

function measureCost(purposes) {
  const started = process.hrtime.bigint();
  for (const purpose of purposes) parsePurpose(purpose);
  const legacyNs = Number(process.hrtime.bigint() - started);

  const startedV2 = process.hrtime.bigint();
  for (const purpose of purposes) parsePurposeV2(purpose);
  const v2Ns = Number(process.hrtime.bigint() - startedV2);

  return {
    legacyMs: legacyNs / 1e6,
    v2Ms: v2Ns / 1e6,
    ratio: legacyNs === 0 ? null : v2Ns / legacyNs
  };
}

function summariseSmartMatch(pairs) {
  const levels = { exact: 0, normalized: 0, regex: 0, fuzzy: 0, none: 0 };
  const confidences = [];

  for (const { haystack, target, kind } of pairs) {
    const result = smartFindValue(haystack, target, { kind });

    if (!result) {
      levels.none += 1;
      continue;
    }

    levels[result.level] += 1;
    confidences.push(result.confidence);
  }

  confidences.sort((left, right) => left - right);

  return {
    levels,
    matched: confidences.length,
    minConfidence: confidences[0] ?? null,
    medianConfidence: confidences[Math.floor(confidences.length / 2)] ?? null,
    maxConfidence: confidences[confidences.length - 1] ?? null
  };
}

async function measureStructuredCoverage(limit) {
  const { listBitrixMethod } = await import('../services/bitrixClient.js');
  const deals = await listBitrixMethod('crm.deal.list', {
    filter: { CATEGORY_ID: 5 },
    select: ['ID', 'TITLE', ...Object.values(STRUCTURED_DEAL_FIELDS)],
    order: { ID: 'DESC' }
  });
  const sample = deals.slice(0, limit);
  const coverage = {};

  for (const [name, id] of Object.entries(STRUCTURED_DEAL_FIELDS)) {
    const filled = sample.filter((deal) => String(deal[id] ?? '').trim() !== '').length;

    coverage[name] = {
      field: id,
      filled,
      total: sample.length,
      percent: sample.length ? Number(((filled / sample.length) * 100).toFixed(1)) : 0
    };
  }

  return { sampled: sample.length, totalDeals: deals.length, coverage, sample };
}

async function measureLiveMatching(limit) {
  const { listReceipts } = await import('../services/matchEngine.js');
  const board = await listReceipts();
  const receipts = [...board.unmatched, ...board.matched].slice(0, limit);
  const structured = await measureStructuredCoverage(limit);
  const pairs = [];

  for (const receipt of receipts) {
    for (const deal of structured.sample) {
      for (const [name, id] of Object.entries(STRUCTURED_DEAL_FIELDS)) {
        const target = String(deal[id] ?? '').trim();

        if (target) pairs.push({ haystack: receipt.purpose, target, kind: KIND_BY_FIELD[name] });
      }
    }
  }

  return {
    receipts: receipts.length,
    structured,
    parser: compareParsers(receipts.map((receipt) => receipt.purpose)),
    smartMatch: summariseSmartMatch(pairs.slice(0, 20000))
  };
}

function printReport(title, report) {
  console.log(`\n=== ${title} ===`);
  console.log(`purposes compared      : ${report.total}`);
  console.log(`identical on all fields: ${report.bothAgree}`);
  console.log(`differ on >=1 field    : ${report.disagree}`);
  console.log(`legacy found / V2 null : ${report.legacyOnly}`);
  console.log(`legacy null / V2 found : ${report.v2Only}`);
  console.log('\nper field  legacy-only  v2-only  different  equal');

  for (const [field, bucket] of Object.entries(report.perField)) {
    console.log(
      `  ${field.padEnd(20)} ${String(bucket.legacyOnly).padStart(6)} ${String(bucket.v2Only).padStart(8)} ${String(bucket.different).padStart(10)} ${String(bucket.equal).padStart(6)}`
    );
  }
}

async function main() {
  const live = process.argv.includes('--live');
  const limitIndex = process.argv.indexOf('--limit');
  const limit = limitIndex === -1 ? 50 : Number(process.argv[limitIndex + 1]) || 50;
  const corpus = readCorpus();

  console.log(`SMART_MATCH_V2 flag    : ${env.SMART_MATCH_V2}`);
  printReport('OFFLINE / golden corpus', compareParsers(corpus));

  const cost = measureCost(corpus);
  console.log(`\nCPU over ${corpus.length} purposes: legacy ${cost.legacyMs.toFixed(1)} ms, V2 ${cost.v2Ms.toFixed(1)} ms, ratio x${cost.ratio.toFixed(2)}`);

  if (!live) {
    console.log('\nRun with --live to measure structured CRM field coverage against the real portal.');
    return;
  }

  if (!env.BITRIX_WEBHOOK_URL) {
    console.log('\n--live requested but BITRIX_WEBHOOK_URL is not configured; skipping live phase.');
    return;
  }

  const liveReport = await measureLiveMatching(limit);

  console.log(`\n=== LIVE / Bitrix (sample ${liveReport.structured.sampled} of ${liveReport.structured.totalDeals} deals) ===`);
  console.log('structured field coverage:');

  for (const [name, entry] of Object.entries(liveReport.structured.coverage)) {
    console.log(`  ${name.padEnd(10)} ${entry.field.padEnd(24)} ${entry.filled}/${entry.total} (${entry.percent}%)`);
  }

  printReport('LIVE / real payment purposes', liveReport.parser);
  console.log('\nsmart match levels:', JSON.stringify(liveReport.smartMatch.levels));
  console.log('confidence min/median/max:', liveReport.smartMatch.minConfidence, liveReport.smartMatch.medianConfidence, liveReport.smartMatch.maxConfidence);
}

main().catch((error) => {
  console.error('Shadow comparison failed:', error.message);
  process.exitCode = 1;
});
