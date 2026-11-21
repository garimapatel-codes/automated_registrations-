/*
 * ocr.js — reads a bank-statement PDF entirely in the browser:
 * pdf.js draws each page, Tesseract (WebAssembly, bundled in /vendor) reads the pixels. Nothing is uploaded.
 */
(function (root) {
  'use strict';
  let worker = null;
  const abs = (p) => new URL(p, location.href).href;

  function supported() {
    if (location.protocol === 'file:') return { ok: false, why: 'Reading PDFs needs the site to be opened over http(s) — use the hosted link or double-click start.bat.' };
    if (typeof Tesseract === 'undefined' || typeof pdfjsLib === 'undefined') return { ok: false, why: 'The PDF reader files did not load.' };
    return { ok: true };
  }

  async function getWorker(onStatus) {
    if (worker) return worker;
    onStatus('Starting the reader (first time takes a few seconds)…');
    worker = await Tesseract.createWorker('eng', 1, {
      workerPath: abs('vendor/ocr/worker.min.js'),
      corePath: abs('vendor/ocr'),
      langPath: abs('vendor/ocr/lang'),
      workerBlobURL: false,
      gzip: true,
      cacheMethod: 'none',
    });
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    return worker;
  }

  function flatten(data) {
    const out = [];
    const take = (w) => { const b = w.bbox || {}; if (w.text && w.text.trim()) out.push({ text: w.text.trim(), left: b.x0, top: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 }); };
    if (Array.isArray(data.words) && data.words.length) data.words.forEach(take);
    else (data.blocks || []).forEach((b) => (b.paragraphs || []).forEach((p) => (p.lines || []).forEach((l) => (l.words || []).forEach(take))));
    return out;
  }

  /** file: File. Returns pages=[{words,width,height}] for Statement.parseStatement. */
  async function readPdf(file, onStatus, askPassword) {
    const sup = supported(); if (!sup.ok) throw new Error(sup.why);
    pdfjsLib.GlobalWorkerOptions.workerSrc = abs('vendor/pdf.worker.min.js');
    const data = new Uint8Array(await file.arrayBuffer());
    let pw;
    let doc = null;
    for (let attempt = 0; attempt < 4 && !doc; attempt++) {
      try { doc = await pdfjsLib.getDocument({ data: data.slice(), isEvalSupported: false, password: pw }).promise; }
      catch (e) {
        if (e && e.name === 'PasswordException') {
          pw = await askPassword(e.code === 2 ? 'That password was not right. Try again:' : 'This PDF is password-protected. Enter its password:');
          if (pw == null) throw new Error('PDF password was not provided.');
        } else throw new Error('Could not open this PDF: ' + (e && e.message ? e.message : e));
      }
    }
    if (!doc) throw new Error('Could not open this PDF.');
    if (doc.numPages > 60) throw new Error('This PDF has ' + doc.numPages + ' pages — that is longer than a monthly statement.');
    const w = await getWorker(onStatus);
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      onStatus('Reading page ' + i + ' of ' + doc.numPages + '…', (i - 1) / doc.numPages);
      const page = await doc.getPage(i);
      let vp = page.getViewport({ scale: 200 / 72 });
      if (vp.width > 3000) vp = page.getViewport({ scale: (200 / 72) * (3000 / vp.width) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const res = await w.recognize(canvas, {}, { blocks: true });
      pages.push({ words: flatten(res.data), width: canvas.width, height: canvas.height });
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
    onStatus('Done reading ' + doc.numPages + ' pages.', 1);
    await doc.destroy();
    return pages;
  }

  async function stop() { if (worker) { try { await worker.terminate(); } catch (e) { /* ignore */ } worker = null; } }

  root.Ocr = { readPdf, supported, stop };
})(typeof self !== 'undefined' ? self : this);
