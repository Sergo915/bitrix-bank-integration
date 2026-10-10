import { z } from 'zod';

const supportedCurrencies = ['AMD', 'USD', 'EUR', 'RUB'];

const rawTransactionSchema = z.record(z.unknown());

export function normalizeBankTransaction(input) {
  const transaction = rawTransactionSchema.parse(input);
  const transactionId = firstValue(transaction, ['transactionId', 'id', 'operationId', 'referenceNumber', 'documentNumber']);
  const amount = Number(firstValue(transaction, ['amount', 'sum', 'creditAmount']));
  const currency = String(firstValue(transaction, ['currency', 'currencyCode']) ?? 'AMD').trim().toUpperCase();
  const paymentDateValue = firstValue(transaction, ['paymentDate', 'transactionDate', 'date', 'createdAt']);
  const paymentDate = paymentDateValue ? new Date(String(paymentDateValue)) : new Date();

  if (!String(transactionId ?? '').trim()) {
    throw validationError('transactionId is required');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw validationError('amount must be a positive number');
  }
  if (!supportedCurrencies.includes(currency)) {
    throw validationError(`currency must be one of: ${supportedCurrencies.join(', ')}`);
  }
  if (Number.isNaN(paymentDate.getTime())) {
    throw validationError('paymentDate is invalid');
  }

  return {
    ...transaction,
    transactionId: String(transactionId).trim(),
    amount,
    currency,
    paymentDate: paymentDate.toISOString(),
    payerName: stringValue(firstValue(transaction, ['payerName', 'senderName', 'debtorName'])),
    beneficiaryName: stringValue(firstValue(transaction, ['beneficiaryName', 'receiverName', 'creditorName'])),
    purpose: stringValue(firstValue(transaction, ['purpose', 'paymentPurpose', 'description'])),
    payerDocument: stringValue(firstValue(transaction, ['payerDocument', 'payerTaxId', 'debtorIdentification'])),
    payerAddress: stringValue(firstValue(transaction, ['payerAddress', 'debtorAddress']))
  };
}

function firstValue(object, keys) {
  return keys.map((key) => object[key]).find((value) => value !== undefined && value !== null && value !== '');
}

function stringValue(value) {
  return String(value ?? '').trim();
}

function validationError(message) {
  return new z.ZodError([{ code: 'custom', path: [], message }]);
}
