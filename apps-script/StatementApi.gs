/**
 * StatementApi.gs — reads a bank-app SCREENSHOT into transaction lines (Home Ledger, Import tab).
 *
 * The app sends:   { action: 'parseStatement', token, image: <base64>, mime: 'image/png'|'image/jpeg'|..., year: 2026, model?: 'claude-…'|'gemini-…' }
 * The app expects: { ok: true, lines: [ { date: 'YYYY-MM-DD', description: string, amount: number, balance: number|null } ], notes: string }
 *   amount  = money IN is positive, money OUT is negative, exactly as the screenshot shows it (the app flips the sign itself).
 *   balance = the running balance printed after that line, or null when the screenshot has none.
 *   lines   = in the same top-to-bottom order as the screenshot.
 *
 * WIRING (in ReceiptApi.gs, where the other actions are routed — e.g. next to 'parseReceipt'):
 *
 *     if (action === 'parseStatement') return json_(parseStatementImage_(payload));
 *
 *   (use whatever your router/response helper is called; `payload` is the parsed request body after the token check.)
 *   Then Deploy > Manage deployments > Edit > New version.
 *
 * MODELS
 *   claude-*  → callClaude_ from ClaudeProvider.gs (needs the ANTHROPIC_API_KEY script property).
 *   gemini-*  → callGeminiVision_ below, which uses the GEMINI_API_KEY script property. If your ReceiptApi.gs already
 *               has a Gemini call that takes (model, systemPrompt, userText, {base64, mime}), call that instead and delete this one.
 */

var STATEMENT_SYSTEM_PROMPT_ =
  'You read a screenshot of a bank or credit-card app transaction list and return the transactions as JSON.\n' +
  'Return ONLY a JSON object, no commentary: {"lines":[{"date":"YYYY-MM-DD","description":"...","amount":0.00,"balance":0.00}],"notes":""}\n' +
  'Rules:\n' +
  '- One entry per transaction row, in the same top-to-bottom order as the screenshot. Do not invent, merge or skip rows.\n' +
  '- date: the date heading the row sits under (e.g. "Monday October 19, 2026" -> "2026-10-19"). If the year is missing use the year given by the user.\n' +
  '- description: the merchant / payee text exactly as printed (keep reference codes like ***PJ5).\n' +
  '- amount: a number. Money coming IN is positive, money going OUT is negative. Green amounts and "+" are usually money in; a leading "-" is money out. Do not include the currency symbol or thousands separators.\n' +
  '- balance: the running balance printed under/next to that row (the smaller grey number), as a number; null if the screenshot does not show one.\n' +
  '- Ignore headers, account totals, tab bars, status bars and anything that is not a transaction row.\n' +
  '- If a number is cut off or unreadable, use null for balance, and skip the row only if the amount itself is unreadable (mention it in notes).';

function parseStatementImage_(payload) {
  if (!payload || !payload.image) throw new Error('image is required');
  var model = String(payload.model || '').trim();
  var year = Number(payload.year) || new Date().getFullYear();
  var userText = 'Read every transaction in this screenshot. Today is ' + Utilities.formatDate(new Date(), 'America/Toronto', 'yyyy-MM-dd') +
    '; use year ' + year + ' for dates that have no year. Return the JSON object only.';
  var file = { base64: payload.image, mime: payload.mime || 'image/jpeg' };
  var text;
  if (model && typeof isClaudeModel_ === 'function' && isClaudeModel_(model)) {
    text = callClaude_(model, STATEMENT_SYSTEM_PROMPT_, userText, file);
  } else {
    text = callGeminiVision_(model || 'gemini-2.5-flash', STATEMENT_SYSTEM_PROMPT_, userText, file);
  }
  var obj = JSON.parse(typeof extractJson_ === 'function' ? extractJson_(text) : String(text).replace(/^```(?:json)?|```$/g, '').trim());
  var out = [];
  (obj.lines || []).forEach(function (r) {
    var amt = Number(r && r.amount);
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.date || '')) || !isFinite(amt) || amt === 0) return;
    var bal = (r.balance === null || r.balance === undefined || r.balance === '') ? null : Number(r.balance);
    out.push({ date: String(r.date), description: String(r.description || '').slice(0, 200), amount: Math.round(amt * 100) / 100, balance: (bal !== null && isFinite(bal)) ? Math.round(bal * 100) / 100 : null });
  });
  return { ok: true, lines: out, notes: String(obj.notes || '').slice(0, 500), model: model };
}

function callGeminiVision_(model, systemPrompt, userText, file) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY is not set in Script Properties');
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  var body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userText }, { inlineData: { mimeType: file.mime, data: file.base64 } }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  };
  var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, payload: JSON.stringify(body), muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code !== 200) { var e = new Error('Gemini error ' + code + ': ' + res.getContentText().slice(0, 300)); e.code = code === 429 ? 'rate' : 'server'; throw e; }
  var j = JSON.parse(res.getContentText());
  var parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(function (p) { return p.text || ''; }).join('');
}
