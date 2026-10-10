import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import { env } from '../src/config/env.js';
import { confirmMatch, getDefaultStages, resetStageCache } from '../src/services/matchEngine.js';

for (const persistSummary of [true, false]) {
  test(`matching sends numeric totals and verifies their persistence (saved=${persistSummary})`, async (t) => {
    const previous = { ...env };
    env.BITRIX_WEBHOOK_URL = 'https://bitrix.example/rest/';
    env.BITRIX_REFRESH_STAGE_IDS = false;
    resetStageCache();
    t.after(() => { Object.assign(env, previous); resetStageCache(); });

    const stages = getDefaultStages();
    const deal = {
      ID: '6653', CATEGORY_ID: '5', UF_CRM_1785744431: ['901'], UF_CRM_1785062378: ['902'],
      UF_CRM_1776609678581: '8700000|AMD', UF_CRM_1776322253480: '29300000|AMD',
      UF_CRM_1789311265873: null, UF_CRM_1789311290719: null
    };
    const receipt = {
      id: 901, parentId2: 6653, stageId: stages.voucher.matched, currencyId: 'AMD',
      ufCrm19_1785737375: 8700000, ufCrm19_1785737270: 1651
    };
    const schedule = {
      id: 902, opportunity: 38000000, stageId: stages.schedule.unpaid,
      ufCrm17_1785747159082: '', ufCrm17_1785747288489: ''
    };
    const writes = [];
    let summaryReads = 0;
    t.mock.method(axios, 'create', () => ({
      async post(method, params) {
        let result;
        if (method === 'crm.deal.get.json') {
          result = { ...deal };
        } else if (method === 'crm.item.get.json') {
          if (params.entityTypeId === 2) {
            assert.equal(params.useOriginalUfNames, 'Y');
            summaryReads += 1;
          }
          result = { item: { ...(params.entityTypeId === 2 ? deal : receipt) } };
        } else if (method === 'crm.item.list.json') {
          result = { items: params.entityTypeId === 1056 ? [receipt] : [schedule] };
        } else if (method === 'crm.item.update.json') {
          writes.push(params);
          if (params.entityTypeId === 2) {
            assert.equal(params.useOriginalUfNames, 'Y');
            assert.deepEqual(params.fields, {
              UF_CRM_1785062378: ['902'], UF_CRM_1789311290719: 29300000, UF_CRM_1789311265873: 8700000
            });
            if (persistSummary) {
              // Bitrix double fields can return decimal strings after accepting JSON numbers.
              deal.UF_CRM_1789311290719 = '29300000.00';
              deal.UF_CRM_1789311265873 = '8700000.00';
            }
          }
          result = { item: {} };
        } else {
          assert.fail(`Unexpected CRM call: ${method}`);
        }
        return { data: { result } };
      }
    }));

    const matching = confirmMatch({ receiptId: '901', dealId: '6653' });
    if (persistSummary) {
      const result = await matching;
      assert.equal(result.recalculation.amdTotal, 8700000);
      assert.equal(result.recalculation.remainingTotal, 29300000);
    } else {
      await assert.rejects(matching, { status: 409, code: 'BITRIX_SUMMARY_NOT_PERSISTED' });
      assert.equal(writes.at(-1).entityTypeId, 1052);
      assert.equal(writes.at(-1).fields.stageId, stages.schedule.unpaid);
    }
    assert.equal(summaryReads, 1);
    assert.equal(writes.filter(({ entityTypeId }) => entityTypeId === 2).length, 1);
    assert.equal(deal.UF_CRM_1776609678581, '8700000|AMD');
    assert.equal(deal.UF_CRM_1776322253480, '29300000|AMD');
  });
}
