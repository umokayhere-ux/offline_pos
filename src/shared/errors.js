'use strict';

/**
 * AppError carries a message that is safe and useful to show a shop attendant.
 * Technical detail stays in `cause` for the log file and never reaches the UI.
 */
class AppError extends Error {
  constructor(message, { code = 'APP_ERROR', cause = null, details = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.cause = cause;
    this.details = details;
    this.isAppError = true;
  }
}

class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, { code: 'VALIDATION', details });
    this.name = 'ValidationError';
  }
}

class NotFoundError extends AppError {
  constructor(message = 'The requested record could not be found.') {
    super(message, { code: 'NOT_FOUND' });
    this.name = 'NotFoundError';
  }
}

class PermissionError extends AppError {
  constructor(message = 'You do not have permission to perform this action.') {
    super(message, { code: 'FORBIDDEN' });
    this.name = 'PermissionError';
  }
}

/**
 * Turn a raw SQLite error into something a shopkeeper can act on.
 * "SQLITE_CONSTRAINT: UNIQUE constraint failed: products.barcode"
 *   -> "This barcode is already assigned to another product."
 */
const CONSTRAINT_MESSAGES = [
  [/products\.barcode|idx_products_barcode/i, 'This barcode is already assigned to another product.'],
  [/products\.sku|idx_products_sku/i, 'This SKU is already assigned to another product.'],
  [/customers\.phone|idx_customers_phone/i, 'A customer with this phone number already exists.'],
  [/users\.username/i, 'That username is already taken.'],
  [/categories\.name/i, 'A category with this name already exists.'],
  [/expense_categories\.name/i, 'An expense category with this name already exists.'],
  [/sales\.invoice_no/i, 'That invoice number has already been used.'],
  [/refunds\.reference_no/i, 'That refund reference has already been used.'],
  [/purchases\.reference_no/i, 'That purchase reference has already been used.'],
  [/expenses\.reference_no/i, 'That expense reference has already been used.'],
  [/Activity logs cannot be (modified|deleted)/i, 'Activity logs are an audit trail and cannot be changed.']
];

function toUserFacingError(error) {
  if (!error) return new AppError('An unexpected error occurred.');
  if (error.isAppError) return error;
  if (error.name === 'MoneyError') return new ValidationError(error.message);

  const raw = String(error.message || '');

  if (/SQLITE_CONSTRAINT/.test(error.code || '') || /constraint failed/i.test(raw)) {
    for (const [pattern, message] of CONSTRAINT_MESSAGES) {
      if (pattern.test(raw)) return new AppError(message, { code: 'CONSTRAINT', cause: error });
    }
    if (/FOREIGN KEY/i.test(raw)) {
      return new AppError(
        'This record is still linked to other records, so it cannot be changed or removed.',
        { code: 'CONSTRAINT', cause: error }
      );
    }
    if (/NOT NULL/i.test(raw)) {
      return new AppError('A required field was left empty.', { code: 'CONSTRAINT', cause: error });
    }
    if (/CHECK/i.test(raw)) {
      return new AppError('One of the values supplied is not allowed.', { code: 'CONSTRAINT', cause: error });
    }
    return new AppError('That change conflicts with an existing record.', { code: 'CONSTRAINT', cause: error });
  }

  if (/SQLITE_READONLY/.test(error.code || '')) {
    return new AppError('The database is read-only. Check the file permissions.', { code: 'DB_READONLY', cause: error });
  }
  if (/SQLITE_CORRUPT|SQLITE_NOTADB/.test(error.code || '')) {
    return new AppError('The database file appears to be damaged. Restore the most recent backup.', { code: 'DB_CORRUPT', cause: error });
  }
  if (/SQLITE_BUSY/.test(error.code || '')) {
    return new AppError('The database is busy. Please try again in a moment.', { code: 'DB_BUSY', cause: error });
  }

  return new AppError('Something went wrong while saving. Please try again.', { code: 'UNEXPECTED', cause: error });
}

module.exports = { AppError, ValidationError, NotFoundError, PermissionError, toUserFacingError };
