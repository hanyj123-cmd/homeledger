/**
 * ClaudeProvider.gs — Claude (Anthropic) support for the Home Ledger receipt server.
 *
 * WHY THIS FILE EXISTS
 *   The app (this repo) never calls an AI directly. It POSTs to the Apps Script web app
 *   (ReceiptApi.gs) and sends only a model name, e.g. { action: 'parseReceipt', model: 'claude-haiku-5-5' }.
 *   The server decides which company's API to call. Until now it only knew Gemini.
 *   This file adds the Claude half. Models starting with "claude-" go to Anthropic,
 *   models starting with "gemini-" keep going to Gemini.
 *
 * SETUP (one time)
 *   1. In the Apps Script editor: File > New > Script, name it ClaudeProvider, paste this file.
 *   2. Project Settings > Script Properties > Add property:
 *        ANTHROPIC_API_KEY = sk-ant-...        (create one at console.anthropic.com)
 *   3. Wire it into ReceiptApi.gs (see "WIRING" below), then Deploy > Manage deployments >
 *      Edit > New version. The web app URL stays the same.
 *
 * WIRING (in ReceiptApi.gs — the existing Gemini code was not available when this file was written)
 *   a) Where the server picks a model and calls Gemini for `parseReceipt`, `advise`, `testModel`:
 *
 *        if (isClaudeModel_(model)) {
 *          text = callClaude_(model, systemPrompt, userText, { base64: image, mime: mime });
 *        } else {
 *          text = <your existing Gemini call>;
 *        }
 *
 *      then run `text` through the SAME JSON parsing / validation you already use for Gemini.
 *      Use extractJson_(text) below if your Gemini path does not already strip code fences.
 *      For `advise` (text only) pass no image: callClaude_(model, systemPrompt, userText).
 *
 *   b) `testModel`: for Claude models call testClaudeModel_(model) and return { ok: true, ms: <number> }.
 *
 *   c) `listModels`: append CLAUDE_MODELS_ to the list you return, so the picker can show them.
 *
 *   d) Your "try the next model if this one fails" loop can keep working as is: callClaude_ throws an
 *      Error whose .code is 'rate' | 'config' | 'server', the same codes the app already understands.
 */

var ANTHROPIC_URL_ = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION_ = '2023-06-01';
var CLAUDE_MAX_TOKENS_ = 4096;
var CLAUDE_MODELS_ = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];

function isClaudeModel_(name) {
  return /^claude-[a-z0-9][a-z0-9.\-]{1,58}$/.test(String(name || '').trim().toLowerCase());
}

function claudeError_(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Calls the Anthropic Messages API and returns the model's text.
 *   model        'claude-haiku-5-5' | 'claude-sonnet-5-5' | 'claude-opus-5-5' | ...
 *   systemPrompt the same instructions you give Gemini (string, may be '')
 *   userText     the user message text (string)
 *   file         optional { base64, mime } — a receipt photo (image/*) or a PDF
 */
function callClaude_(model, systemPrompt, userText, file) {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw claudeError_('config', 'ANTHROPIC_API_KEY is not set in Script Properties (Apps Script 설정에 앤트로픽 API 키가 없습니다).');

  var content = [];
  if (file && file.base64) {
    var mime = String(file.mime || 'image/jpeg').toLowerCase();
    if (mime === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.base64 } });
    } else {
      // Claude accepts jpeg, png, gif, webp. The app already sends JPEG after its scan step.
      if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].indexOf(mime) < 0) {
        throw claudeError_('bad_request', 'Claude cannot read this image type (' + mime + '). Use JPEG or PNG (이 사진 형식은 클로드가 읽을 수 없어요).');
      }
      content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: file.base64 } });
    }
  }
  content.push({ type: 'text', text: String(userText || '') });

  var body = {
    model: String(model).trim().toLowerCase(),
    max_tokens: CLAUDE_MAX_TOKENS_,
    messages: [{ role: 'user', content: content }]
  };
  if (systemPrompt) body.system = String(systemPrompt);

  var res = UrlFetchApp.fetch(ANTHROPIC_URL_, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION_ },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  var status = res.getResponseCode();
  var raw = res.getContentText();
  var data = null;
  try { data = JSON.parse(raw); } catch (e) { /* handled below */ }

  if (status < 200 || status >= 300) {
    var detail = (data && data.error && data.error.message) ? data.error.message : raw.slice(0, 200);
    if (status === 401 || status === 403) throw claudeError_('config', 'Anthropic rejected the API key (앤트로픽 API 키를 확인하세요): ' + detail);
    if (status === 429 || status === 529) throw claudeError_('rate', 'Claude is busy or over the rate limit (클로드가 바쁘거나 사용량을 초과했어요): ' + detail);
    if (status === 400 || status === 404) throw claudeError_('bad_request', 'Claude request failed (' + status + '): ' + detail);
    throw claudeError_('server', 'Claude server error (' + status + '): ' + detail);
  }

  var text = '';
  ((data && data.content) || []).forEach(function (block) {
    if (block && block.type === 'text' && block.text) text += block.text;
  });
  if (!text) throw claudeError_('server', 'Claude returned an empty answer (클로드가 빈 답을 보냈어요).');
  return text;
}

/** Claude sometimes wraps JSON in ```json fences or adds a sentence before it. Returns the parsed object. */
function extractJson_(text) {
  var t = String(text || '').trim();
  var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  var start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try { return JSON.parse(t); } catch (e) { throw claudeError_('parse', 'Could not read the JSON from the model answer (모델 답변의 JSON 을 읽지 못했어요).'); }
}

/** For the `testModel` action: one tiny request, returns elapsed milliseconds. */
function testClaudeModel_(model) {
  var t0 = new Date().getTime();
  callClaude_(model, '', 'Reply with the single word: ok');
  return new Date().getTime() - t0;
}
