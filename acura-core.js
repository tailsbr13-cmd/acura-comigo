'use strict';
/*
 * Acura Comigo — núcleo de importação/exportação (formato .acura)
 *
 * Layout do arquivo .acura (binário, sem dependências externas):
 *   bytes 0–7    : "ACURAPKG" (assinatura)
 *   bytes 8–11   : tamanho N do cabeçalho (uint32 little-endian)
 *   bytes 12…    : cabeçalho JSON (UTF-8) com dados + índice das imagens
 *   depois       : imagens (bytes brutos), localizadas por offset/tamanho/sha256
 *
 * Nada do pacote é executado: o conteúdo é lido como dados, validado e higienizado.
 */
const MAGIC = 'ACURAPKG', FORMAT = 'acura-package', VERSION = 1;
const LIM = { file: 1024 * 1024 * 1024, header: 64 * 1024 * 1024, images: 20000, str: 20000 };
const IMG_RE = /^[A-Za-z0-9_-]{1,64}\.(png|jpe?g|gif|webp|bmp)$/i;
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

class AcuraError extends Error { constructor(m) { super(m); this.name = 'AcuraError'; } }
const fail = m => { throw new AcuraError(m); };
const sha = b => require('crypto').createHash('sha256').update(b).digest('hex');
const rid = () => Date.now().toString(36) + require('crypto').randomBytes(4).toString('hex');
const S = (v, m = LIM.str) => (typeof v === 'string' ? v.slice(0, m) : '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => (s ? s.split('-').reverse().join('/') : '');
const inRange = (d, lo, hi) => (!lo || d >= lo) && (!hi || d <= hi);
const overlaps = (n, lo, hi) => (!lo || n.end >= lo) && (!hi || n.start <= hi);
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// ---------------------------------------------------------------- seleção
function validateSel(o) {
  if (o.mode === 'from') { if (!DATE_RE.test(o.from || '')) fail('Informe a data inicial.'); }
  else if (o.mode === 'period') {
    if (!DATE_RE.test(o.from || '') || !DATE_RE.test(o.to || '')) fail('Informe a data inicial e a data final.');
    if (o.from > o.to) fail('A data inicial não pode ser maior que a data final.');
  } else if (o.mode === 'articles') { if (!(o.articleIds || []).length) fail('Marque pelo menos um artigo.'); }
  else fail('Modo de exportação desconhecido.');
}
const selLabel = o => o.mode === 'from' ? `A partir de ${fmt(o.from)}` : o.mode === 'period' ? `Período ${fmt(o.from)} a ${fmt(o.to)}` : 'Artigos selecionados';
const suggestName = o => 'Acura-Comigo_' + (o.mode === 'from' ? `desde-${o.from}` : o.mode === 'period' ? `${o.from}_a_${o.to}` : 'artigos') + '_' + new Date().toLocaleDateString('sv') + '.acura';

/** Seleciona (sem alterar o banco) produtos, artigos, registros, anotações e imagens. */
function select(db, o) {
  validateSel(o);
  const lo = o.mode === 'articles' ? '' : o.from || '', hi = o.mode === 'period' ? o.to || '' : '';
  const byId = new Map(db.articles.map(a => [a.id, a]));
  let recs, notes, aids;
  if (o.mode === 'articles') {
    const ids = new Set(o.articleIds);
    recs = db.records.filter(r => ids.has(r.articleId));
    notes = db.notes.filter(n => ids.has(n.articleId));
    aids = new Set([...ids].filter(i => byId.has(i)));
  } else {
    recs = db.records.filter(r => inRange(r.date || '', lo, hi));
    notes = db.notes.filter(n => overlaps(n, lo, hi));
  }
  notes = notes.filter(n => (n.text || '').trim() && byId.has(n.articleId));
  recs = recs.filter(r => byId.has(r.articleId));
  if (!aids) aids = new Set([...recs.map(r => r.articleId), ...notes.map(n => n.articleId)]);
  const articles = db.articles.filter(a => aids.has(a.id)).map(a => ({ id: a.id, productId: a.productId, name: a.name, url: a.url || '' }));
  const pids = new Set(articles.map(a => a.productId));
  const products = db.products.filter(p => pids.has(p.id)).map(p => ({ id: p.id, name: p.name }));
  const records = recs.map(r => ({ id: r.id, articleId: r.articleId, chat: r.chat || '', chatUrl: r.chatUrl || '', date: r.date || '', notes: r.notes || '', images: [...(r.images || [])], created: r.created || 0 }));
  const outNotes = notes.map(n => ({ id: n.id, articleId: n.articleId, start: n.start, end: n.end, text: n.text }));
  const imageNames = [...new Set(records.flatMap(r => r.images))];
  return { products, articles, records, notes: outNotes, imageNames };
}

function stats(d, images) {
  const ds = [...d.records.map(r => r.date), ...d.notes.flatMap(n => [n.start, n.end])].filter(Boolean).sort();
  return { products: d.products.length, articles: d.articles.length, records: d.records.length, notes: d.notes.length, images: images ?? (d.imageNames || []).length, min: ds[0] || '', max: ds[ds.length - 1] || '' };
}

// ---------------------------------------------------------------- exportação
function buildPackage(db, imgDir, o) {
  const fs = require('fs'), path = require('path');
  const sel = select(db, o), warnings = [], imgs = [], blobs = [], have = new Set();
  let off = 0;
  for (const name of sel.imageNames) {
    if (!IMG_RE.test(name)) { warnings.push(`Imagem com nome/tipo não suportado ignorada: ${name}`); continue; }
    let b;
    try { b = fs.readFileSync(path.join(imgDir, name)); } catch (e) { warnings.push(`Imagem não encontrada no computador: ${name}`); continue; }
    imgs.push({ name, size: b.length, sha256: sha(b), offset: off }); blobs.push(b); off += b.length; have.add(name);
  }
  sel.records.forEach(r => { r.images = r.images.filter(n => have.has(n)); });
  const data = { products: sel.products, articles: sel.articles, records: sel.records, notes: sel.notes };
  const header = {
    format: FORMAT, version: VERSION, id: rid(), createdAt: new Date().toISOString(), app: 'Acura Comigo',
    author: S(o.author, 80), selection: { mode: o.mode, from: o.from || '', to: o.to || '' },
    data, images: imgs, contentHash: sha(JSON.stringify(data)),
  };
  const hb = Buffer.from(JSON.stringify(header), 'utf8'), lenb = Buffer.alloc(4);
  lenb.writeUInt32LE(hb.length);
  const buffer = Buffer.concat([Buffer.from(MAGIC, 'latin1'), lenb, hb, ...blobs]);
  return { buffer, summary: stats(data, imgs.length), warnings, header };
}

// ---------------------------------------------------------------- leitura / validação
function readPackage(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 12) fail('Arquivo vazio ou incompleto.');
  if (buf.length > LIM.file) fail('Arquivo grande demais para importar.');
  if (buf.subarray(0, 8).toString('latin1') !== MAGIC) fail('Este arquivo não é um pacote do Acura Comigo (.acura) ou está corrompido.');
  const hl = buf.readUInt32LE(8);
  if (hl < 2 || hl > LIM.header || 12 + hl > buf.length) fail('Cabeçalho inválido — o arquivo está incompleto ou corrompido.');
  let h;
  try { h = JSON.parse(buf.subarray(12, 12 + hl).toString('utf8')); } catch (e) { fail('Não foi possível ler o conteúdo do pacote (dados corrompidos).'); }
  if (!h || typeof h !== 'object' || h.format !== FORMAT) fail('Formato de pacote não reconhecido.');
  if (!Number.isInteger(h.version) || h.version < 1) fail('Versão de pacote inválida.');
  if (h.version > VERSION) fail('Este pacote foi criado por uma versão mais nova do Acura Comigo. Atualize o aplicativo para importá-lo.');
  const d = h.data;
  if (!d || ![d.products, d.articles, d.records, d.notes, h.images].every(Array.isArray)) fail('Estrutura do pacote incompatível.');
  if (h.images.length > LIM.images) fail('Pacote com imagens demais.');
  if (typeof h.contentHash !== 'string' || sha(JSON.stringify(d)) !== h.contentHash) fail('Os dados do pacote não passam na verificação de integridade (arquivo alterado ou corrompido).');
  if (typeof h.id !== 'string' || !ID_RE.test(h.id)) fail('Identificador do pacote inválido.');

  const blobStart = 12 + hl, blobLen = buf.length - blobStart, imgMeta = {};
  for (const im of h.images) {
    if (!im || typeof im.name !== 'string' || !IMG_RE.test(im.name)) fail('O pacote contém uma imagem com nome ou tipo inválido.');
    if (imgMeta[im.name]) fail('O pacote contém imagens duplicadas.');
    if (!Number.isSafeInteger(im.offset) || !Number.isSafeInteger(im.size) || im.offset < 0 || im.size < 0 || im.offset + im.size > blobLen) fail(`A imagem ${im.name} está incompleta no pacote (arquivo truncado ou corrompido).`);
    if (sha(buf.subarray(blobStart + im.offset, blobStart + im.offset + im.size)) !== im.sha256) fail(`A imagem ${im.name} está corrompida no pacote.`);
    imgMeta[im.name] = { offset: im.offset, size: im.size };
  }

  // higienização dos dados (tipos, tamanhos, referências)
  let dropped = 0;
  const okId = v => typeof v === 'string' && ID_RE.test(v);
  const products = [], pset = new Set();
  for (const p of d.products) { if (!p || !okId(p.id) || pset.has(p.id)) { dropped++; continue; } pset.add(p.id); products.push({ id: p.id, name: S(p.name, 200) || '(sem nome)' }); }
  const articles = [], aset = new Set();
  for (const a of d.articles) {
    if (!a || !okId(a.id) || aset.has(a.id)) { dropped++; continue; }
    let pid = a.productId;
    if (!pset.has(pid)) { pid = '__sem_produto'; if (!pset.has(pid)) { pset.add(pid); products.push({ id: pid, name: 'Sem produto' }); } }
    aset.add(a.id); articles.push({ id: a.id, productId: pid, name: S(a.name, 300) || '(sem nome)', url: S(a.url, 2000) });
  }
  const records = [], rset = new Set();
  for (const r of d.records) {
    if (!r || !okId(r.id) || rset.has(r.id) || !aset.has(r.articleId)) { dropped++; continue; }
    rset.add(r.id);
    records.push({ id: r.id, articleId: r.articleId, chat: S(r.chat, 200), chatUrl: S(r.chatUrl, 2000), date: DATE_RE.test(r.date) ? r.date : '', notes: S(r.notes), images: (Array.isArray(r.images) ? r.images : []).filter(n => typeof n === 'string' && imgMeta[n]), created: Number.isFinite(r.created) ? r.created : 0 });
  }
  const notes = [], nset = new Set();
  for (const n of d.notes) {
    if (!n || !okId(n.id) || nset.has(n.id) || !aset.has(n.articleId) || !DATE_RE.test(n.start) || !DATE_RE.test(n.end)) { dropped++; continue; }
    nset.add(n.id); notes.push({ id: n.id, articleId: n.articleId, start: n.start, end: n.end, text: S(n.text) });
  }
  const warnings = dropped ? [`${dropped} item(ns) inválido(s) do pacote foram ignorados.`] : [];
  const imageNames = [...new Set(records.flatMap(r => r.images))];
  return { id: h.id, createdAt: S(h.createdAt, 40), author: S(h.author, 80), app: S(h.app, 60), contentHash: h.contentHash, data: { products, articles, records, notes, imageNames }, imgMeta, blobStart, buf, warnings, totalImages: h.images.length };
}

