import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import { env } from '../src/config/env.js';
import { dealMatchesReceipt, getSmartDealEvidence, listReceipts, parsePurpose, resetStageCache } from '../src/services/matchEngine.js';
import { parsePurposeV2 } from '../src/services/purposePatternsV2.js';
import { resolveProject } from '../src/services/projectMapping.js';

// Names and addresses supplied by the user, independently of the matching dictionary.
const projects = [
  {
    id: '1505', name: 'Milon Plaza', variants: [
      'Միլոն Պլազա համալիր',
      'Комплекс Милон Плаза',
      'Կոտայքի մարզ, ք. Աբովյան, Օգոստոսի 23 փ. թիվ 5',
      'Район Кота, город Абовян, улица 23 Августа, дом 5'
    ]
  },
  {
    id: '1507', name: 'Milon Tower', variants: [
      'Միլոն Թաուեր համալիր',
      'Комплекс Милон Тауер',
      'Կոտայքի մարզ, ք. Աբովյան, Բարեկամության հրապարակ, 5/1',
      'Котайкская область, г. Абовян, площадь Барекамутяна, 5/1'
    ]
  },
  {
    id: '1503', name: 'Milon Hills', variants: [
      'Միլոն Հիլս թաղամաս',
      'Район Милон Хиллз',
      'Կոտայքի մարզ, ք. Առինջ Բ թաղամաս, 1-ին փ., թիվ 7',
      'Котайкская область, город Ариндж, микрорайон Б, 1-я улица, 7'
    ]
  }
];

function makeDeal(projectId, overrides = {}) {
  return {
    projectId, title: 'Contract for buyer', apartmentNumber: '55', buyerName: '',
    searchableText: 'contract 55', floor: '', area: '', ...overrides
  };
}

for (const { id, name, variants } of projects) {
  test(`${name}: all screenshot names and addresses resolve in both parsers`, () => {
    for (const value of [name, ...variants]) {
      assert.equal(resolveProject(value)?.id, id, value);
      for (const parse of [parsePurpose, parsePurposeV2]) {
        assert.equal(parse(value).project, name, value);
      }
    }
  });
}

test('real payment purpose with Armenian genitive address resolves Milon Tower', () => {
  const purpose = 'ՀՀ առուվաճառքի պայմանագրի առ 29.08.2025թ., Մարզ Կոտայք, համայնք Աբովյան ք. Բարեկամության հրապարակի 5/1 հող., նախ. հ 76, գրանց. 17289 բն.501, test payment for Deal 6653 001';
  assert.equal(resolveProject(purpose)?.id, '1507');
  assert.equal(parsePurpose(purpose).project, 'Milon Tower');
  assert.equal(parsePurposeV2(purpose).project, 'Milon Tower');

  const receipt = { purpose, parsed: parsePurposeV2(purpose) };
  const deal = {
    projectId: '1507',
    title: '501 Milon Tower',
    apartmentNumber: '501',
    floor: '6',
    area: '',
    buyerName: '',
    searchableText: '501 Milon Tower'
  };
  assert.equal(dealMatchesReceipt(receipt, deal), true);
});
test('normalizes case, whitespace, abbreviations and Unicode separators', () => {
  const cases = [
    ['МИЛОН–ТАУЭР', '1507'],
    ['Միլոն\u200b Տաուեր', '1507'],
    ['Милон Хилс', '1503'],
    ['Милон Хиллс', '1503'],
    ['MilonTower', '1507'],
    ['Milon Hills', '1503'],
    ['Աբովյան, Բարեկամության հր. 05 ∕ 01', '1507'],
    ['г. Абовян, пл. Барекамутяна, д. № 5 / 1', '1507'],
    ['Օգոստոսի 23 փողոց, շենք 5', '1505'],
    ['ул. 23 августа, д. 05', '1505'],
    ['23 Августа, дом 5', '1505'],
    ['Առինջ, Բ թաղ., 1–ին փողոց, թիվ 7', '1503'],
    ['Ариндж, мкр. Б, 1-я ул., д. 7', '1503'],
    ['Barekamutyan square 5/1', '1507'],
    ['August 23 street 5', '1505'],
    ['Arinj B district 1st street 7', '1503']
  ];
  for (const [value, id] of cases) assert.equal(resolveProject(value)?.id, id, value);
});

