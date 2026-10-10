# Bitrix Mapping

The app uses Bitrix24 as the main storage and reads all operational data from Bitrix.

## Smart Processes

- `1056` - Bank payment receipts, category `35`
- `1052` - Payment schedule, category `33`
- `parentId2` - Deal relation for schedule items and matched receipts
- Deals are read from category `5`
- Deal field `UF_CRM_1785744431` stores linked receipt IDs and must be appended to, not overwritten
- Receipt field `contactId` stores the matched deal contact

## Deal payment totals

Verified with `crm.deal.fields` and `crm.item.fields` on 2026-09-13:

- `UF_CRM_1789311265873` — paid total, type `double`, precision `2`.
- `UF_CRM_1789311290719` — remaining balance, type `double`, precision `2`.

Send numeric AMD amounts (for example `8700000`), not money strings such as
`8700000|AMD`. The retired fields `UF_CRM_1776609678581` and
`UF_CRM_1776322253480` have type `money`; the integration no longer writes them.
Existing values in those retired fields are not cleared or migrated automatically.
The summary is recalculated during receipt matching/unmatching, not by a restart.

The update is read back to verify the two numeric totals. Empty, missing, or invalid
values are a persistence failure, including when the expected total is zero.
A mismatch alone does not establish that Bitrix automation caused it.

## Receipt Fields `1056`

- `xmlId` - bank transaction id, used for duplicate prevention
- `stageId`
  - `DT1056_35:NEW` - unmatched/new receipt
  - `DT1056_35:PREPARATION` - matched receipt
- `ufCrm19_1785737436` - payer name
- `ufCrm19_1785737603` - beneficiary name
- `ufCrm19_1785737375` - paid amount
- `ufCrm19_1785736747` - payment date
- `ufCrm19_1785737270` - currency enum
- `ufCrm19_1785738531` - payment purpose
- `ufCrm19_1785736905` - debit
- `ufCrm19_1785737256` - credit
- `ufCrm19_1785737495` - payer document
- `ufCrm19_1785737544` - payer address
- `ufCrm19_1785738501` - amount in words
- currency enum values:
  - `1651` - AMD
  - `1653` - USD
  - `1655` - RUB
  - `1657` - EUR

## Schedule Fields `1052`

- `stageId` - resolved at runtime from `crm.status.list` by status element id (`491` unpaid, `493` partially paid, `495` paid), with these fallbacks:
  - `DT1052_33:NEW` - unpaid
  - `DT1052_33:PREPARATION` - partially paid
  - `DT1052_33:SUCCESS` - paid (`DYNAMIC_1052_STAGE_33` is the status `ENTITY_ID`, not a stage id)
- `parentId2` - linked deal id
- `opportunity` - schedule amount
- `currencyId` - currency
- `ufCrm17_1784111700810` - payer first name
- `ufCrm17_1784111710154` - payer last name
- `ufCrm17_1784111720716` - payer middle name
- `ufCrm17_1784111873449` - payment date
- `ufCrm17_1785747159082` - partially paid amount
- `ufCrm17_1785747288489` - remaining amount

## Flow

1. Bank transaction arrives.
2. Backend checks `1056` by `xmlId` to prevent duplicates.
3. If not found, backend creates a new `1056` item in `DT1056_35:NEW`.
4. UI reads receipts from `1056`.
5. UI reads payment schedules from `1052`, contacts, and category `5` deals to build suggestions.
6. On confirm, backend updates:
   - `1056.stageId` to `DT1056_35:PREPARATION`
   - `1056.parentId2` to selected Deal ID
   - `1056.contactId` to the selected deal contact
   - selected Deal `UF_CRM_1785744431` by appending the new receipt ID
   - `1052` schedules by recalculating paid, partially paid, and remaining amounts from AMD receipts

## Ameriabank Sync

Cron should call `POST /api/ameria/sync`. The server pulls transactions from `AMERIA_TRANSACTIONS_PATH`, creates only missing Bitrix `1056` receipt items, and returns the imported Bitrix items.

Sync is restricted to accounts `1570043109812500`, `1570043109990200`, and `1570043104948500`. Other accounts returned by Ameriabank are ignored. An explicit `accountNumber` must be one of these three accounts; other values are rejected with HTTP 400 before any bank request.

## Project mapping

Deal field `UF_CRM_1778739784729` identifies the three projects. Both purpose parsers use
`apps/server/src/services/projectMapping.js`; recognition does not require `SMART_MATCH_V2`.

| CRM ID | Canonical project | Armenian name | Russian name | Known address |
| --- | --- | --- | --- | --- |
| 1505 | Milon Plaza | Միլոն Պլազա համալիր | Комплекс Милон Плаза | Աբովյան, Օգոստոսի 23 փ., թիվ 5 / Абовян, улица 23 Августа, дом 5 |
| 1507 | Milon Tower | Միլոն Թաուեր համալիր | Комплекс Милон Тауер | Աբովյան, Բարեկամության հրապարակ, 5/1 / Абовян, площадь Барекамутяна, 5/1 |
| 1503 | Milon Hills | Միլոն Հիլս թաղամաս | Район Милон Хиллз | Առինջ Բ թաղամաս, 1-ին փ., թիվ 7 / Ариндж, микрорайон Б, 1-я улица, 7 |

Names and these addresses independently identify the same project, including common abbreviations,
case, spacing and separator variants. Existing English names remain supported. Street and house
numbers are matched together; a bare `5/1`, `5` or `7` does not identify a project.

Suggestions compare the resolved project with the structured CRM ID, falling back to deal text
when that ID is unavailable. A project still needs additional evidence for a direct deal suggestion.
Different known projects or multiple projects in one purpose veto a suggestion, including contact
suggestions when the same payer has deals in different buildings.