const getImage = (pkg, name) => { const m = pkg.imgMeta[name]; return m ? pkg.buf.subarray(pkg.blobStart + m.offset, pkg.blobStart + m.offset + m.size) : null; };

/** Aplica filtro de período e de artigos sobre os dados já validados do pacote. */
function filterData(data, f = {}) {
  const lo = f.from || '', hi = f.to || '', dated = !!(lo || hi);
  const allow = f.articleIds ? new Set(f.articleIds) : null;
  const ok = id => !allow || allow.has(id);
  const records = data.records.filter(r => ok(r.articleId) && (!dated || inRange(r.date, lo, hi)));
  const notes = data.notes.filter(n => ok(n.articleId) && (!dated || overlaps(n, lo, hi)));
  const used = new Set([...records.map(r => r.articleId), ...notes.map(n => n.articleId)]);
  const articles = data.articles.filter(a => ok(a.id) && (!dated || used.has(a.id)));
  const pids = new Set(articles.map(a => a.productId));
  const products = data.products.filter(p => pids.has(p.id));
  const imageNames = [...new Set(records.flatMap(r => r.images))];
  return { products, articles, records, notes, imageNames };
}

// ---------------------------------------------------------------- importação
function findDuplicate(db, pkg) {
  const l = db.imports || [];
  return l.find(e => e.pkgId === pkg.id) ? { kind: 'file', entry: l.find(e => e.pkgId === pkg.id) }
    : l.find(e => e.hash === pkg.contentHash) ? { kind: 'content', entry: l.find(e => e.hash === pkg.contentHash) } : null;
}

