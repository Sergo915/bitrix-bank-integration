import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { addActivity, getActivityLog } from './activityStore.js';
import { callBitrixMethod, listBitrixMethod, listBitrixDealsById } from './bitrixClient.js';
import { env } from '../config/env.js';
import { parsePurposeV2 } from './purposePatternsV2.js';
import { canonicalizeNumeric, smartFindValue } from './smartMatch.js';
import { normalizeBankTransaction } from './transactionValidation.js';
import { BUILDING_OPTIONS, findProjects, getProjectById, resolveProject } from './projectMapping.js';
import { runWithKeyedLock } from './keyedLock.js';
import { getTrashedReceiptIds } from './receiptTrashStore.js';

const TYPES = {
  voucher: {
    entityTypeId: 1056,
    categoryId: 35,
    stages: {
      new: 'DT1056_35:NEW',
      matched: 'DT1056_35:PREPARATION'
    },
    fields: {
      payerName: 'ufCrm19_1785737436',
      beneficiaryName: 'ufCrm19_1785737603',
      amount: 'ufCrm19_1785737375',
      paymentDate: 'ufCrm19_1785736747',
      currencyEnum: 'ufCrm19_1785737270',
      purpose: 'ufCrm19_1785738531',
      debit: 'ufCrm19_1785736905',
      credit: 'ufCrm19_1785737256',
      payerDocument: 'ufCrm19_1785737495',
      payerAddress: 'ufCrm19_1785737544',
      amountWords: 'ufCrm19_1785738501',
      bankTransactionId: 'ufCrm19_1789042243'
    }
  },
  schedule: {
    entityTypeId: 1052,
    categoryId: 33,
    stages: {
      unpaid: 'DT1052_33:NEW',
      partial: 'DT1052_33:PREPARATION',
      paid: 'DT1052_33:CLIENT'
    },
    fields: {
      firstName: 'ufCrm17_1784111700810',
      lastName: 'ufCrm17_1784111710154',
      middleName: 'ufCrm17_1784111720716',
      paymentDate: 'ufCrm17_1784111873449',
      advancePaid: 'ufCrm17_1785054336',
      partialPaid: 'ufCrm17_1785747159082',
      remaining: 'ufCrm17_1785747288489'
    }
  }
};

const DEAL_SELECT = [
  'ID',
  'TITLE',
  'CATEGORY_ID',
  'STAGE_ID',
  'STAGE_SEMANTIC_ID',
  'CONTACT_ID',
  'OPPORTUNITY',
  'CURRENCY_ID',
  'UF_CRM_1716720255166',
  'UF_CRM_65BE4878488D4',
  'UF_*'
];
const DEAL_FIELDS = {
  categoryId: 'CATEGORY_ID',
  contactId: 'CONTACT_ID',
  receiptIds: 'UF_CRM_1785744431',
  scheduleIds: 'UF_CRM_1785062378',
  // Bitrix metadata: double, precision 2 (the retired fields were money).
  balance: 'UF_CRM_1789311290719',
  paidTotal: 'UF_CRM_1789311265873',
  buyerName: 'UF_CRM_1716720255166',
  apartmentChecked: 'UF_CRM_1776254518',
  apartmentNumber: 'UF_CRM_65BE4878488D4',
  floor: 'UF_CRM_1686473759',
  area: 'UF_CRM_1686299562903',
  project: 'UF_CRM_1778739784729',
  buildingSection: 'UF_CRM_1779963968563'
};
const CONTACT_FIELDS = {
  documentNumber: 'UF_CRM_1688399117351'
};
const CURRENCY_ENUM = {
  AMD: 1651,
  USD: 1653,
  RUB: 1655,
  EUR: 1657
};
const STATUS_ENTITY_IDS = {
  voucher: 'DYNAMIC_1056_35',
  schedule: 'DYNAMIC_1052_STAGE_33'
};
const STATUS_ELEMENT_IDS = {
  voucher: { new: 517, matched: 519 },
  schedule: { unpaid: 491, partial: 493, paid: 495 }
};
// Shared by the full listing and the delta sync, so a receipt arriving either way carries
// exactly the same fields and mapVoucherData() never sees a half-populated item.
const VOUCHER_SELECT = [
  'id',
  'title',
  'xmlId',
  TYPES.voucher.fields.bankTransactionId,
  'stageId',
  'parentId2',
  'opportunity',
  'currencyId',
  'createdTime',
  'updatedTime',
  TYPES.voucher.fields.payerName,
  TYPES.voucher.fields.amount,
  TYPES.voucher.fields.paymentDate,
  TYPES.voucher.fields.currencyEnum,
  TYPES.voucher.fields.purpose,
  TYPES.voucher.fields.payerDocument,
  TYPES.voucher.fields.payerAddress
];
const DOCUMENT_PREFIX_LENGTH = 9;
const MIN_DOCUMENT_PREFIX_LENGTH = 6;
const MAX_CONTACT_LOOKUPS = 25;
const CONTACT_MATCH_SCORE = 110;
const RECENT_DEALS_CACHE_TTL_MS = 30000;
const RECENT_DEALS_STALE_TTL_MS = 300000;
const receiptImportLocks = new Map();
const matchLocks = new Map();
const dealLocks = new Map();
let stagesPromise = null;
let receiptBoardLoadPromise = null;
let receiptBoardLoadGeneration = -1;
let receiptBoardGeneration = 0;
let receiptBoardCacheLoaded = false;
let receiptBoardCache = null;
let receiptBoardCacheWriteQueue = Promise.resolve();
let recentDealsPromise = null;
let recentDealsCache = null;
let recentDealsGeneration = 0;
// Delta syncs are cheap but must not interleave: two of them patching the same cached board
// from different snapshots would lose one of the two sets of changes.
let receiptSyncQueue = Promise.resolve();
// Document-number lookups dominate a rebuild -- one Bitrix call per payer the bulk filter
// misses -- and the answer is stable, so it is remembered between rebuilds.
const contactIdsByDocumentPrefix = new Map();