test('incomplete addresses and other house numbers never identify a project', () => {
  const values = [
    '5/1', 'дом 5', 'շենք 7', 'ք. Աբովյան', 'Բարեկամության հրապարակ',
    'Բարեկամության հրապարակ, բնակարան 5/1',
    'площадь Барекамутяна, 5/12', 'Բարեկամության հրապարակ 5/1/2026',
    'Բարեկամության հրապարակ 5/1-2', 'Բարեկամության հրապարակ 5/1a',
    'улица 23 Августа, дом 50', 'улица 23 Августа, дом 5/1',
    'Օգոստոսի 23 փ. թիվ 6', 'Օգոստոսի 23 փ. թիվ 5-2',
    'Առինջ Գ թաղամաս, 1-ին փ., թիվ 7', 'Առինջ Բ թաղամաս, 2-րդ փ., թիվ 7',
    'Ариндж, микрорайон Б, 1-я улица, 70',
    'xMilon Tower', 'Milon Towerhouse', '', null
  ];
  for (const value of values) {
    assert.equal(resolveProject(value), null, String(value));
    assert.equal(parsePurpose(value).project, null, String(value));
    assert.equal(parsePurposeV2(value).project, null, String(value));
  }
});

for (const v2 of [false, true]) {
  test(`project + apartment matches only the correct CRM project (V2=${v2})`, () => {
    const previous = env.SMART_MATCH_V2;
    env.SMART_MATCH_V2 = v2;
    try {
      for (const { id, variants } of projects) {
        for (const value of variants) {
          const purpose = `${value}, բնակարան 55`;
          const receipt = { purpose, parsed: (v2 ? parsePurposeV2 : parsePurpose)(purpose) };
          for (const candidate of projects) {
            assert.equal(dealMatchesReceipt(receipt, makeDeal(candidate.id)), candidate.id === id, purpose);
            const evidence = getSmartDealEvidence(receipt, makeDeal(candidate.id));
            assert.equal(evidence.matched, candidate.id === id, purpose);
            assert.equal(evidence.conflict, candidate.id !== id, purpose);
          }
          assert.equal(dealMatchesReceipt(receipt, makeDeal(id, { apartmentNumber: '56' })), false);
          const projectOnly = { purpose: value, parsed: (v2 ? parsePurposeV2 : parsePurpose)(value) };
          assert.equal(dealMatchesReceipt(projectOnly, makeDeal(id)), false, value);
        }
      }
    } finally {
      env.SMART_MATCH_V2 = previous;
    }
  });
}

for (const v2 of [false, true]) {
  test(`apartment without a building suggests matching deals from every project (V2=${v2})`, () => {
    const previous = env.SMART_MATCH_V2;
    env.SMART_MATCH_V2 = v2;

    try {
      const purpose = 'Payment for apartment 55';
      const receipt = { purpose, parsed: (v2 ? parsePurposeV2 : parsePurpose)(purpose) };
      const matchingProjects = projects
        .filter(({ id }) => dealMatchesReceipt(receipt, makeDeal(id)))
        .map(({ id }) => id);

      assert.deepEqual(matchingProjects, projects.map(({ id }) => id));
      assert.equal(dealMatchesReceipt(receipt, makeDeal('1507', { apartmentNumber: '56' })), false);

      if (v2) {
        for (const { id } of projects) {
          assert.equal(getSmartDealEvidence(receipt, makeDeal(id)).matched, true);
        }
      }
    } finally {
      env.SMART_MATCH_V2 = previous;
    }
  });
}

test('an explicit building still scopes an apartment match', () => {
  const receipt = {
    purpose: 'Payment for building 5, apartment 55',
    parsed: parsePurposeV2('Payment for building 5, apartment 55')
  };
  const buildingFive = makeDeal('1505', { searchableText: 'building 5 apartment 55' });
  const buildingSeven = makeDeal('1503', { searchableText: 'building 7 apartment 55' });

  assert.equal(dealMatchesReceipt(receipt, buildingFive), true);
  assert.equal(dealMatchesReceipt(receipt, buildingSeven), false);
});

