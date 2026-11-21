/*
 * vault.js — everything the app stores lives in ONE encrypted blob in this browser's localStorage.
 * AES-256-GCM, key derived from the passphrase with PBKDF2-SHA256 (310k iterations). The passphrase is never stored.
 * Works in the browser and in Node (tests pass a fake storage).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Vault = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KEY = 'invitedesk.vault.v1';
  const ITER = 310000;
  const subtle = () => (typeof crypto !== 'undefined' && crypto.subtle) || require('node:crypto').webcrypto.subtle;
  const rnd = (n) => (typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(n)) : require('node:crypto').webcrypto.getRandomValues(new Uint8Array(n)));
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function deriveKey(pass, salt, iter) {
    const base = await subtle().importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  function create(storage) {
    let key = null, salt = null, iter = ITER;
    const api = {
      exists: () => !!storage.getItem(KEY),
      isOpen: () => !!key,
      async setup(pass, state) {
        salt = rnd(16); iter = ITER; key = await deriveKey(pass, salt, iter);
        await api.save(state);
      },
      async unlock(pass) {
        const raw = storage.getItem(KEY);
        if (!raw) throw new Error('No data yet');
        const o = JSON.parse(raw);
        const k = await deriveKey(pass, unb64(o.salt), o.iter);
        let plain;
        try { plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, k, unb64(o.ct)); }
        catch (e) { const err = new Error('Wrong passphrase'); err.code = 'BAD_PASS'; throw err; }
        salt = unb64(o.salt); iter = o.iter; key = k;
        return JSON.parse(new TextDecoder().decode(plain));
      },
      async save(state) {
        if (!key) throw new Error('Vault is locked');
        const iv = rnd(12);
        const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(state)));
        storage.setItem(KEY, JSON.stringify({ v: 1, salt: b64(salt), iter, iv: b64(iv), ct: b64(new Uint8Array(ct)) }));
      },
      lock() { key = null; },
      /** Re-encrypt under a new passphrase. */
      async changePass(oldPass, newPass, state) {
        await api.unlock(oldPass);
        salt = rnd(16); iter = ITER; key = await deriveKey(newPass, salt, iter);
        await api.save(state);
      },
      /** The encrypted file itself — safe to store anywhere, useless without the passphrase. */
      backupText() { const raw = storage.getItem(KEY); if (!raw) throw new Error('Nothing to back up'); return raw; },
      /** Validates a backup against its passphrase; on success it replaces this browser's data. */
      async restore(text, pass) {
        const o = JSON.parse(text);
        if (!o || o.v !== 1 || !o.salt || !o.iv || !o.ct) throw new Error('That is not an Invite Desk backup file');
        const k = await deriveKey(pass, unb64(o.salt), o.iter);
        let plain;
        try { plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, k, unb64(o.ct)); }
        catch (e) { const err = new Error('Wrong passphrase for this backup'); err.code = 'BAD_PASS'; throw err; }
        storage.setItem(KEY, text);
        salt = unb64(o.salt); iter = o.iter; key = k;
        return JSON.parse(new TextDecoder().decode(plain));
      },
      wipe() { storage.removeItem(KEY); key = null; },
    };
    return api;
  }
  return { create, KEY };
});