// Payment purposes arrive from several banks and are commonly typed with compact Armenian,
// Russian, English, and transliterated abbreviations. Keep every field independent so forms
// such as `bn48` and `48bn` cannot swap the apartment and building capture groups.
const PURPOSE_PATTERNS = {
  building: [
    /(?<![\p{L}\p{N}])(?:շենք|շնք|շ\.|շենքի|дом|корпус|building|bldg?\.?|shenk|sh\.)\s*(?:թիվ|համար|№|#|n(?:o)?\.?)?\s*[-:]?\s*(\d{1,4})(?!\d)/iu,
    /(?<!\d)(\d{1,4})\s*(?:-?րդ)?\s*[-:]?\s*(?:շենք|շնք|շ\.|շենքի|дом|корпус|building|bldg?\.?|shenk|sh\.)(?![\p{L}\p{N}])/iu
  ],
  apartment: [
    /(?<![\p{L}\p{N}])(?:բնակարան|բնակ\.?|բն\.?|բ\.|կվ\.?|кв\.?|квартира|apt\.?|apartment|flat|bn\.?)\s*(?:թիվ|համար|№|#|n(?:o)?\.?)?\s*[-:]?\s*(\d{1,4}(?:[/-]\d{1,3})?[a-zա-ֆ]?)(?![\p{L}\p{N}])/iu,
    /(?<![\p{L}\p{N}])(\d{1,4}(?:[/-]\d{1,3})?[a-zա-ֆ]?)\s*(?:-?րդ)?\s*[-:]?\s*(?:բնակարան|բնակ\.?|բն\.?|բ\.|կվ\.?|кв\.?|квартира|apt\.?|apartment|flat|bn\.?)(?![\p{L}\p{N}])/iu
  ],
  entrance: [
    /(?<![\p{L}\p{N}])(?:մուտք|մտք\.?|entrance|entry|подъезд)\s*(?:թիվ|համար|№|#|n(?:o)?\.?)?\s*[-:]?\s*(\d{1,2})(?!\d)/iu,
    /(?<!\d)(\d{1,2})\s*(?:-?րդ)?\s*[-:]?\s*(?:մուտք|մտք\.?|entrance|entry|подъезд)(?![\p{L}\p{N}])/iu
  ],
  floor: [
    /(?<![\p{L}\p{N}])(?:հարկ|հրկ\.?|floor|fl\.?|этаж)\s*(?:թիվ|համար|№|#|n(?:o)?\.?)?\s*[-:]?\s*(-?\d{1,2})(?!\d)/iu,
    /(?<!\d)(-?\d{1,2})\s*(?:-?րդ)?\s*[-:]?\s*(?:հարկ|հրկ\.?|floor|fl\.?|этаж)(?![\p{L}\p{N}])/iu
  ],
  preliminaryNumber: [
    /(?<![\p{L}\p{N}])(?:նախ(?:նական)?\.?\s*(?:համար|համ\.?|հ\.?)|preliminary\s*(?:no\.?)?|նախահամար)\s*[:#№-]?\s*(\d{1,6}(?:[.,/-]\d{1,4})?)/iu
  ],
  registrationNumber: [
    /(?<![\p{L}\p{N}])(?:գրանց(?:ման)?\.?\s*(?:համար|համ\.?|հ\.?)?|registration\s*(?:no\.?)?|reg\.?\s*(?:no\.?)?)\s*[:#№-]?\s*([\p{L}\d]+(?:[/-][\p{L}\d]+)*)/iu
  ],
  area: [
    /(?<![\p{L}\p{N}])(?:մակ\.?|մակերես|area|square)\s*[:#-]?\s*(\d{1,4}(?:[.,]\d{1,2})?)(?:\s*(?:քմ|մ²|m²|sq\.?\s*m))?/iu,
    /(?<![\p{L}\p{N}])(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:քմ|մ²|m²|sq\.?\s*m)(?![\p{L}\p{N}])/iu
  ],
  contractDate: [
    /(?<!\d)(\d{1,2}[./-]\d{1,2}[./-]\d{4})(?![./-]?\d)/u,
    /(?<!\d)(\d{4}-\d{1,2}-\d{1,2})(?!\d)/u
  ],
  addressNumber: [
    /(?<![\p{L}\p{N}])(?:հասցե|փողոց|պողոտա|տուն|address|street|st\.?)\s*(?:թիվ|համար|№|#|n(?:o)?\.?)?\s*[-:]?\s*(\d{1,4}\/\d{1,3})(?![./-]?\d)/iu,
    /(?<![\p{L}\p{N}])(\d{1,4}\/\d{1,3})\s*(?:հասցե|փողոց|պողոտա|տուն|address|street|st\.?)(?![\p{L}\p{N}])/iu,
    /(?<![\d./-])(\d{1,4}\/\d{1,3})(?![\d./-])/u
  ]
};

export function resetStageCache() {
  stagesPromise = null;
  recentDealsPromise = null;
  recentDealsCache = null;
  recentDealsGeneration += 1;
}

async function getStages() {
  stagesPromise ??= loadStages();
  return stagesPromise;
}

async function loadStages() {
  const stages = getDefaultStages();

  if (!env.BITRIX_REFRESH_STAGE_IDS) {
    return stages;
  }

  try {
    const statuses = await listBitrixMethod('crm.status.list', {
      filter: { '@ENTITY_ID': Object.values(STATUS_ENTITY_IDS) },
      order: { SORT: 'ASC' }
    });
    const statusIdByElementId = new Map(statuses.map((status) => [String(status.ID), status.STATUS_ID]));

    for (const [type, elementIds] of Object.entries(STATUS_ELEMENT_IDS)) {
      for (const [key, elementId] of Object.entries(elementIds)) {
        const statusId = statusIdByElementId.get(String(elementId));

        if (statusId) {
          stages[type][key] = statusId;
        }
      }
    }
  } catch {
    // Bitrix unreachable or crm.status.list is not permitted: fall back to the documented stage ids
  }

  return stages;
}

export function parsePurpose(purpose = '') {
  const normalized = normalize(purpose);
  const contractDate = matchFirst(normalized, PURPOSE_PATTERNS.contractDate);
  const withoutDates = maskMatches(normalized, PURPOSE_PATTERNS.contractDate);
  const project = resolveProject(normalized);
  const projectBuilding = matchFirst(normalized, [
    /(?<!\d)(\d{1,4})\s*(?:milon\s*tower|միլոն\s*թաուեր|միլոն\s*տաուեր)(?![\p{L}\p{N}])/iu,
    /(?<![\p{L}\p{N}])(?:milon\s*tower|միլոն\s*թաուեր|միլոն\s*տաուեր)\s*(?:շենք|building|bldg?\.?)?\s*(?:թիվ|№|#|n(?:o)?\.?)?\s*(\d{1,4})(?!\d)/iu
  ]);
  const building = matchFirst(normalized, PURPOSE_PATTERNS.building);
  const apartment = matchFirst(normalized, PURPOSE_PATTERNS.apartment);
  const withoutDatesOrApartments = maskMatches(withoutDates, PURPOSE_PATTERNS.apartment);
  const addressNumber = matchFirst(withoutDatesOrApartments, PURPOSE_PATTERNS.addressNumber);
  const entrance = matchFirst(normalized, PURPOSE_PATTERNS.entrance);
  const floor = matchFirst(normalized, PURPOSE_PATTERNS.floor);
  const preliminaryNumber = matchFirst(normalized, PURPOSE_PATTERNS.preliminaryNumber);
  const registrationNumber = matchFirst(normalized, PURPOSE_PATTERNS.registrationNumber);
  const area = matchFirst(withoutDates, PURPOSE_PATTERNS.area);

  return {
    normalized,
    building: building?.[1] ?? projectBuilding?.[1] ?? null,
    apartment: apartment?.[1] ?? preliminaryNumber?.[1] ?? null,
    addressNumber: addressNumber?.[1] ?? null,
    entrance: entrance?.[1] ?? null,
    floor: floor?.[1] ?? null,
    preliminaryNumber: preliminaryNumber?.[1] ?? null,
    registrationNumber: registrationNumber?.[1] ?? null,
    contractDate: contractDate?.[1] ?? null,
    area: area?.[1]?.replace(',', '.') ?? null,
    project: project?.name ?? null
  };
}

export function listReceipts() {
  return refreshReceiptBoardCache();
}

export async function listCachedReceipts() {
  await ensureReceiptBoardCacheLoaded();
  if (hasCacheableReceipts(receiptBoardCache?.board)) {
    // A stale board used to start a full rebuild here. That cost minutes, and because the
    // rebuild could not finish before the next change invalidated it, the cache stayed stale
    // and every single request started yet another one. A delta sync is one Bitrix request
    // and brings the board up to date for everything except the recomputed figures.
    if (Date.now() - receiptBoardCache.updatedAt >= env.RECEIPT_BOARD_CACHE_TTL_MS) {
      syncReceiptBoard({ reason: 'stale read' }).catch((error) => {
        console.error('Could not sync receipt board:', error.message);
      });
    }
    return receiptBoardCache.board;
  }
  return refreshReceiptBoardCache();
}

// A failing or throttled Bitrix returns no vouchers, which loadReceipts() reports as a
// perfectly good empty board. Caching one hid every real receipt behind an empty page until
// the TTL expired, and the file on disk survived restarts. An empty board is also the one
// board that is cheap to rebuild, since loadReceipts() short-circuits before deals and
// schedules, so it is never worth storing.
function hasCacheableReceipts(board) {
  return Boolean(board?.unmatched?.length || board?.matched?.length || board?.trashed?.length);
}

export function refreshReceiptBoardCache() {
  // A load started before the last change must not be shared or stored: it would answer a
  // post-change request with a pre-change board and then cache it as if it were current.
  if (receiptBoardLoadPromise && receiptBoardLoadGeneration === receiptBoardGeneration) {
    return receiptBoardLoadPromise;
  }

  const generation = receiptBoardGeneration;
  const supersededLoad = receiptBoardLoadPromise;
  const startedAt = Date.now();
  const currentPromise = Promise.resolve(supersededLoad)
    .catch(() => undefined)
    .then(() => loadReceipts())
    .then(async (board) => {
      if (!hasCacheableReceipts(board)) return board;

      // A rebuild costs minutes, so throwing one away because a receipt was matched while it
      // ran -- the old behaviour -- meant that on a busy board no rebuild ever landed and the
      // cache went stale for a whole day. The fresh board is kept, and the handful of changes
      // made during the rebuild are folded back on top by a delta sync, which is one request.
      const superseded = generation !== receiptBoardGeneration;
      receiptBoardCache = {
        updatedAt: Date.now(),
        // Anything Bitrix touched after the rebuild began may be missing from it.
        syncedAt: new Date(startedAt).toISOString(),
        board
      };
      await persistReceiptBoardCache();

      if (!superseded) return board;

      try {
        await syncReceiptBoard({ reason: 'post-rebuild catch-up' });
      } catch (error) {
        console.error('Could not catch up after the receipt board rebuild:', error.message);
      }

      return receiptBoardCache?.board ?? board;
    })
    .finally(() => {
      if (receiptBoardLoadPromise === currentPromise) receiptBoardLoadPromise = null;
    });

  receiptBoardLoadPromise = currentPromise;
  receiptBoardLoadGeneration = generation;
  return currentPromise;
}

// The targeted counterpart of a rebuild: it asks Bitrix only about the receipts that can have
// changed -- the ones touched since the last sync, plus any the caller names explicitly, which
// is how a match or an undo refreshes exactly the one or two receipts it touched -- and patches
// those into the cached board. One Bitrix request in the ordinary case.
export function syncReceiptBoard(options = {}) {
  const run = () => syncReceiptBoardOnce(options);
  const next = receiptSyncQueue.then(run, run);

  receiptSyncQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function syncReceiptBoardOnce({ receiptIds = [], reason = 'poll' } = {}) {
  await ensureReceiptBoardCacheLoaded();

  const requestedIds = [...new Set(receiptIds.map((id) => String(id ?? '')).filter(Boolean))];

  // With nothing cached there is no board to patch, so the first load has to be a full one.
  if (!hasCacheableReceipts(receiptBoardCache?.board)) {
    const board = await refreshReceiptBoardCache();
    return { receipts: [], removedIds: [], rebuilt: true, syncedAt: receiptBoardCache?.syncedAt ?? null, board };
  }

  const startedAt = Date.now();
  const since = getSyncSince();
  const stages = await getStages();
  const [updated, requested] = await Promise.all([
    listBitrixVouchersUpdatedSince(since),
    Promise.all(requestedIds.map((id) => readRequestedVoucher(id)))
  ]);

  const itemsById = new Map();
  for (const item of updated) itemsById.set(String(item.id), item);

  const removedIds = [];

  for (const [index, result] of requested.entries()) {
    if (result.item) itemsById.set(requestedIds[index], result.item);
    // Only a receipt Bitrix positively reports as gone is taken off the board. Reading
    // deletion out of an empty list answer instead would let one failed or filtered request
    // erase a receipt that is still there.
    else if (result.gone) removedIds.push(requestedIds[index]);
  }

  const receipts = [...itemsById.values()].map((item) => mapVoucherData(item, stages));
  const suggestionsById = await getSuggestionsForNewReceipts(receipts, stages);

  for (const receipt of receipts) {
    const suggestions = suggestionsById.get(receipt.id);
    await upsertCachedBoardReceipt(suggestions ? { ...receipt, suggestions } : receipt, { bump: false });
  }
  for (const id of removedIds) await removeCachedBoardReceipt(id, { bump: false });

  if (receiptBoardCache) {
    receiptBoardCache = {
      ...receiptBoardCache,
      updatedAt: Date.now(),
      syncedAt: new Date(startedAt).toISOString(),
      board: { ...receiptBoardCache.board, log: await getActivityLog() }
    };
    await persistReceiptBoardCache();
  }

  if (receipts.length || removedIds.length) {
    console.log(`Receipt board sync (${reason}): ${receipts.length} updated, ${removedIds.length} removed`);
  }

  return {
    receipts,
    removedIds,
    rebuilt: false,
    syncedAt: receiptBoardCache?.syncedAt ?? null,
    log: receiptBoardCache?.board?.log ?? []
  };
}

// The window is widened a little because Bitrix stamps updatedTime on its own clock: without
// the overlap a receipt saved in the same second as the previous sync is never seen again.
function getSyncSince() {
  const cached = receiptBoardCache?.syncedAt ? Date.parse(receiptBoardCache.syncedAt) : NaN;
  const base = Number.isFinite(cached) ? cached : receiptBoardCache?.updatedAt;

  if (!Number.isFinite(base)) return null;

  return new Date(base - env.RECEIPT_BOARD_SYNC_OVERLAP_MS).toISOString();
}

function listBitrixVouchersUpdatedSince(since) {
  if (!since) return Promise.resolve([]);

  return listBitrixMethod('crm.item.list', {
    entityTypeId: TYPES.voucher.entityTypeId,
    order: { id: 'DESC' },
    filter: { categoryId: TYPES.voucher.categoryId, '>=updatedTime': since },
    select: VOUCHER_SELECT
  });
}

// The precise read: one receipt, by id, straight from Bitrix. This is what a match or an undo
// uses to confirm what Bitrix actually stored, instead of rebuilding the whole board for it.
async function readRequestedVoucher(receiptId) {
  let item;

  try {
    item = await getBitrixVoucher(receiptId);
  } catch (error) {
    // Bitrix rejects an id it does not have; anything else is a transport failure and says
    // nothing about whether the receipt still exists.
    const gone = error.status === 400 || /not\s*found|does not exist/iu.test(error.message ?? '');
    if (!gone) console.warn(`Could not read receipt ${receiptId} from Bitrix: ${error.message}`);
    return { item: null, gone };
  }

  if (!item?.id) return { item: null, gone: true };
  // Moved out of the bank-receipt category: it no longer belongs on this board either.
  if (Number(item.categoryId) !== TYPES.voucher.categoryId) return { item: null, gone: true };

  return { item, gone: false };
}

// Suggestions need every deal and schedule, which is the expensive half of a rebuild, so they
// are only computed for receipts the board has never seen. A receipt already on it keeps the
// suggestions the last rebuild worked out. In the common case -- nothing new -- this costs
// nothing at all.
async function getSuggestionsForNewReceipts(receipts, stages) {
  const board = receiptBoardCache?.board;
  const known = new Set(
    ['unmatched', 'matched', 'trashed'].flatMap((name) => (board?.[name] ?? []).map((item) => String(item.id)))
  );
  const fresh = receipts.filter((receipt) => receipt.status === 'unmatched' && !known.has(receipt.id));

  if (!fresh.length) return new Map();

  const [scheduleResponse, deals] = await Promise.all([listBitrixSchedules(), listRecentDeals()]);
  const dealById = new Map(deals.map((deal) => [deal.id, deal]));
  const schedules = scheduleResponse.items
    .map(mapSchedule)
    .map((schedule) => ({ ...schedule, deal: dealById.get(schedule.dealId) ?? null }));
  const boardReceipts = ['unmatched', 'matched', 'trashed'].flatMap((name) => board?.[name] ?? []);
  const context = {
    deals,
    contactDealsByDocument: await loadContactDealsByDocument(fresh, deals),
    receipts: [...boardReceipts, ...fresh],
    stages
  };

  return new Map(fresh.map((receipt) => [receipt.id, getSuggestions(receipt, schedules, context)]));
}

// Rebuilding the board costs around two minutes, so a change is applied to the cached copy
// instead of throwing it away: readers keep getting an instant board, and it already reflects
// what just happened. What the patch cannot know -- the fields Bitrix itself rewrote during
// the match -- is then read back for that one receipt, which is a single request.
async function updateCachedBoardReceipt(receiptId, change, { target = 'auto', refresh = true, bump = true } = {}) {
  // Bumped before anything is awaited, so a load already in flight cannot overwrite the cache.
  if (bump) receiptBoardGeneration += 1;

  const id = String(receiptId ?? '');

  // The cache is read from disk lazily. Without this the first change after a restart would
  // patch nothing and the stale board on disk would be served again.
  try {
    await ensureReceiptBoardCacheLoaded();
  } catch (error) {
    console.error('Could not read the receipt board cache before patching it:', error.message);
  }

  const board = receiptBoardCache?.board;

  if (id && board) {
    const columns = ['unmatched', 'matched', 'trashed'];
    const column = columns.find((name) => (board[name] ?? []).some((item) => String(item.id) === id));

    if (column) {
      const receipt = board[column].find((item) => String(item.id) === id);
      const updated = { ...receipt, ...change };
      const byStatus = updated.status === 'matched' ? 'matched' : 'unmatched';
      // 'auto' keeps a receipt in the trash where it is: a match or undo must not quietly pull
      // it back onto the board. 'trashed' and 'active' are the explicit trash moves.
      const destination = target === 'auto'
        ? (column === 'trashed' ? 'trashed' : byStatus)
        : (target === 'trashed' ? 'trashed' : byStatus);
      const next = { ...board };

      for (const name of columns) next[name] = (board[name] ?? []).filter((item) => String(item.id) !== id);
      next[destination] = [updated, ...next[destination]];
      receiptBoardCache = { ...receiptBoardCache, updatedAt: Date.now(), board: next };
      persistReceiptBoardCache().catch((error) => {
        console.error('Could not persist the patched receipt board cache:', error.message);
      });
    }
  }

  // Reading just this receipt back out of Bitrix confirms the patch against the source and
  // picks up whatever else the match rewrote on it. A full rebuild used to run here; it took
  // two minutes, was discarded by the next click, and left the board frozen for hours.
  if (refresh) {
    syncReceiptBoard({ receiptIds: id ? [id] : [], reason: 'receipt change' }).catch((error) => {
      console.error('Could not sync the changed receipt:', error.message);
    });
  }
}

// Trashing is a filter over receipts the board already holds -- it changes nothing in Bitrix.
// Rebuilding for it cost two minutes of Bitrix traffic and CPU per click, and because each
// click also invalidated the board, rebuilds kept superseding one another and discarding their
// results: the cache went unwritten for minutes, so reopening the app showed the receipt back
// in the trash and receipts created meanwhile never appeared at all.
//
// The generation is deliberately left alone here. loadReceipts() reads the trash store as its
// final step, so a rebuild already in flight picks the change up by itself, and the periodic
// warm-up corrects the one-step window where it does not.
const TRASH_PATCH = { refresh: false, bump: false };

export function trashReceiptOnBoard(receiptId) {
  return updateCachedBoardReceipt(receiptId, {}, { ...TRASH_PATCH, target: 'trashed' });
}

export function restoreReceiptOnBoard(receiptId) {
  return updateCachedBoardReceipt(receiptId, {}, { ...TRASH_PATCH, target: 'active' });
}

// Bitrix tells us about a receipt created or edited outside the app, so that one receipt is
// fetched and placed on the cached board. Waiting for the periodic rebuild instead meant up to
// three and a half minutes before it showed up at all.
//
// Its suggestions stay empty until that rebuild: computing them needs every schedule and deal,
// which is the expensive part. The receipt is visible and matchable by hand in the meantime.
export async function applyReceiptEventToBoard({ id, entityTypeId, event } = {}) {
  const receiptId = String(id ?? '').trim();

  if (!receiptId) return { applied: false, reason: 'event carried no receipt id' };

  if (entityTypeId !== undefined && entityTypeId !== null && String(entityTypeId) !== ''
    && String(entityTypeId) !== String(TYPES.voucher.entityTypeId)) {
    return { applied: false, reason: `entity type ${entityTypeId} is not the receipt process` };
  }

  if (String(event ?? '').toUpperCase().includes('DELETE')) {
    return { applied: await removeCachedBoardReceipt(receiptId), reason: 'deleted' };
  }

  const [stages, item] = await Promise.all([getStages(), getBitrixVoucher(receiptId)]);

  if (Number(item?.categoryId) !== TYPES.voucher.categoryId) {
    return { applied: false, reason: 'receipt is outside the bank receipt category' };
  }

  return { applied: await upsertCachedBoardReceipt(mapVoucherData(item, stages)), reason: 'upserted' };
}

async function withCachedBoard(mutate, { bump = true } = {}) {
  // Bumped so a rebuild that started before the event cannot overwrite the result. A delta
  // sync passes bump: false -- it has just read the truth out of Bitrix, so invalidating a
  // rebuild in flight would only throw away work that is already correct.
  if (bump) receiptBoardGeneration += 1;

  try {
    await ensureReceiptBoardCacheLoaded();
  } catch (error) {
    console.error('Could not read the receipt board cache before patching it:', error.message);
  }

  const board = receiptBoardCache?.board;

  // With nothing cached yet there is nothing to patch; the next rebuild covers it.
  if (!board) return false;

  const next = mutate(board);
  if (!next) return false;

  // The patched board is current, so it is stamped as such. Keeping the old timestamp -- the
  // previous behaviour -- left the cache permanently past its TTL, and every read then kicked
  // off another rebuild.
  receiptBoardCache = { ...receiptBoardCache, updatedAt: Date.now(), board: next };
  await persistReceiptBoardCache();
  return true;
}

function upsertCachedBoardReceipt(receipt, options = {}) {
  const id = String(receipt.id);

  return withCachedBoard((board) => {
    const columns = ['unmatched', 'matched', 'trashed'];
    const existing = columns
      .map((name) => (board[name] ?? []).find((item) => String(item.id) === id))
      .find(Boolean);
    const inTrash = (board.trashed ?? []).some((item) => String(item.id) === id);
    // Keep whatever suggestions the last rebuild worked out for a receipt we already knew,
    // unless the caller computed fresh ones for a receipt the board has never seen.
    const merged = { ...existing, ...receipt, suggestions: receipt.suggestions ?? existing?.suggestions ?? [] };
    const destination = inTrash ? 'trashed' : (merged.status === 'matched' ? 'matched' : 'unmatched');
    const next = { ...board };

    for (const name of columns) next[name] = (board[name] ?? []).filter((item) => String(item.id) !== id);
    next[destination] = [merged, ...next[destination]];
    return next;
  }, options);
}

function removeCachedBoardReceipt(receiptId, options = {}) {
  const id = String(receiptId);

  return withCachedBoard((board) => {
    const columns = ['unmatched', 'matched', 'trashed'];
    if (!columns.some((name) => (board[name] ?? []).some((item) => String(item.id) === id))) return null;

    const next = { ...board };
    for (const name of columns) next[name] = (board[name] ?? []).filter((item) => String(item.id) !== id);
    return next;
  }, options);
}

// Test-only, the counterpart of resetStageCache(): the cached board and its one-time read from
// disk are module state, so a test that seeds its own cache file has to clear them first.
export function resetReceiptBoardCache() {
  receiptBoardCache = null;
  receiptBoardCacheLoaded = false;
  receiptBoardLoadPromise = null;
  receiptBoardLoadGeneration = -1;
  receiptBoardGeneration += 1;
  receiptSyncQueue = Promise.resolve();
  contactIdsByDocumentPrefix.clear();
}

export function invalidateReceiptBoard() {
  receiptBoardGeneration += 1;
  refreshReceiptBoardCache().catch((error) => {
    console.error('Could not refresh receipt board cache:', error.message);
  });
}

async function ensureReceiptBoardCacheLoaded() {
  if (receiptBoardCacheLoaded) return;
  receiptBoardCacheLoaded = true;
  const cachePath = resolve(env.RECEIPT_BOARD_CACHE_PATH);
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf8'));
    if (parsed?.board && Number.isFinite(parsed.updatedAt)) receiptBoardCache = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    if (error instanceof SyntaxError) console.error(`Ignoring invalid receipt board cache at ${cachePath}:`, error.message);
  }
}

function persistReceiptBoardCache() {
  const cachePath = resolve(env.RECEIPT_BOARD_CACHE_PATH);
  const snapshot = JSON.stringify(receiptBoardCache);
  receiptBoardCacheWriteQueue = receiptBoardCacheWriteQueue.then(async () => {
    await mkdir(dirname(cachePath), { recursive: true });
    const temporaryPath = `${cachePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, snapshot, 'utf8');
    await rename(temporaryPath, cachePath);
  });
  return receiptBoardCacheWriteQueue;
}

async function loadReceipts() {
  const [stages, voucherResponse] = await Promise.all([getStages(), listBitrixVouchers()]);

  if (!voucherResponse.items.length) {
    return {
      unmatched: [],
      matched: [],
      log: await getActivityLog()
    };
  }

  const [scheduleResponse, deals] = await Promise.all([listBitrixSchedules(), listRecentDeals()]);
  const rawSchedules = scheduleResponse.items.map(mapSchedule);
  const dealById = new Map(deals.map((deal) => [deal.id, deal]));
  const schedules = rawSchedules.map((schedule) => ({
    ...schedule,
    deal: dealById.get(schedule.dealId) ?? null
  }));
  const receipts = voucherResponse.items.map((item) => mapVoucherData(item, stages));
  const contactDealsByDocument = await loadContactDealsByDocument(receipts, deals);
  const suggestionContext = { deals, contactDealsByDocument, receipts, stages };
  const vouchers = receipts.map((receipt) => ({
    ...receipt,
    suggestions: receipt.status === 'unmatched' ? getSuggestions(receipt, schedules, suggestionContext) : []
  }));

  const trashedReceiptIds = await getTrashedReceiptIds();

  return {
    unmatched: vouchers.filter((receipt) => receipt.status === 'unmatched' && !trashedReceiptIds.has(String(receipt.id))),
    matched: vouchers.filter((receipt) => receipt.status === 'matched' && !trashedReceiptIds.has(String(receipt.id))),
    trashed: vouchers.filter((receipt) => trashedReceiptIds.has(String(receipt.id))),
    log: await getActivityLog()
  };
}

export async function importBankTransaction(input) {
  const transaction = normalizeBankTransaction(input);
  const transactionId = transaction.transactionId;

  if (receiptImportLocks.has(transactionId)) {
    return receiptImportLocks.get(transactionId).then((result) => ({ ...result, created: false }));
  }

  // The bank sync walks every transaction it has ever seen, so this runs hundreds of times an
  // hour and almost always finds the receipt already there. It used to invalidate the whole
  // board each time regardless, which is what kept a two-minute rebuild running every few
  // minutes around the clock. Now only a receipt that was really created causes any work, and
  // that work is a single read of the new receipt by id.
  const importPromise = createBankReceiptOnce(transaction)
    .then((result) => {
      const receiptId = String(result?.receipt?.id ?? result?.receipt?.ID ?? '');

      if (result?.created && receiptId) {
        syncReceiptBoard({ receiptIds: [receiptId], reason: 'bank import' }).catch((error) => {
          console.error('Could not place the imported receipt on the board:', error.message);
        });
      } else if (result?.created) {
        // Created but Bitrix did not say which id: only a rebuild can find it.
        invalidateReceiptBoard();
      }

      return result;
    })
    .finally(() => {
      receiptImportLocks.delete(transactionId);
    });
  receiptImportLocks.set(transactionId, importPromise);
  return importPromise;
}

export async function createBankReceipt(input) {
  return (await importBankTransaction(input)).receipt;
}

async function createBankReceiptOnce(transaction) {
  const [stages, existingReceipt] = await Promise.all([
    getStages(),
    findVoucherByExternalId(transaction.transactionId)
  ]);

  if (existingReceipt) {
    return { receipt: existingReceipt, created: false };
  }

  const fields = mapBankTransactionToVoucherFields(transaction, stages);
  const result = await callBitrixMethod('crm.item.add', {
    entityTypeId: TYPES.voucher.entityTypeId,
    fields
  });

  const receipt = result.item ?? result;
  await addActivity({
    receiptId: result.item?.id ?? result.item?.ID ?? 'new',
    bankTransactionId: transaction.transactionId,
    receiptTitle: receipt.title ?? null,
    amount: transaction.amount,
    currency: transaction.currency,
    action: 'Bank receipt was created in Bitrix',
    actor: 'System'
  });

  return { receipt, created: true };
}

export async function searchDeals({ name = '', building = '', apartment = '' }) {
  const deals = await listRecentDeals();
  return filterDealsForSearch(deals, { name, building, apartment });
}

export function filterDealsForSearch(deals, { name = '', building = '', apartment = '' }) {
  const queryName = normalize(name);
  const queryNameAlt = normalize(transliterateLatinToArmenian(name));
  const queryBuilding = String(building ?? '').trim();
  const queryApartment = normalizeNumber(apartment);

  return deals.filter((deal) => {
    const haystack = deal.searchableText;
    const byName = !queryName || includesText(haystack, queryName) || (queryNameAlt && includesText(haystack, queryNameAlt));
    const byBuilding = !queryBuilding || deal.projectId === queryBuilding;
    const byApartment = !queryApartment || dealApartmentMatchesSearch(queryApartment, deal);

    return byName && byBuilding && byApartment;
  });
}

export async function listBuildingOptions() {
  return BUILDING_OPTIONS;
}

export async function confirmMatch(payload) {
  const receiptId = String(payload.receiptId);
  const dealId = String(payload.dealId);
  const alreadyProcessing = matchLocks.has(receiptId);

  try {
    const result = await runWithKeyedLock(matchLocks, receiptId, () =>
      runWithKeyedLock(dealLocks, dealId, () => confirmMatchOnce(payload))
    );

    await updateCachedBoardReceipt(receiptId, { status: 'matched', matchedDealId: dealId, suggestions: [] });
    return alreadyProcessing ? { ...result, alreadyProcessing: true } : result;
  } catch (error) {
    // A failed match can still have written to Bitrix before rolling back, so the cached board
    // is no longer trustworthy; only a full reload can say what the real state is.
    invalidateReceiptBoard();
    throw error;
  }
}

export async function undoMatch(payload) {
  const receiptId = String(payload.receiptId);

  try {
    const result = await runWithKeyedLock(matchLocks, receiptId, () => undoMatchOnce(payload));

    await updateCachedBoardReceipt(receiptId, { status: 'unmatched', matchedDealId: null, suggestions: [] });
    return result;
  } catch (error) {
    invalidateReceiptBoard();
    throw error;
  }
}

async function confirmMatchOnce({ receiptId, dealId, scheduleIds = [] }) {
  invalidateRecentDealsCache();
  const [stages, deal, receipt] = await Promise.all([
    getStages(),
    getBitrixDeal(dealId),
    getBitrixVoucher(receiptId)
  ]);

  if (isAlreadyMatchedWithDeal(receipt, dealId, stages)) {
    const receiptIds = appendUniqueId(deal?.[DEAL_FIELDS.receiptIds], receiptId);
    await syncVoucherAmountFields(receiptId, receipt);
    const recalculation = await recalculateDealSchedules(deal, stages, receiptIds);

    return {
      id: receiptId,
      matchedDealId: dealId,
      matchedScheduleIds: scheduleIds,
      recalculation,
      alreadyMatched: true
    };
  }

  assertMatchEntities({ deal, receipt, dealId, stages });
  validateSelectedSchedules(scheduleIds, deal);

  const contactId = getDealContactId(deal);
  const previousReceiptIds = deal?.[DEAL_FIELDS.receiptIds] ?? [];
  const receiptIds = appendUniqueId(deal?.[DEAL_FIELDS.receiptIds], receiptId);
  let dealUpdated = false;
  let receiptUpdated = false;

  try {
    await updateDealReceiptIds(dealId, receiptIds);
    dealUpdated = true;

    await callBitrixMethod('crm.item.update', {
      entityTypeId: TYPES.voucher.entityTypeId,
      id: receiptId,
      fields: {
        stageId: stages.voucher.matched,
        parentId2: dealId,
        ...getVoucherAmountFields(receipt),
        ...(contactId ? { contactId } : {})
      }
    });
    receiptUpdated = true;

    const recalculation = await recalculateDealSchedules(deal, stages, receiptIds);
    const activity = await addActivity({
      ...describeReceiptForActivity(receipt),
      receiptId,
      action: `Receipt matched with Deal #${dealId}; schedules recalculated`,
      actor: 'Manager'
    });
    invalidateRecentDealsCache();

    return {
      id: receiptId,
      matchedDealId: dealId,
      matchedScheduleIds: scheduleIds,
      recalculation,
      activity
    };
  } catch (error) {
    const rollbackErrors = [];

    if (receiptUpdated) {
      await callBitrixMethod('crm.item.update', {
        entityTypeId: TYPES.voucher.entityTypeId,
        id: receiptId,
        fields: {
          stageId: receipt.stageId,
          parentId2: receipt.parentId2 ?? null,
          contactId: receipt.contactId ?? null
        }
      }).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (dealUpdated) {
      await updateDealReceiptIds(dealId, previousReceiptIds)
        .catch((rollbackError) => rollbackErrors.push(rollbackError));
    }

    if (rollbackErrors.length) {
      error.message = `${error.message}; rollback failed: ${rollbackErrors.map((item) => item.message).join('; ')}`;
    }
    throw error;
  }
}

async function undoMatchOnce({ receiptId, dealId: requestedDealId }) {
  invalidateRecentDealsCache();
  const [stages, receipt] = await Promise.all([
    getStages(),
    getBitrixVoucher(receiptId)
  ]);
  const linkedDealId = String(receipt?.parentId2 ?? '');
  const dealId = linkedDealId || String(requestedDealId ?? '');

  assertUndoEntities({ receipt, receiptId, dealId, linkedDealId, stages });

  return runWithKeyedLock(dealLocks, dealId, () => undoMatchForDeal({
    receipt,
    receiptId,
    dealId,
    linkedDealId,
    stages
  }));
}

async function undoMatchForDeal({ receipt, receiptId, dealId, linkedDealId, stages }) {
  const deal = await getBitrixDeal(dealId);
  const previousReceiptIds = deal?.[DEAL_FIELDS.receiptIds] ?? [];
  const receiptIds = removeId(previousReceiptIds, receiptId);
  const shouldUpdateReceipt = linkedDealId || receipt.stageId !== stages.voucher.new || receipt.contactId;
  const previousReceiptFields = {
    stageId: receipt.stageId,
    parentId2: receipt.parentId2 ?? null,
    contactId: receipt.contactId ?? null
  };
  let dealUpdated = false;
  let receiptUpdated = false;

  try {
    await updateDealReceiptIds(dealId, receiptIds);
    dealUpdated = true;

    if (shouldUpdateReceipt) {
      await callBitrixMethod('crm.item.update', {
        entityTypeId: TYPES.voucher.entityTypeId,
        id: receiptId,
        fields: {
          stageId: stages.voucher.new,
          parentId2: null,
          contactId: null
        }
      });
      receiptUpdated = true;
    }

    const recalculation = await recalculateDealSchedules(deal, stages, receiptIds, {
      excludeReceiptIds: [receiptId]
    });

    const activity = linkedDealId
      ? await addActivity({
        ...describeReceiptForActivity(receipt),
        receiptId,
        action: `Receipt unlinked from Deal #${dealId}; schedules recalculated`,
        actor: 'Manager'
      })
      : null;

    return {
      id: receiptId,
      unmatchedDealId: dealId,
      recalculation,
      activity
    };
  } catch (error) {
    const rollbackErrors = [];

    if (receiptUpdated) {
      await callBitrixMethod('crm.item.update', {
        entityTypeId: TYPES.voucher.entityTypeId,
        id: receiptId,
        fields: previousReceiptFields
      }).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (dealUpdated) {
      await updateDealReceiptIds(dealId, previousReceiptIds)
        .catch((rollbackError) => rollbackErrors.push(rollbackError));
    }

    if (rollbackErrors.length) {
      error.message = `${error.message}; undo rollback failed: ${rollbackErrors.map((item) => item.message).join('; ')}`;
    }
    throw error;
  }
}

// The client adds the new history row from this entry instead of waiting for the next full
// board load, so the entry has to carry everything the history list renders on its own.
function describeReceiptForActivity(receipt) {
  const amount = Number(receipt?.[TYPES.voucher.fields.amount] ?? receipt?.opportunity ?? 0);

  return {
    bankTransactionId: receipt?.[TYPES.voucher.fields.bankTransactionId] || receipt?.xmlId || null,
    receiptTitle: receipt?.title ?? null,
    payerName: receipt?.[TYPES.voucher.fields.payerName] ?? null,
    amount: Number.isFinite(amount) && amount !== 0 ? amount : null,
    currency: receipt?.currencyId || 'AMD'
  };
}

function isAlreadyMatchedWithDeal(receipt, dealId, stages) {
  return String(receipt?.parentId2 ?? '') === String(dealId) && receipt?.stageId === stages.voucher.matched;
}

async function listBitrixVouchers() {
  const items = await listBitrixMethod('crm.item.list', {
    entityTypeId: TYPES.voucher.entityTypeId,
    order: { id: 'DESC' },
    filter: {
      categoryId: TYPES.voucher.categoryId
    },
    select: VOUCHER_SELECT
  });
  return { items };
}

async function listBitrixSchedules() {
  const items = await listBitrixMethod('crm.item.list', {
    entityTypeId: TYPES.schedule.entityTypeId,
    order: { id: 'ASC' },
    filter: {
      categoryId: TYPES.schedule.categoryId
    },
    select: [
      'id',
      'title',
      'stageId',
      'parentId2',
      'opportunity',
      'currencyId',
      TYPES.schedule.fields.firstName,
      TYPES.schedule.fields.lastName,
      TYPES.schedule.fields.middleName,
      TYPES.schedule.fields.paymentDate,
      TYPES.schedule.fields.partialPaid,
      TYPES.schedule.fields.remaining
    ]
  });
  return { items };
}

function mapVoucherData(item, stages) {
  const amount = Number(item[TYPES.voucher.fields.amount] ?? item.opportunity ?? 0);
  const purpose = item[TYPES.voucher.fields.purpose] ?? '';
  return {
    id: String(item.id),
    bankTransactionId: item[TYPES.voucher.fields.bankTransactionId] || item.xmlId || String(item.id),
    bitrixTitle: item.title,
    amount,
    currency: item.currencyId || 'AMD',
    currencyEnum: Number(item[TYPES.voucher.fields.currencyEnum] ?? 0) || null,
    payerName: item[TYPES.voucher.fields.payerName] ?? '',
    payerDocument: item[TYPES.voucher.fields.payerDocument] ?? '',
    purpose,
    receivedAt: item.createdTime,
    paymentDate: item[TYPES.voucher.fields.paymentDate],
    status: item.stageId === stages.voucher.new ? 'unmatched' : 'matched',
    matchedDealId: item.parentId2 ? String(item.parentId2) : null,
    parsed: env.SMART_MATCH_V2 ? parsePurposeV2(purpose) : parsePurpose(purpose)
  };
}

function mapSchedule(item) {
  const firstName = item[TYPES.schedule.fields.firstName] ?? '';
  const lastName = item[TYPES.schedule.fields.lastName] ?? '';
  const middleName = item[TYPES.schedule.fields.middleName] ?? '';

  return {
    id: String(item.id),
    title: item.title,
    dealId: item.parentId2 ? String(item.parentId2) : null,
    buyerName: [firstName, lastName, middleName].filter(Boolean).join(' '),
    amount: Number(item.opportunity ?? 0),
    currency: item.currencyId || 'AMD',
    paymentDate: item[TYPES.schedule.fields.paymentDate],
    status: item.stageId,
    remaining: Number(item[TYPES.schedule.fields.remaining] ?? item.opportunity ?? 0),
    partialPaid: Number(item[TYPES.schedule.fields.partialPaid] ?? 0),
    remainingRaw: item[TYPES.schedule.fields.remaining] ?? '',
    partialPaidRaw: item[TYPES.schedule.fields.partialPaid] ?? ''
  };
}

function getSuggestions(receipt, schedules, context) {
  const documentPrefix = getDocumentPrefix(receipt.payerDocument);
  const contactDeals = (context.contactDealsByDocument.get(documentPrefix) ?? [])
    .filter((deal) => !getProjectDealEvidence(receipt, deal).conflict);
  const contactDealIds = new Set(contactDeals.map((deal) => deal.id));

  const contactSuggestions = contactDeals.map((deal) => {
      const dealSchedules = getDealSchedules(deal, schedules, context.stages);
      const allDealSchedules = getAllDealSchedules(deal, schedules);

      return {
        deal: buildSuggestionDeal(deal, allDealSchedules, context.receipts, context.stages),
        scheduleIds: dealSchedules.map((schedule) => schedule.id),
        score: CONTACT_MATCH_SCORE + getDirectDealScore(receipt, deal) - 70,
        label: 'Contact Match',
        reason: 'Payer document matched a Bitrix contact'
      };
  });
  const directDealSuggestions = context.deals
    .filter((deal) => !contactDealIds.has(deal.id))
    .filter((deal) => dealMatchesReceipt(receipt, deal, { allowNameFallback: false }))
    .map((deal) => {
      const dealSchedules = getDealSchedules(deal, schedules, context.stages);
      const allDealSchedules = getAllDealSchedules(deal, schedules);

      return {
        deal: buildSuggestionDeal(deal, allDealSchedules, context.receipts, context.stages),
        scheduleIds: dealSchedules.map((schedule) => schedule.id),
        score: getDirectDealScore(receipt, deal),
        label: 'Deal Match',
        reason: deal.title
      };
    });

  const primarySuggestions = [...contactSuggestions, ...directDealSuggestions]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (primarySuggestions.length) return primarySuggestions;

  return context.deals
    .map((deal) => {
      const dealSchedules = getDealSchedules(deal, schedules, context.stages);
      const allDealSchedules = getAllDealSchedules(deal, schedules);
      const evidence = getLooseSuggestionEvidence(receipt, deal, dealSchedules);

      if (!evidence) return null;

      return {
        deal: buildSuggestionDeal(deal, allDealSchedules, context.receipts, context.stages),
        scheduleIds: dealSchedules.map((schedule) => schedule.id),
        score: evidence.score,
        label: evidence.fullNameMatch ? 'Name Match' : 'Partial Match',
        reason: evidence.reasons.join(', ')
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

export function getLooseSuggestionEvidence(receipt, deal, dealSchedules = []) {
  const parsed = receipt.parsed ?? {};
  const projectEvidence = getProjectDealEvidence(receipt, deal);

  if (hasApartmentConflict(parsed.apartment, deal) || projectEvidence.conflict) {
    return null;
  }

  const numberTokens = getNumberTokens(deal.searchableText);
  const reasons = [];
  let score = 35;
  const add = (matched, reason, points) => {
    if (!matched) return;
    reasons.push(reason);
    score += points;
  };
  const fullNameMatch = isNameOnlyFallbackMatch(receipt, deal);
  const payerMatch = Boolean(receipt.payerName && namesOverlap(receipt.payerName, deal.buyerName));
  const amountMatch = Boolean(
    Number(receipt.amount) > 0 &&
    dealSchedules.some((schedule) =>
      [schedule.remaining, schedule.amount].some((amount) => Number(amount) === Number(receipt.amount))
    )
  );

  add(fullNameMatch, 'Full payer name matched', 25);
  add(!fullNameMatch && payerMatch, 'Payer name partially matched', 12);
  add(projectEvidence.matched, 'Project matched', 12);
  add(parsed.building && numberTokens.has(normalizeNumber(parsed.building)), 'Building matched', 10);
  add(apartmentMatchesDeal(parsed.apartment, deal), 'Apartment matched', 14);
  add(
    parsed.preliminaryNumber && numberTokens.has(normalizeNumber(parsed.preliminaryNumber)),
    'Preliminary number matched',
    12
  );
  add(parsed.area && numberTokens.has(normalizeNumber(parsed.area)), 'Area matched', 7);
  add(parsed.contractDate && includesText(deal.searchableText, parsed.contractDate), 'Contract date matched', 7);
  add(amountMatch, 'Payment amount matched a schedule', 10);

  return reasons.length ? { score, reasons, fullNameMatch } : null;
}

function buildSuggestionDeal(deal, schedules = [], receipts = [], stages = getDefaultStages()) {
  const linkedReceiptIds = new Set(deal.receiptIds ?? []);
  const linkedReceipts = receipts
    .filter((receipt) => receipt.matchedDealId === deal.id || linkedReceiptIds.has(receipt.id))
    .filter((receipt) => receipt.currency === 'AMD' || receipt.currencyEnum === CURRENCY_ENUM.AMD)
    .sort((left, right) => {
      const leftDate = getReceiptSortTime(left);
      const rightDate = getReceiptSortTime(right);
      return leftDate - rightDate || Number(left.id) - Number(right.id);
    });

  return {
    id: deal.id,
    bitrixUrl: deal.bitrixUrl,
    title: deal.title,
    buyerName: deal.buyerName,
    address: deal.address,
    amount: deal.amount,
    currency: deal.currency,
    contactId: deal.contactId,
    projectId: deal.projectId,
    projectName: BUILDING_OPTIONS.find((option) => option.value === deal.projectId)?.label ?? '',
    buildingSectionId: deal.buildingSectionId,
    apartmentNumber: deal.apartmentNumber,
    floor: deal.floor,
    area: deal.area,
    scheduleIds: deal.scheduleIds,
    schedules: schedules.slice(0, 100),
    receipts: linkedReceipts.map((receipt) => ({
      id: receipt.id,
      title: receipt.bankTransactionId || receipt.bitrixTitle || `#${receipt.id}`,
      amount: receipt.amount,
      currency: receipt.currency,
      paymentDate: receipt.paymentDate || receipt.receivedAt
    })),
    paymentTimeline: buildPaymentTimeline(linkedReceipts, schedules, stages)
  };
}

function getAllDealSchedules(deal, schedules) {
  const linkedScheduleIds = new Set(deal.scheduleIds ?? []);
  return schedules
    .filter((schedule) => linkedScheduleIds.has(schedule.id))
    .sort((left, right) => Number(left.id) - Number(right.id));
}

function buildPaymentTimeline(receipts, schedules, stages) {
  const scheduleStates = schedules.map((schedule) => ({
    id: schedule.id,
    amount: Number(schedule.amount ?? 0),
    currency: schedule.currency,
    paymentDate: schedule.paymentDate,
    status: schedule.status,
    paid: 0
  }));

  return receipts.map((receipt) => {
    let available = Number(receipt.amount ?? 0);
    const allocations = [];

    for (const schedule of scheduleStates) {
      if (available <= 0) break;

      const remainingBefore = Math.max(schedule.amount - schedule.paid, 0);
      if (remainingBefore <= 0) continue;

      const paid = Math.min(available, remainingBefore);
      schedule.paid += paid;
      available -= paid;

      allocations.push({
        scheduleId: schedule.id,
        scheduleAmount: schedule.amount,
        currency: schedule.currency,
        paymentDate: schedule.paymentDate,
        paid,
        paidTotal: schedule.paid,
        remainingBefore,
        remainingAfter: Math.max(schedule.amount - schedule.paid, 0),
        closed: schedule.paid >= schedule.amount,
        statusAfter: schedule.paid >= schedule.amount ? stages.schedule.paid : stages.schedule.partial
      });
    }

    return {
      receiptId: receipt.id,
      title: receipt.bankTransactionId || receipt.bitrixTitle || `#${receipt.id}`,
      amount: receipt.amount,
      currency: receipt.currency,
      paymentDate: receipt.paymentDate || receipt.receivedAt,
      allocations,
      excess: Math.max(available, 0)
    };
  });
}

function getReceiptSortTime(receipt) {
  const date = new Date(receipt.paymentDate || receipt.receivedAt || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getDealSchedules(deal, schedules, stages) {
  return getAllDealSchedules(deal, schedules)
    .filter((schedule) => isPayableSchedule(schedule, stages))
    .sort((left, right) => Number(left.id) - Number(right.id));
}

async function loadContactDealsByDocument(receipts, deals) {
  const documentPrefixes = [...new Set(receipts.map((receipt) => getDocumentPrefix(receipt.payerDocument)).filter(Boolean))];
  const result = new Map();

  if (!documentPrefixes.length) return result;

  const contactIdsByPrefix = await findContactIdsByDocumentPrefix(documentPrefixes);

  if (!contactIdsByPrefix.size) return result;

  const dealsByContactId = new Map();

  for (const deal of deals) {
    if (!deal.contactId) continue;
    dealsByContactId.set(deal.contactId, [...(dealsByContactId.get(deal.contactId) ?? []), deal]);
  }

  for (const [documentPrefix, contactIds] of contactIdsByPrefix) {
    const matchedDeals = uniqueById(contactIds.flatMap((contactId) => dealsByContactId.get(contactId) ?? []));

    if (matchedDeals.length) {
      result.set(documentPrefix, matchedDeals);
    }
  }

  return result;
}

async function findContactIdsByDocumentPrefix(documentPrefixes) {
  const contactIdsByPrefix = new Map();
  const exactMatches = await listBitrixMethod('crm.contact.list', {
    filter: { [`@${CONTACT_FIELDS.documentNumber}`]: documentPrefixes },
    select: ['ID', CONTACT_FIELDS.documentNumber]
  });
  collectContactIdsByPrefix(contactIdsByPrefix, exactMatches, documentPrefixes);

  // Contacts often store the document with a suffix (series, issue date), so the exact filter above
  // misses them: look the remaining prefixes up one by one with a substring filter.
  //
  // One request each, run in sequence behind a queue two requests wide: these lookups were
  // most of the two minutes a rebuild took. The answers are remembered, so only payers seen
  // for the first time cost anything, and a second rebuild is a fraction of the first.
  const unresolved = [];

  for (const documentPrefix of documentPrefixes) {
    if (contactIdsByPrefix.has(documentPrefix)) continue;

    const remembered = readCachedContactIds(documentPrefix);
    if (remembered) {
      if (remembered.length) contactIdsByPrefix.set(documentPrefix, remembered);
      continue;
    }

    unresolved.push(documentPrefix);
  }

  const lookups = unresolved.slice(0, MAX_CONTACT_LOOKUPS);

  if (unresolved.length > lookups.length) {
    console.warn(
      `Looking up ${lookups.length} of ${unresolved.length} unknown payer documents this time; ` +
      'the rest are covered by the next rebuild.'
    );
  }

  for (const documentPrefix of lookups) {
    const partialMatches = await listBitrixMethod('crm.contact.list', {
      filter: { [`%${CONTACT_FIELDS.documentNumber}`]: documentPrefix },
      select: ['ID', CONTACT_FIELDS.documentNumber]
    });
    const resolved = new Map();
    collectContactIdsByPrefix(resolved, partialMatches, [documentPrefix]);

    const contactIds = resolved.get(documentPrefix) ?? [];
    // A miss is worth remembering too: without it every rebuild re-asks about the same payer.
    contactIdsByDocumentPrefix.set(documentPrefix, { contactIds, expiresAt: Date.now() + env.CONTACT_LOOKUP_CACHE_TTL_MS });
    if (contactIds.length) contactIdsByPrefix.set(documentPrefix, contactIds);
  }

  return contactIdsByPrefix;
}

function readCachedContactIds(documentPrefix) {
  if (!env.CONTACT_LOOKUP_CACHE_TTL_MS) return null;

  const entry = contactIdsByDocumentPrefix.get(documentPrefix);

  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    contactIdsByDocumentPrefix.delete(documentPrefix);
    return null;
  }

  return entry.contactIds;
}

function collectContactIdsByPrefix(target, contacts, documentPrefixes) {
  for (const contact of contacts) {
    const contactPrefix = getDocumentPrefix(contact[CONTACT_FIELDS.documentNumber]);

    if (!contactPrefix) continue;

    // Either side can be the shorter one when a document number is under nine characters.
    const documentPrefix = documentPrefixes.find(
      (prefix) => contactPrefix.startsWith(prefix) || prefix.startsWith(contactPrefix)
    );

    if (!documentPrefix) continue;

    const contactIds = target.get(documentPrefix) ?? [];
    const contactId = String(contact.ID);

    if (!contactIds.includes(contactId)) {
      target.set(documentPrefix, [...contactIds, contactId]);
    }
  }
}

function getDocumentPrefix(value) {
  const normalized = String(flattenValue(value)).toUpperCase().replace(/\s+/gu, '');
  const prefix = normalized.slice(0, DOCUMENT_PREFIX_LENGTH);

  return prefix.length >= MIN_DOCUMENT_PREFIX_LENGTH ? prefix : '';
}

function uniqueById(items) {
  const seen = new Set();

  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

async function listRecentDeals() {
  const now = Date.now();
  if (recentDealsCache && recentDealsCache.expiresAt > now) {
    return recentDealsCache.deals;
  }
  if (recentDealsPromise) return recentDealsPromise;

  const generation = recentDealsGeneration;
  const currentPromise = listBitrixDealsById({
    filter: { CATEGORY_ID: 5 },
    select: DEAL_SELECT,
    order: { ID: 'DESC' }
  })
    .then((response) => {
      const deals = response.filter(isEligibleDealForMatching).map(mapDeal);
      if (generation === recentDealsGeneration) {
        recentDealsCache = {
          deals,
          expiresAt: Date.now() + RECENT_DEALS_CACHE_TTL_MS,
          staleUntil: Date.now() + RECENT_DEALS_STALE_TTL_MS
        };
      }
      return deals;
    })
    .catch((error) => {
      if (recentDealsCache?.staleUntil > Date.now()) {
        console.warn(`Using cached Bitrix deals after refresh failed: ${error.message}`);
        return recentDealsCache.deals;
      }
      throw error;
    })
    .finally(() => {
      if (recentDealsPromise === currentPromise) recentDealsPromise = null;
    });

  recentDealsPromise = currentPromise;
  return currentPromise;
}

function invalidateRecentDealsCache() {
  recentDealsGeneration += 1;
  recentDealsPromise = null;
  recentDealsCache = null;
}

export function isEligibleDealForMatching(deal) {
  const stageId = String(deal?.STAGE_ID ?? '').toUpperCase();
  const stageSemanticId = String(deal?.STAGE_SEMANTIC_ID ?? '').toUpperCase();

  // Bitrix marks rejected/lost deals with failure semantics. They must never become
  // payment suggestions, even when apartment, name, or contact data matches.
  return stageSemanticId !== 'F' && stageId !== 'C5:LOSE';
}

function mapDeal(deal) {
  const title = deal.TITLE ?? '';
  const buyerName = deal[DEAL_FIELDS.buyerName] || title;
  const searchableText = normalize(
    Object.entries(deal)
      .filter(([key]) => key === 'TITLE' || key.startsWith('UF_'))
      .map(([, value]) => flattenValue(value))
      .join(' ')
  );

  return {
    id: String(deal.ID),
    bitrixUrl: getBitrixDealUrl(deal.ID),
    title,
    stageId: String(deal.STAGE_ID ?? ''),
    stageSemanticId: String(deal.STAGE_SEMANTIC_ID ?? ''),
    buyerName,
    address: title,
    amount: Number(deal.OPPORTUNITY ?? 0),
    currency: deal.CURRENCY_ID || 'AMD',
    contactId: String(deal[DEAL_FIELDS.contactId] ?? ''),
    receiptIds: normalizeIdList(deal[DEAL_FIELDS.receiptIds]),
    scheduleIds: normalizeIdList(deal[DEAL_FIELDS.scheduleIds]),
    projectId: String(deal[DEAL_FIELDS.project] ?? ''),
    buildingSectionId: String(deal[DEAL_FIELDS.buildingSection] ?? ''),
    apartmentNumber: getDealApartmentNumber(deal),
    floor: String(flattenValue(deal[DEAL_FIELDS.floor])).trim(),
    area: String(flattenValue(deal[DEAL_FIELDS.area])).trim(),
    searchableText
  };
}

export function getDealApartmentNumber(deal) {
  return String(
    flattenValue(
      deal?.[DEAL_FIELDS.apartmentChecked] ||
      deal?.[DEAL_FIELDS.apartmentChecked.toLowerCase()] ||
      deal?.ufCrm1776254518 ||
      deal?.[DEAL_FIELDS.apartmentNumber] ||
      deal?.[DEAL_FIELDS.apartmentNumber.toLowerCase()] ||
      deal?.ufCrm65be4878488d4
    )
  ).trim();
}

function getBitrixDealUrl(dealId) {
  if (!env.BITRIX_WEBHOOK_URL || !dealId) {
    return '';
  }

  const { origin } = new URL(env.BITRIX_WEBHOOK_URL);
  return `${origin}/crm/deal/details/${dealId}/`;
}

function mapBankTransactionToVoucherFields(transaction, stages) {
  const amount = Number(transaction.amount ?? transaction.sum ?? 0);
  const currency = normalizeCurrency(transaction.currency);

  return {
    title: transaction.title ?? `Bank receipt ${transaction.transactionId ?? ''}`.trim(),
    xmlId: transaction.transactionId ? String(transaction.transactionId) : undefined,
    [TYPES.voucher.fields.bankTransactionId]: transaction.transactionId ? String(transaction.transactionId) : '',
    categoryId: TYPES.voucher.categoryId,
    stageId: stages.voucher.new,
    opportunity: amount,
    currencyId: currency,
    [TYPES.voucher.fields.payerName]: transaction.payerName ?? '',
    [TYPES.voucher.fields.beneficiaryName]: transaction.beneficiaryName ?? '',
    [TYPES.voucher.fields.amount]: amount,
    [TYPES.voucher.fields.paymentDate]: transaction.paymentDate ?? new Date().toISOString(),
    [TYPES.voucher.fields.currencyEnum]: transaction.currencyEnum ?? CURRENCY_ENUM[currency] ?? undefined,
    [TYPES.voucher.fields.purpose]: transaction.purpose ?? '',
    [TYPES.voucher.fields.debit]: transaction.debit ?? '',
    [TYPES.voucher.fields.credit]: transaction.credit ?? '',
    [TYPES.voucher.fields.payerDocument]: transaction.payerDocument ?? '',
    [TYPES.voucher.fields.payerAddress]: transaction.payerAddress ?? '',
    [TYPES.voucher.fields.amountWords]: transaction.amountWords ?? ''
  };
}

async function getBitrixDeal(dealId) {
  return callBitrixMethod('crm.deal.get', { id: dealId });
}

async function getBitrixVoucher(receiptId) {
  const response = await callBitrixMethod('crm.item.get', {
    entityTypeId: TYPES.voucher.entityTypeId,
    id: receiptId
  });
  return response.item ?? response;
}

function assertMatchEntities({ deal, receipt, dealId, stages }) {
  if (Number(deal?.[DEAL_FIELDS.categoryId]) !== 5) {
    throw requestError('Selected deal is outside the allowed Bitrix category');
  }
  if (Number(receipt?.categoryId) !== TYPES.voucher.categoryId) {
    throw requestError('Selected receipt is outside the bank receipt Smart Process');
  }
  if (String(receipt.parentId2 ?? '') === String(dealId) && receipt.stageId !== stages.voucher.new) {
    throw requestError('Receipt is already matched with this deal', 409);
  }
  if (receipt.stageId !== stages.voucher.new) {
    throw requestError('Only unmatched bank receipts can be confirmed', 409);
  }
}

function assertUndoEntities({ receipt, receiptId, dealId, linkedDealId, stages }) {
  if (Number(receipt?.categoryId) !== TYPES.voucher.categoryId) {
    throw requestError('Selected receipt is outside the bank receipt Smart Process');
  }
  if (!dealId) {
    throw requestError(`Receipt #${receiptId} is not linked to a deal`, 409);
  }
  if (linkedDealId && receipt.stageId !== stages.voucher.matched) {
    throw requestError('Only matched bank receipts can be moved back', 409);
  }
}

function validateSelectedSchedules(scheduleIds, deal) {
  const uniqueIds = [...new Set(scheduleIds.map(String))];
  if (!uniqueIds.length) return;
  const linkedIds = new Set(normalizeIdList(deal?.[DEAL_FIELDS.scheduleIds]));

  for (const scheduleId of uniqueIds) {
    if (!linkedIds.has(scheduleId)) {
      throw requestError(`Payment schedule #${scheduleId} does not belong to the selected deal`);
    }
  }
}

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getDealContactId(deal) {
  const contactId = deal?.CONTACT_ID ?? deal?.contactId;

  if (contactId) {
    return String(contactId);
  }

  const contactIds = deal?.CONTACT_IDS ?? deal?.contactIds;

  return Array.isArray(contactIds) && contactIds.length ? String(contactIds[0]) : null;
}

function appendUniqueId(value, id) {
  const normalizedId = String(id);
  const next = normalizeIdList(value);

  if (!next.includes(normalizedId)) {
    next.push(normalizedId);
  }

  return next;
}

function removeId(value, id) {
  const normalizedId = String(id);
  return normalizeIdList(value).filter((item) => item !== normalizedId);
}

export function serializeBitrixMultipleField(value) {
  const ids = normalizeIdList(value);

  return ids.length ? ids : false;
}

function normalizeIdList(value) {
  if (value === false || value === null || value === undefined || value === '') {
    return [];
  }

  const items = Array.isArray(value) ? value : String(value ?? '').split(',');

  return items
    .map((item) => String(flattenValue(item)).trim())
    .filter((item) => /^\d+$/u.test(item));
}

async function recalculateDealSchedules(deal, stages, linkedReceiptIds = [], options = {}) {
  const dealId = String(deal?.ID ?? deal?.id ?? '');
  const [vouchers, schedules] = await Promise.all([
    listDealVouchers(dealId, linkedReceiptIds, options),
    listDealSchedulesForRecalculation(deal)
  ]);
  const amdTotal = sumAmdVouchers(vouchers);
  const dealTotal = Number(deal?.OPPORTUNITY ?? deal?.opportunity ?? 0);
  const scheduleTotal = schedules.length
    ? sumScheduleAmounts(schedules)
    : dealTotal;
  const schedulePaymentTotal = getSchedulePaymentTotal(schedules, amdTotal, dealTotal);
  const updates = planScheduleUpdates(schedules, schedulePaymentTotal, stages);
  const completed = [];
  try {
    const results = await Promise.allSettled(
      updates.map((update) => updateSchedule(update.schedule.id, update.fields))
    );
    for (let index = 0; index < results.length; index += 1) {
      if (results[index].status === 'fulfilled') {
        completed.push(updates[index].schedule);
      }
    }
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) {
      throw failed.reason;
    }

    await updateDealScheduleSummary(dealId, schedules, amdTotal, linkedReceiptIds, dealTotal);
  } catch (error) {
    const rollbackErrors = [];
    for (const schedule of completed.reverse()) {
      await updateSchedule(schedule.id, {
        stageId: schedule.status,
        [TYPES.schedule.fields.partialPaid]: schedule.partialPaidRaw,
        [TYPES.schedule.fields.remaining]: schedule.remainingRaw
      }).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (rollbackErrors.length) {
      error.message = `${error.message}; schedule rollback failed: ${rollbackErrors.map((item) => item.message).join('; ')}`;
    }
    throw error;
  }

  return {
    amdTotal,
    scheduleTotal,
    remainingTotal: scheduleTotal - schedulePaymentTotal,
    updatedSchedules: updates.length
  };
}

async function listDealSchedulesForRecalculation(deal) {
  const scheduleIds = normalizeIdList(deal?.[DEAL_FIELDS.scheduleIds] ?? deal?.scheduleIds);
  if (!scheduleIds.length) {
    return [];
  }

  const items = await listBitrixMethod('crm.item.list', {
    entityTypeId: TYPES.schedule.entityTypeId,
    order: { id: 'ASC' },
    filter: { categoryId: TYPES.schedule.categoryId, '@id': scheduleIds },
    select: [
      'id',
      'stageId',
      'parentId2',
      'opportunity',
      'currencyId',
      TYPES.schedule.fields.partialPaid,
      TYPES.schedule.fields.remaining
    ]
  });

  return items.map(mapSchedule).sort((left, right) => Number(left.id) - Number(right.id));
}

async function updateDealScheduleSummary(dealId, schedules, amdTotal, linkedReceiptIds, dealTotal) {
  const fields = getDealScheduleSummaryFields(schedules, amdTotal, dealTotal);

  const result = await updateDealFields(dealId, fields);
  const persisted = await getDealFields(dealId);

  assertDealScheduleSummaryPersisted(persisted, fields);
  assertDealReceiptIdsPersisted(persisted, linkedReceiptIds);

  return result;
}

export function getDealScheduleSummaryFields(schedules, amdTotal, dealTotal = 0) {
  const scheduleTotal = schedules.length ? sumScheduleAmounts(schedules) : Number(dealTotal);
  const schedulePaymentTotal = getSchedulePaymentTotal(schedules, amdTotal, dealTotal);

  return {
    [DEAL_FIELDS.scheduleIds]: schedules.map((schedule) => schedule.id),
    [DEAL_FIELDS.balance]: formatSummaryAmount(scheduleTotal - schedulePaymentTotal),
    [DEAL_FIELDS.paidTotal]: formatSummaryAmount(amdTotal)
  };
}

export function getSchedulePaymentTotal(schedules, amdTotal, dealTotal = 0) {
  if (!schedules.length) return Number(amdTotal);

  const scheduleTotal = sumScheduleAmounts(schedules);
  // A schedule may be created for the already-reduced balance after an advance
  // payment. That advance is already excluded from scheduleTotal and must not
  // be subtracted from the schedule a second time.
  const advanceAlreadyIncluded = Math.max(Number(dealTotal) - scheduleTotal, 0);
  return Math.max(Number(amdTotal) - advanceAlreadyIncluded, 0);
}

function updateDealFields(dealId, fields) {
  return callBitrixMethod('crm.item.update', {
    entityTypeId: 2,
    id: dealId,
    useOriginalUfNames: 'Y',
    fields
  });
}

function updateDealReceiptIds(dealId, receiptIds) {
  const value = serializeBitrixMultipleField(receiptIds);

  if (value === false) {
    return callBitrixMethod('crm.deal.update', {
      id: dealId,
      fields: {
        [DEAL_FIELDS.receiptIds]: false
      }
    });
  }

  return updateDealFields(dealId, {
    [DEAL_FIELDS.receiptIds]: value
  });
}

async function getDealFields(dealId) {
  const result = await callBitrixMethod('crm.item.get', {
    entityTypeId: 2,
    id: dealId,
    useOriginalUfNames: 'Y'
  });

  return result?.item ?? {};
}

export function assertDealScheduleSummaryPersisted(deal, expectedFields) {
  const mismatches = [DEAL_FIELDS.balance, DEAL_FIELDS.paidTotal].filter(
    (field) => normalizeSummaryAmount(deal?.[field]) !== normalizeSummaryAmount(expectedFields?.[field])
  );

  if (mismatches.length) {
    const error = new Error(
      `Bitrix deal summary fields were not persisted as requested: ${mismatches.join(', ')}`
    );
    error.status = 409;
    error.code = 'BITRIX_SUMMARY_NOT_PERSISTED';
    throw error;
  }
}

export function assertDealReceiptIdsPersisted(deal, expectedReceiptIds) {
  const actual = [...new Set(normalizeIdList(deal?.[DEAL_FIELDS.receiptIds]))].sort(compareIds);
  const expected = [...new Set(normalizeIdList(expectedReceiptIds))].sort(compareIds);

  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    const error = new Error('Bitrix deal receipt links were not persisted as requested');
    error.status = 409;
    error.code = 'BITRIX_RECEIPT_LINKS_NOT_PERSISTED';
    throw error;
  }
}

function compareIds(left, right) {
  return Number(left) - Number(right);
}

function normalizeSummaryAmount(value) {
  // A missing value is not a saved zero. Double fields may be returned as strings.
  if (typeof value !== 'number' && typeof value !== 'string') return NaN;
  if (typeof value === 'string' && value.trim() === '') return NaN;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : NaN;
}

function sumScheduleAmounts(schedules) {
  return schedules.reduce((sum, schedule) => sum + Number(schedule.amount ?? 0), 0);
}

function formatSummaryAmount(value) {
  const amount = normalizeSummaryAmount(value);
  if (!Number.isFinite(amount)) throw new Error('Invalid deal summary amount');
  // Both target fields have PRECISION=2 and accept a number without a currency suffix.
  return Number(amount.toFixed(2));
}

export function sumAmdVouchers(vouchers) {
  return vouchers
    .filter((voucher) => isAmdVoucher(voucher))
    .reduce((sum, voucher) => sum + getVoucherAmount(voucher), 0);
}

function getVoucherAmount(voucher) {
  return Number(voucher?.[TYPES.voucher.fields.amount] ?? voucher?.opportunity ?? 0);
}

function getVoucherCurrency(voucher) {
  return voucher?.currencyId || 'AMD';
}

function getVoucherAmountFields(voucher) {
  return {
    opportunity: getVoucherAmount(voucher),
    currencyId: getVoucherCurrency(voucher)
  };
}

function syncVoucherAmountFields(receiptId, receipt) {
  return callBitrixMethod('crm.item.update', {
    entityTypeId: TYPES.voucher.entityTypeId,
    id: receiptId,
    fields: getVoucherAmountFields(receipt)
  });
}

export function planScheduleUpdates(schedules, amdTotal, stages) {
  let available = amdTotal;
  const updates = [];

  for (const schedule of schedules) {
    const amount = Number(schedule.amount ?? 0);
    const paid = Math.min(available, amount);
    available = Math.max(available - amount, 0);
    const fields = getDesiredScheduleFields({ amount, paid, stages });

    if (shouldUpdateSchedule(schedule, fields)) {
      updates.push({ schedule, fields });
    }
  }

  return updates;
}

function getDesiredScheduleFields({ amount, paid, stages }) {
  if (paid >= amount && amount > 0) {
    return {
      stageId: stages.schedule.paid,
      [TYPES.schedule.fields.partialPaid]: '',
      [TYPES.schedule.fields.remaining]: ''
    };
  }

  if (paid > 0) {
    return {
      stageId: stages.schedule.partial,
      [TYPES.schedule.fields.partialPaid]: paid,
      [TYPES.schedule.fields.remaining]: amount - paid
    };
  }

  return {
    stageId: stages.schedule.unpaid,
    [TYPES.schedule.fields.partialPaid]: '',
    [TYPES.schedule.fields.remaining]: ''
  };
}

function shouldUpdateSchedule(schedule, fields) {
  if (schedule.status !== fields.stageId) {
    return true;
  }

  return (
    shouldUpdateScheduleAmountField(schedule, fields, TYPES.schedule.fields.partialPaid, 'partialPaid', 'partialPaidRaw') ||
    shouldUpdateScheduleAmountField(schedule, fields, TYPES.schedule.fields.remaining, 'remaining', 'remainingRaw')
  );
}

function shouldUpdateScheduleAmountField(schedule, fields, field, valueKey, rawKey) {
  const expected = fields[field];

  if (expected === '') {
    const rawValue = schedule[rawKey];
    return rawValue !== undefined && rawValue !== null && String(rawValue).trim() !== '';
  }

  return Number(schedule[valueKey] ?? 0) !== Number(expected);
}

export function getDefaultStages() {
  return {
    voucher: { ...TYPES.voucher.stages },
    schedule: { ...TYPES.schedule.stages }
  };
}

async function listDealVouchers(dealId, linkedReceiptIds = [], options = {}) {
  const select = [
    'id',
    'stageId',
    'opportunity',
    'currencyId',
    TYPES.voucher.fields.amount,
    TYPES.voucher.fields.currencyEnum
  ];
  const receiptIds = [...new Set(linkedReceiptIds.map(String).filter(Boolean))];
  const requests = [
    listBitrixMethod('crm.item.list', {
      entityTypeId: TYPES.voucher.entityTypeId,
      order: { id: 'ASC' },
      filter: {
        categoryId: TYPES.voucher.categoryId,
        parentId2: dealId
      },
      select
    })
  ];

  // The deal field is the contractual source of truth, so receipts linked there but missing the
  // parent relation still have to be part of the total.
  if (receiptIds.length) {
    requests.push(
      listBitrixMethod('crm.item.list', {
        entityTypeId: TYPES.voucher.entityTypeId,
        order: { id: 'ASC' },
        filter: {
          categoryId: TYPES.voucher.categoryId,
          '@id': receiptIds
        },
        select
      })
    );
  }

  const responses = await Promise.all(requests);
  const excludedReceiptIds = new Set(normalizeIdList(options.excludeReceiptIds));

  return uniqueById(responses.flat().map((voucher) => ({ ...voucher, id: String(voucher.id) })))
    .filter((voucher) => !excludedReceiptIds.has(voucher.id));
}

function updateSchedule(id, fields) {
  return callBitrixMethod('crm.item.update', {
    entityTypeId: TYPES.schedule.entityTypeId,
    id,
    fields
  });
}

function isAmdVoucher(voucher) {
  const currencyEnum = Number(voucher[TYPES.voucher.fields.currencyEnum] ?? 0);

  // The currency enum field is what the manager edits when converting a foreign receipt to AMD,
  // so it wins over currencyId whenever it is filled in.
  if (currencyEnum) {
    return currencyEnum === CURRENCY_ENUM.AMD;
  }

  return String(voucher.currencyId ?? '').trim().toUpperCase() === 'AMD';
}

function normalizeCurrency(value) {
  return String(value ?? 'AMD').trim().toUpperCase() || 'AMD';
}

async function findVoucherByExternalId(transactionId) {
  if (!transactionId) {
    return null;
  }

  const response = await callBitrixMethod('crm.item.list', {
    entityTypeId: TYPES.voucher.entityTypeId,
    filter: {
      xmlId: String(transactionId)
    },
    select: ['id', 'title', 'xmlId']
  });

  return response.items?.[0] ?? null;
}

function matchFirst(value, patterns) {
  for (const pattern of patterns) {
    const match = value.match(pattern);

    if (match) {
      return match;
    }
  }

  return null;
}

function maskMatches(value, patterns) {
  let masked = value;

  for (const pattern of patterns) {
    masked = masked.replace(pattern, (match) => ' '.repeat(match.length));
  }

  return masked;
}

export function normalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('hy-AM')
    .replace(/[‐‑‒–—]/gu, '-')
    .replace(/№/gu, '#')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function normalizeApartmentSearchInput(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^\d.,/a-zա-ֆ-]/giu, '');
}

function isPayableSchedule(schedule, stages) {
  if (schedule.status === stages.schedule.paid) {
    return false;
  }

  return (
    schedule.status === stages.schedule.unpaid ||
    schedule.status === stages.schedule.partial ||
    schedule.remaining > 0
  );
}

export function dealMatchesReceipt(receipt, deal, { allowNameFallback = true } = {}) {
  const parsed = receipt.parsed ?? {};
  const projectEvidence = getProjectDealEvidence(receipt, deal);

  if (hasApartmentConflict(parsed.apartment, deal) || projectEvidence.conflict) {
    return false;
  }

  if (env.SMART_MATCH_V2) {
    const smartEvidence = getSmartDealEvidence(receipt, deal);

    if (smartEvidence.conflict) return false;
    if (smartEvidence.matched) return true;
  }

  const haystack = deal.searchableText;
  const numberTokens = getNumberTokens(haystack);
  const buildingMatches = parsed.building ? numberTokens.has(normalizeNumber(parsed.building)) : false;
  const apartmentMatches = apartmentMatchesDeal(parsed.apartment, deal);
  const preliminaryMatches = parsed.preliminaryNumber ? numberTokens.has(normalizeNumber(parsed.preliminaryNumber)) : false;
  const areaMatches = parsed.area ? numberTokens.has(normalizeNumber(parsed.area)) : false;
  const projectMatches = projectEvidence.matched;
  const contractMatches = parsed.contractDate ? includesText(haystack, parsed.contractDate) : false;
  const payerMatches = receipt.payerName ? namesOverlap(receipt.payerName, deal.buyerName) : false;
  const apartmentOnlyMatches = isUnscopedApartmentMatch(parsed, deal);

  return (
    apartmentOnlyMatches ||
    (buildingMatches && apartmentMatches) ||
    (buildingMatches && preliminaryMatches) ||
    (projectMatches && (apartmentMatches || preliminaryMatches || areaMatches || contractMatches)) ||
    (payerMatches && (buildingMatches || apartmentMatches || projectMatches)) ||
    (allowNameFallback && isNameOnlyFallbackMatch(receipt, deal))
  );
}

function isNameOnlyFallbackMatch(receipt, deal) {
  return fullNameMatches(receipt.payerName, deal.buyerName);
}

function fullNameMatches(left, right) {
  const words = (value) => normalize(value)
    .match(/[\p{L}\p{M}]+/gu)
    ?.filter((word) => word.length >= 2) ?? [];
  const leftWords = [...new Set(words(left))];
  const rightWords = [...new Set(words(right))];
  const shorter = leftWords.length <= rightWords.length ? leftWords : rightWords;
  const longer = new Set(leftWords.length <= rightWords.length ? rightWords : leftWords);

  return shorter.length >= 3 && shorter.every((word) => longer.has(word));
}

function getDirectDealScore(receipt, deal) {
  const parsed = receipt.parsed ?? {};
  const haystack = deal.searchableText;
  const numberTokens = getNumberTokens(haystack);
  let score = 70;

  if (getProjectDealEvidence(receipt, deal).matched) {
    score += 10;
  }

  if (parsed.building && numberTokens.has(normalizeNumber(parsed.building))) {
    score += 8;
  }

  if (apartmentMatchesDeal(parsed.apartment, deal)) {
    score += 8;
  }

  if (parsed.area && numberTokens.has(normalizeNumber(parsed.area))) {
    score += 4;
  }

  if (receipt.payerName && namesOverlap(receipt.payerName, deal.buyerName)) {
    score += 6;
  }

  if (env.SMART_MATCH_V2) {
    score += getSmartDealEvidence(receipt, deal).score;
  }

  return score;
}

function apartmentMatchesDeal(parsedApartment, deal) {
  return Boolean(
    parsedApartment &&
    deal?.apartmentNumber &&
    canonicalizeNumeric(parsedApartment) === canonicalizeNumeric(deal.apartmentNumber)
  );
}

function dealApartmentMatchesSearch(queryApartment, deal) {
  return Boolean(
    queryApartment &&
    deal?.apartmentNumber &&
    canonicalizeNumeric(queryApartment) === canonicalizeNumeric(deal.apartmentNumber)
  );
}

function hasApartmentConflict(parsedApartment, deal) {
  return Boolean(
    parsedApartment &&
    deal?.apartmentNumber &&
    canonicalizeNumeric(parsedApartment) !== canonicalizeNumeric(deal.apartmentNumber)
  );
}

function isUnscopedApartmentMatch(parsed, deal) {
  return Boolean(
    apartmentMatchesDeal(parsed?.apartment, deal) &&
    !parsed?.building &&
    !parsed?.project &&
    // The legacy parser exposes a preliminary/contract number as `apartment` too. Do not let
    // that compatibility fallback turn a contract identifier into an apartment-only match.
    !parsed?.preliminaryNumber
  );
}

function getProjectDealEvidence(receipt, deal) {
  // The CRM enum is authoritative; labels and addresses support older deals without it.
  const structuredProject = getProjectById(deal.projectId);
  const dealProjects = structuredProject ? [structuredProject] : findProjects(
    [deal.projectName, deal.title, deal.searchableText].filter(Boolean).join(' ')
  );
  const receiptProjects = findProjects(
    [receipt.parsed?.project, receipt.purpose ?? receipt.parsed?.normalized].filter(Boolean).join(' ')
  );
  const differentProjects = receiptProjects.length === 1 && dealProjects.length === 1 &&
    receiptProjects[0].id !== dealProjects[0].id;
  const conflict = receiptProjects.length > 1 || dealProjects.length > 1 || differentProjects;

  return {
    matched: !conflict && receiptProjects.length === 1 && dealProjects.length === 1,
    conflict,
    label: dealProjects.length === 1 ? dealProjects[0].name : ''
  };
}

export function getSmartDealEvidence(receipt, deal) {
  const purpose = receipt.purpose ?? '';
  const projectEvidence = getProjectDealEvidence(receipt, deal);
  const find = (target, kind, minConfidence = 0) => target
    ? smartFindValue(purpose, target, {
      kind,
      allowFuzzy: kind === 'project',
      minConfidence,
      requireSemanticAnchor: true
    })
    : null;
  const project = projectEvidence.matched || find(projectEvidence.label, 'project', 0.7);
  const apartment = find(deal.apartmentNumber, 'apartment', 0.8);
  const floor = find(deal.floor, 'floor', 0.8);
  const area = find(deal.area, 'area', 0.8);
  const title = deal.title
    ? smartFindValue(purpose, deal.title, { kind: 'label', allowFuzzy: false, minConfidence: 0.95 })
    : null;
  const name = receipt.payerName && deal.buyerName
    ? namesOverlap(receipt.payerName, deal.buyerName)
    : false;
  const parsedApartment = receipt.parsed?.apartment;
  const apartmentConflict = Boolean(
    parsedApartment &&
    deal.apartmentNumber &&
    canonicalizeNumeric(parsedApartment) !== canonicalizeNumeric(deal.apartmentNumber)
  );
  const conflict = apartmentConflict || projectEvidence.conflict;
  const apartmentOnly = apartment && isUnscopedApartmentMatch(receipt.parsed, deal);

  const matched = Boolean(
    !conflict && (
      title ||
      apartmentOnly ||
      (project && apartment) ||
      (apartment && name) ||
      (apartment && (floor || area)) ||
      (project && name && (floor || area))
    )
  );
  const score = conflict
    ? 0
    : (title ? 12 : 0) + (project ? 8 : 0) + (apartment ? 10 : 0) +
      (floor ? 3 : 0) + (area ? 3 : 0) + (name ? 5 : 0);

  return { matched, conflict, score };
}

function namesOverlap(left, right) {
  if (env.SMART_MATCH_V2) {
    const options = { kind: 'name', minConfidence: 0.7 };
    const smartMatch = smartFindValue(right, left, options) ?? smartFindValue(left, right, options);

    return Boolean(smartMatch);
  }

  const leftWords = normalize(left)
    .split(' ')
    .filter((word) => word.length >= 3);
  const rightText = normalize(right);

  return leftWords.some((word) => rightText.includes(word));
}

function getNumberTokens(value) {
  return new Set(normalize(value).match(/\d+(?:[.,/]\d+)?/gu)?.map(normalizeNumber) ?? []);
}

function normalizeNumber(value) {
  return normalize(value).replace(',', '.');
}

function includesText(haystack, needle) {
  const normalizedNeedle = normalize(needle);

  return Boolean(normalizedNeedle) && normalize(haystack).includes(normalizedNeedle);
}

function flattenValue(value) {
  if (Array.isArray(value)) {
    return value.map(flattenValue).join(' ');
  }

  if (value && typeof value === 'object') {
    return Object.values(value).map(flattenValue).join(' ');
  }

  return value ?? '';
}

function transliterateLatinToArmenian(value) {
  const normalizedValue = normalize(value);
  const dictionary = {
    anahit: '\u0531\u0576\u0561\u0570\u056b\u057f',
    aram: '\u0531\u0580\u0561\u0574',
    armen: '\u0531\u0580\u0574\u0565\u0576',
    anna: '\u0531\u0576\u0576\u0561',
    karen: '\u053f\u0561\u0580\u0565\u0576',
    lilit: '\u053c\u056b\u056c\u056b\u0569',
    narine: '\u0546\u0561\u0580\u056b\u0576\u0565'
  };

  return dictionary[normalizedValue] ?? value;
}