test('CRM enum takes precedence over old text, with aliases available when the enum is missing', () => {
  const purpose = 'Միլոն Պլազա համալիր, բն. 55';
  const receipt = { purpose, parsed: parsePurpose(purpose) };
  assert.equal(dealMatchesReceipt(receipt, makeDeal('1505', { title: 'Old Milon Tower label' })), true);
  assert.equal(dealMatchesReceipt(receipt, makeDeal('1507', { title: 'Milon Plaza 55' })), false);
  assert.equal(dealMatchesReceipt(receipt, makeDeal('', { title: 'Комплекс Милон Плаза' })), true);
});

test('conflicting project names or addresses veto other matching signals', () => {
  for (const purpose of [
    'Milon Plaza / Milon Tower, apartment 55',
    'Միլոն Պլազա համալիր, Բարեկամության հրապարակ 5/1, բն. 55',
    'улица 23 Августа, дом 5; площадь Барекамутяна, 5/1; apartment 55'
  ]) {
    assert.equal(resolveProject(purpose), null);
    for (const parse of [parsePurpose, parsePurposeV2]) {
      const receipt = { purpose, parsed: parse(purpose), payerName: 'Armen Sargsyan' };
      for (const { id } of projects) {
        const candidate = makeDeal(id, { buyerName: 'Armen Sargsyan', searchableText: '55 5 7' });
        assert.equal(dealMatchesReceipt(receipt, candidate), false);
        assert.equal(getSmartDealEvidence(receipt, candidate).conflict, true);
      }
    }
  }
});

test('receipt suggestions apply project mapping to direct and contact matches without CRM writes', async (t) => {
  const previous = { ...env };
  env.BITRIX_WEBHOOK_URL = 'https://bitrix.example/rest/';
  env.BITRIX_REFRESH_STAGE_IDS = false;
  resetStageCache();
  const calls = [];
  t.mock.method(axios, 'create', () => ({
    async post(method, params) {
      calls.push(method);
      let result;
      if (method === 'crm.item.list.json') {
        const scopedPurpose = 'Котайкская область, г. Абовян, площадь Барекамутяна, 5/1, квартира 55';
        const items = params.entityTypeId === 1056 ? ['', 'AB1234567', ''].map((document, index) => ({
          id: index + 1, stageId: 'DT1056_35:NEW',
          ufCrm19_1785738531: index === 2 ? 'Payment for apartment 55' : scopedPurpose,
          ufCrm19_1785737495: document
        })) : [];
        result = { items: params.order?.id === 'DESC' ? items.reverse() : items };
      } else if (method === 'crm.deal.list.json') {
        result = projects.map(({ id }, index) => ({
          ID: index + 1, TITLE: 'Buyer contract', CONTACT_ID: '10',
          UF_CRM_1778739784729: id, UF_CRM_65BE4878488D4: '55'
        })).reverse();
      } else if (method === 'crm.contact.list.json') {
        result = [{ ID: '10', UF_CRM_1688399117351: 'AB1234567' }];
      } else {
        assert.fail(`Unexpected CRM call: ${method}`);
      }
      return { data: { result } };
    }
  }));
  try {
    for (const v2 of [false, true]) {
      env.SMART_MATCH_V2 = v2;
      const { unmatched } = await listReceipts();
      assert.equal(unmatched.length, 3);
      const scopedReceipts = unmatched.filter((receipt) => receipt.parsed.project);
      for (const receipt of scopedReceipts) {
        assert.equal(receipt.parsed.project, 'Milon Tower');
        assert.deepEqual(receipt.suggestions.map(({ deal }) => deal.projectId), ['1507']);
      }
      const apartmentOnlyReceipt = unmatched.find((receipt) => !receipt.parsed.project);
      assert.deepEqual(
        apartmentOnlyReceipt.suggestions.map(({ deal }) => deal.projectId).sort(),
        projects.map(({ id }) => id).sort()
      );
      const directReceipt = scopedReceipts.find((receipt) => !receipt.payerDocument);
      const contactReceipt = unmatched.find((receipt) => receipt.payerDocument);
      assert.equal(directReceipt.suggestions[0].label, 'Deal Match');
      assert.equal(contactReceipt.suggestions[0].label, 'Contact Match');
    }
    assert.ok(calls.every((method) => method.endsWith('.list.json')));
    assert.equal(calls.filter((method) => method === 'crm.deal.list.json').length, 1);
  } finally {
    Object.assign(env, previous);
    resetStageCache();
  }
});
