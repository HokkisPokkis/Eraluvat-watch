// ==UserScript==
// @name         Eraluvat test
// @namespace    https://www.eraluvat.fi/
// @version      1.0
// @match        https://www.eraluvat.fi/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  const d = document.createElement('div');
  d.textContent = 'Tampermonkey toimii';
  d.style.cssText = 'position:fixed;top:10px;left:10px;z-index:2147483647;background:#111;color:#fff;padding:12px;border-radius:8px;font:16px sans-serif';
  document.documentElement.appendChild(d);
})();