/** Possíveis vínculos com dados do usuário — apenas informativo, nunca substitui nada. */
function related(db, data) {
  const out = { articles: {}, records: 0 };
  const pName = id => db.products.find(p => p.id === id)?.name || '';
  for (const a of data.articles) {
    const hits = [];
    for (const m of db.articles) {
      const label = `${pName(m.productId)} › ${m.name}`;
      if (m.id === a.id) hits.push({ kind: 'id', label });
      else if (norm(m.name) === norm(a.name)) hits.push({ kind: 'nome', label });
    }
    if (hits.length) out.articles[a.id] = hits;
  }
  const mine = new Set(db.records.map(r => r.id));
  out.records = data.records.filter(r => mine.has(r.id)).length;
  return out;
}

function importPackage(pkg, f, meta, imgRoot) {
  const fs = require('fs'), path = require('path');
  const data = filterData(pkg.data, f);
  if (!data.records.length && !data.notes.length && !data.articles.length) fail('Nada para importar com os filtros selecionados.');
  const id = rid(), dir = path.join(imgRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const n of data.imageNames) {
      if (!IMG_RE.test(n) || path.basename(n) !== n) fail('Nome de imagem inválido.');
      fs.writeFileSync(path.join(dir, n), getImage(pkg, n));
    }
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    fail(e instanceof AcuraError ? e.message : 'Não foi possível gravar as imagens do pacote: ' + e.message);
  }
  return {
    id, name: S(meta.name, 200) || 'Pacote importado', fileName: S(meta.fileName, 260), importedAt: Date.now(),
    exportedAt: pkg.createdAt, author: pkg.author, pkgId: pkg.id, hash: pkg.contentHash,
    filter: { from: f.from || '', to: f.to || '', partialArticles: !!f.articleIds && f.articleIds.length < pkg.data.articles.length },
    products: data.products, articles: data.articles, records: data.records, notes: data.notes, imageCount: data.imageNames.length,
  };
}

