// 앱이 기본으로 있어야 하는 계정 — 교회 전달 자금(2901) · 현금(Cash on hand).
// 시트에 없으면 한 번 만들어 줍니다. (고정 번호라서 여러 기기에서 동시에 열어도 중복되지 않습니다)
import { CONFIG } from './config.js';
import * as L from './ledger.js';

const CASH_RE = /cash on hand|^cash$|현금/i;

export function isCashAccount(a) {
  return !!a && a.type === 'ASSET' && (String(a.subtype || '').toUpperCase() === 'CASH' || CASH_RE.test(String(a.name || '')) || CASH_RE.test(String(a.name_ko || '')));
}

/** 없는 시스템 계정 행들 (없으면 빈 배열). accounts = Accounts 시트 행 전체(삭제된 것 포함) */
export function missingSystemAccounts(accounts, now) {
  const rows = accounts || [];
  if (!rows.length) return [];
  const byId = new Map(rows.map((a) => [String(a.account_id), a]));
  const out = [];
  // 교회 전달 자금: 개인 전달 자금(2900)을 본떠 만듭니다 (종류가 같아야 합계·보고서에서 똑같이 빠집니다)
  const personal = byId.get(CONFIG.CLEARING_ID);
  if (personal && !byId.has(CONFIG.CLEARING_CHURCH_ID)) {
    out.push(Object.assign({}, personal, {
      account_id: CONFIG.CLEARING_CHURCH_ID, name: 'Passthrough – Church', name_ko: '교회 전달 자금',
      sort_order: L.num(personal.sort_order) + 1, is_active: true, deleted: false, updated_at: now
    }));
  }
  // 현금(인출한 현금): 이미 비슷한 계좌가 있으면 만들지 않습니다
  if (!rows.some((a) => !L.truthy(a.deleted) && isCashAccount(a))) {
    let id = CONFIG.CASH_ID;
    for (let n = parseInt(id, 10); byId.has(String(n)); n++) id = String(n + 1);
    out.push({
      account_id: id, name: 'Cash on hand', name_ko: '현금', type: 'ASSET', subtype: 'CASH', parent_id: '', owner: 'Joint',
      institution: '', currency: 'CAD', last4: '', report_group: '', sort_order: 1000 + parseInt(id, 10) % 1000, is_active: true, deleted: false, updated_at: now
    });
  }
  return out;
}
