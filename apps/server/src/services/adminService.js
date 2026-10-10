import { listReceipts } from './matchEngine.js';
import { getDatabasePool } from './mysql.js';

export async function getAdminOverview() {
  const pool = getDatabasePool();
  const [[users], [sessions], [activity], [audit], [sync]] = await Promise.all([
    pool.query('SELECT COUNT(*) AS count FROM users WHERE is_active = TRUE'),
    pool.query('SELECT COUNT(*) AS count FROM user_sessions WHERE ended_at IS NULL AND expires_at > UTC_TIMESTAMP(3)'),
    pool.query('SELECT COUNT(*) AS count FROM activity_events'),
    pool.query('SELECT COUNT(*) AS count FROM audit_events'),
    pool.query("SELECT COUNT(*) AS count FROM sync_runs WHERE status = 'running'")
  ]);

  return {
    activeUsers: Number(users[0]?.count ?? 0),
    activeSessions: Number(sessions[0]?.count ?? 0),
    activityEvents: Number(activity[0]?.count ?? 0),
    auditEvents: Number(audit[0]?.count ?? 0),
    runningSyncs: Number(sync[0]?.count ?? 0)
  };
}

export async function listAuditEvents({ limit = 100, offset = 0, action = '', status = '' } = {}) {
  const pool = getDatabasePool();
  const params = [];
  const where = [];

  if (action) {
    where.push('a.action = ?');
    params.push(action);
  }
  if (status) {
    where.push('a.status = ?');
    params.push(status);
  }

  params.push(limit, offset);
  const sql = [
    'SELECT a.id, a.operation_id AS operationId, a.actor_type AS actorType,',
    'a.actor_name AS actorName, a.action, a.status, a.receipt_id AS receiptId,',
    'a.deal_id AS dealId, a.error_code AS errorCode, a.error_message AS errorMessage,',
    'a.occurred_at AS occurredAt, u.bitrix_user_id AS bitrixUserId,',
    'u.display_name AS userName FROM audit_events a',
    'LEFT JOIN users u ON u.id = a.user_id',
    where.length ? 'WHERE ' + where.join(' AND ') : '',
    'ORDER BY a.occurred_at DESC, a.id DESC LIMIT ? OFFSET ?'
  ].filter(Boolean).join(' ');
  const [rows] = await pool.query(sql, params);
  return rows;
}

export async function listUserSessions({ limit = 100, offset = 0 } = {}) {
  const pool = getDatabasePool();
  const [rows] = await pool.query(
    'SELECT s.id, s.opened_at AS openedAt, s.last_seen_at AS lastSeenAt, ' +
      's.expires_at AS expiresAt, s.ended_at AS endedAt, s.end_reason AS endReason, ' +
      'u.bitrix_user_id AS bitrixUserId, u.display_name AS userName, u.portal_domain AS portalDomain ' +
      'FROM user_sessions s JOIN users u ON u.id = s.user_id ' +
      'ORDER BY s.opened_at DESC, s.id DESC LIMIT ? OFFSET ?',
    [limit, offset]
  );
  return rows;
}

export async function getAdminReceipts({ limit = 500, offset = 0 } = {}) {
  try {
    const board = await listReceipts();
    const receipts = [...(board.unmatched ?? []), ...(board.matched ?? [])];
    return {
      summary: summarizeReceipts(receipts),
      receipts: receipts.slice(offset, offset + limit).map((receipt) => ({
        id: receipt.id,
        bankTransactionId: receipt.bankTransactionId,
        receiptId: receipt.id,
        receiptTitle: receipt.bitrixTitle,
        amount: receipt.amount,
        currency: receipt.currency,
        occurredAt: receipt.paymentDate ?? receipt.receivedAt,
        status: receipt.status
      }))
    };
  } catch {
    return getDatabaseReceipts({ limit, offset });
  }
}

function summarizeReceipts(receipts) {
  const byCurrency = new Map();

  for (const receipt of receipts) {
    const currency = receipt.currency || 'AMD';
    const current = byCurrency.get(currency) ?? { currency, receiptCount: 0, totalAmount: 0 };
    current.receiptCount += 1;
    current.totalAmount += Number(receipt.amount) || 0;
    byCurrency.set(currency, current);
  }

  return [...byCurrency.values()].sort((left, right) => left.currency.localeCompare(right.currency));
}

async function getDatabaseReceipts({ limit, offset }) {
  const pool = getDatabasePool();
  const [summary] = await pool.query(
    'SELECT currency, COUNT(*) AS receiptCount, COALESCE(SUM(amount), 0) AS totalAmount ' +
      'FROM activity_events WHERE event_type = ? AND receipt_id IS NOT NULL ' +
      'GROUP BY currency ORDER BY currency',
    ['receipt_created']
  );
  const [receipts] = await pool.query(
    'SELECT id, bank_transaction_id AS bankTransactionId, receipt_id AS receiptId, ' +
      'receipt_title AS receiptTitle, amount, currency, occurred_at AS occurredAt ' +
      'FROM activity_events WHERE event_type = ? AND receipt_id IS NOT NULL ' +
      'ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?',
    ['receipt_created', limit, offset]
  );

  return { summary, receipts };
}