function removeImportFiles(id, imgRoot) {
  const fs = require('fs'), path = require('path');
  if (typeof id !== 'string' || !ID_RE.test(id)) return;
  fs.rmSync(path.join(imgRoot, id), { recursive: true, force: true });
}

// ---------------------------------------------------------------- relatório (HTML → PDF)
function buildReportHtml(db, imgDir, o) {
  const fs = require('fs'), path = require('path');
  const sel = select(db, o);
  const img = n => {
    if (!IMG_RE.test(n)) return '';
    try { return `<img src="data:${MIME[n.split('.').pop().toLowerCase()]};base64,${fs.readFileSync(path.join(imgDir, n)).toString('base64')}">`; } catch (e) { return ''; }
  };
  let h = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório Acura Comigo</title><style>
body{font:12px "Segoe UI",Arial,sans-serif;color:#111;margin:0}h1{font-size:20px;margin:0}h2{font-size:16px;margin:22px 0 4px;border-bottom:2px solid #2f6bff;padding-bottom:3px}
h3{font-size:14px;margin:14px 0 4px}.meta{color:#555;margin:2px 0 8px}.note{background:#eef4ff;border-left:4px solid #3fa7ff;padding:8px 10px;margin:6px 0;white-space:pre-wrap}
.chat{border:1px solid #ccc;border-radius:6px;padding:8px 10px;margin:6px 0;page-break-inside:avoid}.chat b{font-size:13px}.obs{white-space:pre-wrap;margin:4px 0}
.imgs img{max-width:300px;max-height:220px;margin:4px 6px 0 0;border:1px solid #ddd}a{color:#1a4fd6}</style></head><body>
<h1>Relatório Acura Comigo</h1><div class="meta">${esc(selLabel(o))} · gerado em ${new Date().toLocaleString('pt-BR')}${o.author ? ' · por ' + esc(o.author) : ''}</div>`;
  const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR');
  for (const p of [...sel.products].sort(byName)) {
    h += `<h2>${esc(p.name)}</h2>`;
    for (const a of sel.articles.filter(x => x.productId === p.id).sort(byName)) {
      h += `<h3>${esc(a.name)}</h3>${safeUrl(a.url) ? `<div class="meta"><a href="${esc(a.url)}">${esc(a.url)}</a></div>` : ''}`;
      for (const n of sel.notes.filter(x => x.articleId === a.id).sort((x, y) => x.start.localeCompare(y.start))) h += `<div class="note"><b>Anotação — ${fmt(n.start)} a ${fmt(n.end)}</b><br>${esc(n.text)}</div>`;
      for (const r of sel.records.filter(x => x.articleId === a.id).sort((x, y) => (x.date || '').localeCompare(y.date || ''))) {
        h += `<div class="chat"><b>Chat #${esc(r.chat || '—')}</b> · ${fmt(r.date) || 'sem data'}${safeUrl(r.chatUrl) ? ` · <a href="${esc(r.chatUrl)}">link</a>` : ''}<div class="obs">${esc(r.notes) || '<i>Sem observações</i>'}</div>`;
        if (o.withImages && r.images.length) h += `<div class="imgs">${r.images.map(img).join('')}</div>`;
        else if (r.images.length) h += `<div class="meta">${r.images.length} imagem(ns) anexada(s)</div>`;
        h += '</div>';
      }
    }
  }
  return { html: h + '</body></html>', summary: stats(sel) };
}

module.exports = { AcuraError, select, stats, buildPackage, readPackage, getImage, filterData, findDuplicate, related, importPackage, removeImportFiles, buildReportHtml, suggestName, selLabel, IMG_RE, DATE_RE, fmt };
