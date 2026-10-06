// 카테고리 자동 추측. 순서: ① 내가 기억시킨 규칙 → ② 과거 거래 → ③ 카드/대출 결제 → ④ 흔한 가게 이름 사전 → (⑤ 원하면 AI)
// 모두 이 기기 안에서 계산하는 순수 로직입니다. (AI 는 버튼을 눌렀을 때만, 가게 이름만 보냅니다.)
import * as L from './ledger.js';
import { callApi } from './receipts.js';

export const SOURCE_LABEL = { rule: 'Remembered (기억함)', history: 'Past txns (과거 거래)', payment: 'Card payment (카드 결제)', keyword: 'Guess (추측)', ai: 'AI guess (AI 추측)', user: 'You (직접 선택)' };

// 내 계좌표에서 찾는 "의도 → 계정" 규칙 (이름이 달라도 영문/한글 이름으로 찾습니다)
const INTENT = {
  groceries: ['EXPENSE', /^groceries|식료/i], fuel: ['EXPENSE', /gas & fuel|주유/i], transit: ['EXPENSE', /transit|parking|대중교통|주차/i],
  household: ['EXPENSE', /household supplies|생활용품/i], medical: ['EXPENSE', /medical|pharmacy|의료|약국/i], clothing: ['EXPENSE', /clothing|의류/i],
  carmaint: ['EXPENSE', /car maintenance|차량 정비/i], homemaint: ['EXPENSE', /home maintenance|집 수리/i], personal: ['EXPENSE', /personal care|미용/i],
  education: ['EXPENSE', /^education|교육/i], dining: ['EXPENSE', /dining|외식/i], coffee: ['EXPENSE', /coffee|카페/i],
  entertainment: ['EXPENSE', /entertainment|문화|오락/i], travel: ['EXPENSE', /^travel|여행/i], shopping: ['EXPENSE', /shopping|쇼핑/i],
  utilities: ['EXPENSE', /utilities|공과금/i], internet: ['EXPENSE', /internet|통신/i], subscriptions: ['EXPENSE', /subscription|구독/i],
  donations: ['EXPENSE', /donation|헌금|기부/i], homeins: ['EXPENSE', /home insurance|주택 보험/i], autoins: ['EXPENSE', /auto insurance|자동차 보험/i],
  mortgage: ['EXPENSE', /mortgage payment|모기지 납입/i], autoloan: ['EXPENSE', /auto loan payment|자동차 할부 납입/i], proptax: ['EXPENSE', /property tax|재산세/i],
  bankfees: ['EXPENSE', /bank fees|은행 수수료/i], interestexp: ['EXPENSE', /interest \(|이자 \(/i], fxfees: ['EXPENSE', /fx fees|환전 수수료/i],
  salary: ['INCOME', /salary|급여/i], govt: ['INCOME', /government|환급|지원금/i], interestinc: ['INCOME', /interest & dividends|이자 · 배당/i]
};

// [의도, 정규식, 방향('out'|'in'|undefined)] — 위에서부터 먼저 맞는 것을 씁니다.
const KEYWORDS = [
  ['fuel', /COSTCO\s*GAS|COSTCO.*FUEL|PETRO[\s-]?CANADA|\bSHELL\b|\bESSO\b|PIONEER|ULTRAMAR|SUNOCO|HUSKY|CHEVRON|MOBIL\b|GAS\s*BAR|\bFUEL\b|CIRCLE K.*GAS/, 'out'],
  ['dining', /UBER\s*\*?\s*EATS|DOORDASH|SKIP\s*THE\s*DISHES|SKIPTHEDISHES|FANTUAN|HUNGRYPANDA/],
  ['transit', /\bPRESTO\b|\bTTC\b|GO\s*TRANSIT|METROLINX|\bUBER\b|\bLYFT\b|PARKING|GREEN\s*P\b|IMPARK|EASYPARK|\b407\s*ETR|ZIPCAR|\bTAXI\b|\bCAB\b/],
  ['subscriptions', /NETFLIX|SPOTIFY|DISNEY\s*PLUS|DISNEYPLUS|APPLE\.COM\/BILL|APPLE\s*SERVICES|ITUNES|GOOGLE\s*\*|YOUTUBE|AMAZON\s*PRIME|PRIME\s*VIDEO|ADOBE|MICROSOFT\s*\*|DROPBOX|OPENAI|CHATGPT|ANTHROPIC|CLAUDE\.AI|ICLOUD|CRAVE\b|PATREON|NOTION|GITHUB|ZOOM\.US|CANVA/],
  ['internet', /\bROGERS\b|\bBELL\b|\bTELUS\b|\bFIDO\b|\bKOODO\b|VIRGIN\s*(MOBILE|PLUS)|FREEDOM\s*MOBILE|PUBLIC\s*MOBILE|TEKSAVVY|DISTRIBUTEL|ACANAC|\bSHAW\b/],
  ['utilities', /HYDRO|ENBRIDGE|ALECTRA|TORONTO\s*UTILIT|WATER\s*BILL|TORONTO\s*WATER|ENERSOURCE|\bELECTRIC|NATURAL\s*GAS|UTILITIES/],
  ['autoins', /(INTACT|BELAIR|TD\s*INSURANCE|DESJARDINS|PEMBRIDGE|AVIVA|ALLSTATE|AVIVA|CO-?OPERATORS).*(AUTO|CAR|VEHICLE)|AUTO\s*INSURANCE|CAR\s*INSURANCE/],
  ['homeins', /(INTACT|BELAIR|TD\s*INSURANCE|DESJARDINS|PEMBRIDGE|AVIVA|ALLSTATE|CO-?OPERATORS).*(HOME|TENANT|HABITATION)|HOME\s*INSURANCE|TENANT\s*INSURANCE/],
  ['mortgage', /MORTGAGE|HYPOTH/],
  ['autoloan', /AUTO\s*LOAN|CAR\s*LOAN|VEHICLE\s*LOAN/],
  ['proptax', /PROPERTY\s*TAX|CITY\s*OF\s*TORONTO.*TAX|MUNICIPAL\s*TAX/],
  ['donations', /CHURCH|DONATION|OFFERING|YOUNGNAK|RED\s*CROSS|UNITED\s*WAY|SALVATION|교회|헌금|영락|기부/],
  ['bankfees', /MONTHLY\s*ACCOUNT\s*FEE|ACCOUNT\s*FEE|SERVICE\s*CHARGE|OVERDRAFT|\bNSF\b|ANNUAL\s*FEE|E-?TRANSFER\s*FEE|INTERAC\s*FEE|WIRE\s*FEE|MONTHLY\s*FEE|PLAN\s*FEE/, 'out'],
  ['fxfees', /FOREIGN\s*(EXCHANGE|CURRENCY)\s*(CONVERSION\s*)?FEE|\bFX\s*FEE|NON-?\s*(CAD|CANADIAN)\s*(TRANSACTION|PURCHASE)\s*FEE/, 'out'],
  ['interestexp', /INTEREST\s*CHARGE|PURCHASE\s*INTEREST|CASH\s*ADVANCE\s*INTEREST|LOAN\s*INTEREST|\bINTEREST\b/, 'out'],
  ['salary', /PAYROLL|SALARY|DIRECT\s*DEP|\bPAIE\b|PAY\s*DEPOSIT|EMPLOYER/, 'in'],
  ['govt', /CANADA\s*REVENUE|\bCRA\b|TAX\s*REFUND|GST\s*(CREDIT|\/HST)|\bCCB\b|CHILD\s*BENEFIT|\bEI\s*(CANADA|PAY)|SERVICE\s*CANADA/, 'in'],
  ['interestinc', /INTEREST|DIVIDEND|\bDIV\b/, 'in'],
  ['coffee', /TIM\s*HORTON|STARBUCKS|SECOND\s*CUP|BLUE\s*BOTTLE|COFFEE|\bCAFE\b|CAFÉ|BAKERY|PAUL\s|DUNKIN|DAVIDS?\s*TEA|BUBBLE\s*TEA|GONG\s*CHA|CHATIME|TOUS\s*LES|PAIK|PAIKS|카페|커피/],
  ['groceries', /LOBLAWS|NO\s*FRILLS|SOBEYS|\bMETRO\b|FRESHCO|FOOD\s*BASICS|WAL-?MART\s*SUPERCENTRE|T\s*&\s*T|H\s*MART|HMART|FARM\s*BOY|LONGO|ADONIS|SUPERSTORE|REAL\s*CDN|ZEHRS|FORTINOS|SAVE-?ON|SAFEWAY|\bIGA\b|PROVIGO|WHOLE\s*FOODS|GALLERIA|NATURE'?S\s*EMPORIUM|GROCER|SUPERMARKET|COSTCO|FRESH\s*&\s*FRESH|MARKET\b/],
  ['medical', /SHOPPERS\s*DRUG|REXALL|PHARMA|LONDON\s*DRUGS|DENTAL|DENTIST|CLINIC|MEDICAL|LIFELABS|OPTICAL|OPTOMETR|PHYSIO|CHIROPRACT|HOSPITAL|약국|병원/],
  ['homemaint', /HOME\s*DEPOT|LOWE'?S|\bRONA\b|HOME\s*HARDWARE|PLUMB|LANDSCAP|\bHVAC\b/],
  ['carmaint', /MIDAS|JIFFY\s*LUBE|MR\.?\s*LUBE|AUTO\s*REPAIR|CAR\s*WASH|MECHANIC|KAL\s*TIRE|CANADIAN\s*TIRE\s*AUTO/],
  ['household', /DOLLARAMA|\bIKEA\b|HOMESENSE|BED\s*BATH|CANADIAN\s*TIRE|DOLLAR\s*TREE/],
  ['clothing', /UNIQLO|H\s*&\s*M\b|\bZARA\b|WINNERS|MARSHALLS|OLD\s*NAVY|\bGAP\b|LULULEMON|ARITZIA|\bNIKE\b|ADIDAS|SPORT\s*CHEK|SIMONS|THE\s*BAY|HUDSON'?S\s*BAY/],
  ['personal', /SALON|BARBER|\bSPA\b|HAIR|NAIL|BEAUTY|SEPHORA|미용/],
  ['education', /TUITION|UNIVERSITY|COLLEGE|UDEMY|COURSERA|\bSCHOOL\b|ACADEMY/],
  ['travel', /AIR\s*CANADA|WESTJET|\bPORTER\b|FLAIR\s*AIR|EXPEDIA|BOOKING\.COM|AIRBNB|\bHOTEL|MARRIOTT|HILTON|VIA\s*RAIL|KOREAN\s*AIR|ASIANA|AGODA|TRIP\.COM|HERTZ|AVIS\b|ENTERPRISE\s*RENT/],
  ['entertainment', /CINEPLEX|\bAMC\b|TICKETMASTER|EVENTBRITE|\bSTEAM\b|PLAYSTATION|NINTENDO|\bXBOX\b|BOWLING|LIVE\s*NATION|MUSEUM|\bZOO\b|ESCAPE\s*ROOM|KARAOKE|노래방/],
  ['dining', /MCDONALD|BURGER\s*KING|WENDY'?S|\bA\s*&\s*W\b|SUBWAY|\bKFC\b|POPEYES|PIZZA|SUSHI|RAMEN|RESTAURANT|GRILL|BISTRO|KITCHEN|CHIPOTLE|DOMINO|BOSTON\s*PIZZA|THE\s*KEG|SWISS\s*CHALET|HARVEY'?S|\bPUB\b|TAVERN|BBQ|STEAK|THAI|KOREAN|NOODLE|DUMPLING|식당|레스토랑/],
  ['shopping', /AMAZON|AMZN|BEST\s*BUY|APPLE\s*STORE|\bEBAY\b|\bETSY\b|WAYFAIR|INDIGO|STAPLES|WAL-?MART|WALMART|ALIEXPRESS|TEMU|SHEIN/]
];

const norm = (s) => String(s || '').toUpperCase();

export function makeResolver(accounts) {
  const live = (accounts || []).filter(L.isActive);
  const cache = new Map();
  return (intent) => {
    if (cache.has(intent)) return cache.get(intent);
    const def = INTENT[intent];
    let hit = '';
    if (def) {
      const a = live.find((x) => x.type === def[0] && (def[1].test(x.name || '') || def[1].test(x.name_ko || '')));
      hit = a ? String(a.account_id) : '';
    }
    cache.set(intent, hit);
    return hit;
  };
}

// 과거 거래의 가게 이름 → 가장 많이 쓴 카테고리
export function buildHistory(items) {
  const map = new Map();
  (items || []).forEach((it) => {
    const t = it.txn, d = it.desc;
    if (!t || !t.merchant || !d || (d.kind !== 'EXPENSE' && d.kind !== 'INCOME') || !d.categoryId || d.categoryId === '9999') return;
    const key = L.normMerchant(t.merchant);
    if (!key) return;
    if (!map.has(key)) map.set(key, new Map());
    const m = map.get(key);
    m.set(d.categoryId, (m.get(d.categoryId) || 0) + 1);
  });
  return map;
}

const topOf = (m) => { let best = null, n = 0, total = 0; m.forEach((c, id) => { total += c; if (c > n) { best = id; n = c; } }); return best ? { id: best, n, total } : null; };

function fromHistory(hist, text) {
  const key = L.normMerchant(text);
  if (!key) return null;
  const exact = hist.get(key);
  if (exact) { const t = topOf(exact); return { accountId: t.id, confidence: t.n >= 2 && t.n / t.total >= 0.8 ? 0.92 : 0.75, reason: t.n + '×' }; }
  const toks = key.split(' ').filter((x) => x.length >= 3);
  if (toks.length >= 2) {
    const pre = toks.slice(0, 2).join(' ');
    const merged = new Map();
    hist.forEach((m, k) => { if (k === pre || k.indexOf(pre + ' ') === 0) m.forEach((c, id) => merged.set(id, (merged.get(id) || 0) + c)); });
    if (merged.size) { const t = topOf(merged); return { accountId: t.id, confidence: 0.7, reason: 'similar' }; }
  }
  return null;
}

const GENERIC = new Set(['credit', 'card', 'loc', 'chequing', 'visa', 'mastercard', 'line', 'patrick', 'kim', 'joint', 'the']);
const OWNER_WORDS = new Set(['patrick', 'kim', 'ms', 'joint']);
const WORDS = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z0-9]+/).filter((x) => x.length >= 2 && !OWNER_WORDS.has(x));

// "TD VISA PAYMENT" 같은 결제 줄 → 해당 카드/마이너스통장 계정 (둘 이상 비슷하면 명세서 계좌 주인과 같은 쪽)
function fromPayment(text, ctx) {
  if (!/PAYMENT|\bPMT\b|PAIEMENT|AUTOPAY|PRE-?AUTH|BILL\s*PAY/.test(norm(text)) || /MORTGAGE|AUTO\s*LOAN/.test(norm(text))) return null;
  const words = new Set(WORDS(text));
  const owner = ctx.statementOwner || '';
  let best = [], bestScore = 0;
  (ctx.accounts || []).filter((a) => L.isActive(a) && a.type === 'LIABILITY' && (a.subtype === 'CREDIT_CARD' || a.subtype === 'LOC') ).forEach((a) => {
    const toks = WORDS(a.name);
    if (!toks.length || !toks.every((t) => words.has(t) || (t === 'card' || t === 'credit' || t === 'loc'))) return;
    const distinct = toks.filter((t) => !GENERIC.has(t));
    if (!distinct.length || !distinct.every((t) => words.has(t))) return;
    const score = toks.filter((t) => words.has(t)).length;
    if (score > bestScore) { best = [a]; bestScore = score; } else if (score === bestScore) best.push(a);
  });
  if (!best.length) return null;
  if (best.length > 1) {
    const mine = best.filter((a) => a.owner === owner);
    if (mine.length !== 1) return null;
    best = mine;
  }
  // 카드 명세서 자신을 가리키는 결제(= 이 카드로 들어오는 납부)는 다른 카드로 추측하지 않습니다
  if (String(best[0].account_id) === String(ctx.statementAccountId)) return null;
  return { accountId: String(best[0].account_id), confidence: 0.6, reason: 'payment' };
}

function fromKeyword(text, dir, resolve) {
  const t = norm(text);
  for (const [intent, rx, only] of KEYWORDS) {
    if (only && only !== dir) continue;
    if (!rx.test(t)) continue;
    // 들어온 돈에는 수입 의도만, 나간 돈에는 지출 의도만 (환불은 지출 쪽 카테고리를 그대로 씁니다)
    const def = INTENT[intent];
    if (dir === 'out' && def[0] === 'INCOME') continue;
    // 처음 맞은 규칙에서 멈춥니다: 내 계좌표에 그 계정이 없으면 다른 규칙으로 넘어가지 않고 비워 둡니다
    // (예: "COSTCO GAS" 가 연료 계정이 없다고 해서 식료품으로 추측되면 안 됩니다)
    const id = resolve(intent);
    return id ? { accountId: id, confidence: 0.7, reason: intent } : null;
  }
  return null;
}

// ctx = { rules, items, accounts, accMap, statementAccountId }
export function makeGuesser(ctx) {
  const hist = buildHistory(ctx.items);
  const resolve = makeResolver(ctx.accounts);
  const sa = ctx.accMap && ctx.accMap.get(String(ctx.statementAccountId));
  const c2 = Object.assign({}, ctx, { statementOwner: sa ? sa.owner : '' });
  return (text, direction) => {
    const dir = direction === 'in' ? 'in' : 'out';
    const r = L.suggestRule(ctx.rules || [], text);
    if (r && ctx.accMap.has(String(r.account_id))) return { accountId: String(r.account_id), source: 'rule', confidence: 1, ruleId: r.rule_id, reason: 'rule' };
    const h = fromHistory(hist, text);
    if (h && ctx.accMap.has(h.accountId)) return Object.assign({ source: 'history' }, h);
    const p = fromPayment(text, c2);
    if (p) return Object.assign({ source: 'payment' }, p);
    const k = fromKeyword(text, dir, resolve);
    if (k) return Object.assign({ source: 'keyword' }, k);
    return null;
  };
}

// ───────── AI (버튼을 눌렀을 때만) ─────────

// texts = 가게 이름 목록(중복 없이). 금액·날짜·계좌는 보내지 않습니다.
export async function askAI(texts, accounts) {
  const cats = (accounts || []).filter((a) => L.isActive(a) && (a.type === 'EXPENSE' || a.type === 'INCOME') && String(a.account_id) !== '9999')
    .map((a) => ({ id: String(a.account_id), name: a.name + (a.type === 'INCOME' ? ' (income)' : '') }));
  const out = new Map();
  for (let i = 0; i < texts.length; i += 80) {
    const chunk = texts.slice(i, i + 80).map((t, j) => ({ id: String(i + j), text: String(t).slice(0, 80) }));
    const res = await callApi({ action: 'categorize', items: chunk, categories: cats });
    (res.results || []).forEach((r) => {
      const t = texts[Number(r.id)];
      if (t !== undefined && r.category_id && cats.some((c) => c.id === String(r.category_id))) out.set(t, { accountId: String(r.category_id), confidence: Number(r.confidence) || 0.6 });
    });
  }
  return out;
}
