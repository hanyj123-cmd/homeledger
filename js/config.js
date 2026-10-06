// Home Ledger 설정. 아래 값들은 비밀값이 아닙니다. (공개 저장소에 올려도 안전)
export const CONFIG = {
  CLIENT_ID: '73033444727-eihfhc1s2pnls6uqo677202nl88fpm4i.apps.googleusercontent.com',
  SHEET_ID: '1CsPFT6-ERWMSzEVZu0wgqY_wWOy7Km8YGQj-Eo4eoTc',
  SCOPES: 'https://www.googleapis.com/auth/spreadsheets openid email',
  BASE_CCY: 'CAD',
  CURRENCIES: ['CAD', 'USD', 'KRW', 'JPY', 'EUR', 'GBP', 'CNY', 'AUD', 'MXN'],
  OWNERS: ['Patrick', 'Ms Kim', 'Joint'],
  CLEARING_ID: '2900',   // Passthrough Clearing (전달 자금)
  OPENING_ID: '3010',    // Opening Balance Equity (기초 잔액 자본)
  SYNC_SHEETS: ['Accounts', 'TaxCodes', 'Settings', 'Rules', 'FxRates', 'Transactions', 'Postings'],
  AUTO_SYNC_MS: 60000,
  APP_VERSION: '0.3.0'
};

// 각 시트의 첫 번째 열 = 행의 고유 키
export const KEYS = {
  Accounts: 'account_id',
  TaxCodes: 'tax_code',
  Settings: 'key',
  Rules: 'rule_id',
  FxRates: 'fx_id',
  Transactions: 'txn_id',
  Postings: 'posting_id'
};

const TAIL = ['updated_at', 'deleted'];

// 시트 헤더를 못 읽었을 때 쓰는 기본값 (Code.gs 의 SCHEMA 와 동일)
export const HEADERS = {
  Accounts: ['account_id', 'name', 'name_ko', 'type', 'subtype', 'parent_id', 'owner', 'institution',
    'currency', 'last4', 'report_group', 'sort_order', 'is_active'].concat(TAIL),
  TaxCodes: ['tax_code', 'name', 'rate', 'jurisdiction', 'recoverable', 'note'].concat(TAIL),
  Settings: ['key', 'value', 'note'].concat(TAIL),
  Rules: ['rule_id', 'pattern', 'account_id', 'owner', 'default_tax_code', 'is_passthrough',
    'postings_template', 'hit_count', 'source'].concat(TAIL),
  FxRates: ['fx_id', 'date', 'currency', 'rate', 'source'].concat(TAIL),
  Transactions: ['txn_id', 'date', 'posted_date', 'merchant', 'merchant_raw', 'memo',
    'currency', 'subtotal_orig', 'tax_orig', 'tip_orig', 'total_orig',
    'fx_rate', 'fx_source', 'fx_status', 'total_cad',
    'source', 'status', 'owner', 'trip_tag', 'is_passthrough',
    'receipt_id', 'statement_line_id', 'created_at'].concat(TAIL),
  Postings: ['posting_id', 'txn_id', 'line_id', 'account_id', 'amount_cad', 'amount_orig',
    'currency', 'fx_rate', 'memo'].concat(TAIL)
};
