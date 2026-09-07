(function () {
  'use strict';

  var RM = window.matchMedia('(prefers-reduced-motion: reduce)');
  function reduced() { return RM.matches; }

  /* ------------------------------------------------------------------
   * Refcounted scroll lock, shared by the lightbox and the nav drawer.
   * position:fixed (not overflow:hidden) so it actually holds on iOS.
   * ---------------------------------------------------------------- */
  var locks = 0, savedY = 0;
  function lock(want) {
    var before = locks;
    locks = Math.max(0, locks + (want ? 1 : -1));
    if (!before && locks) {
      savedY = window.scrollY;
      document.body.style.position = 'fixed';
      document.body.style.top = -savedY + 'px';
      document.body.style.left = '0';
      document.body.style.right = '0';
      document.body.style.overflow = 'hidden';
    } else if (before && !locks) {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.overflow = '';
      // html has scroll-behavior:smooth, so a bare scrollTo would ANIMATE the
      // page back from the top every time an overlay closes.
      var html = document.documentElement;
      var prev = html.style.scrollBehavior;
      html.style.scrollBehavior = 'auto';
      window.scrollTo(0, savedY);
      html.style.scrollBehavior = prev;
    }
  }

  /* ------------------------------------------------------------------
   * Parallax. Targets and their section offsets are measured once and
   * re-measured on resize / orientation / font load, so the scroll frame
   * does no DOM queries and forces no layout.
   * ---------------------------------------------------------------- */
  var plx = [];
  var raf = null;

  function measure() {
    plx.length = 0;
    document.querySelectorAll('[data-plx]').forEach(function (el) {
      var host = el.closest('section, header');
      var style = window.getComputedStyle(el);
      // Preserve whatever centring transform the stylesheet already applies,
      // in full — the notify watermark is translate(-50%, -50%), not just X.
      var keepX = el.classList.contains('hero__portrait') || el.classList.contains('notify__watermark');
      var keepY = el.classList.contains('notify__watermark');
      plx.push({
        el: el,
        f: parseFloat(el.getAttribute('data-plx')) || 0,
        keepX: keepX,
        keepY: keepY,
        top: host ? host.offsetTop : 0,
        h: host ? host.offsetHeight : 0,
        last: NaN
      });
    });
  }

  function apply() {
    raf = null;
    if (reduced()) return;
    var y = window.scrollY;
    var vh = window.innerHeight;
    for (var i = 0; i < plx.length; i++) {
      var p = plx[i];
      // Skip anything nowhere near the viewport: no style write, no cost.
      if (p.top + p.h < y - vh || p.top > y + vh * 2) continue;
      var v = Math.round((y - p.top) * p.f * 10) / 10;
      if (v === p.last) continue;
      p.last = v;
      if (p.keepY) p.el.style.transform = 'translate(-50%, calc(-50% + ' + v + 'px))';
      else if (p.keepX) p.el.style.transform = 'translateX(-50%) translateY(' + v + 'px)';
      else p.el.style.transform = 'translateY(' + v + 'px)';
    }
  }

  function onScroll() { if (!raf) raf = requestAnimationFrame(apply); }
  window.addEventListener('scroll', onScroll, { passive: true });

  var reT = null;
  function remeasure() {
    clearTimeout(reT);
    reT = setTimeout(function () { measure(); apply(); }, 120);
  }
  window.addEventListener('resize', remeasure, { passive: true });
  window.addEventListener('orientationchange', remeasure, { passive: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(remeasure).catch(function () {});
  measure();
  apply();

  /* ------------------------------------------------------------------
   * Reveal on scroll. threshold 0 (not 0.18): a block taller than ~5.5
   * viewports can never show 18% of itself at once, so tall sections
   * stayed invisible forever on small phones.
   * ---------------------------------------------------------------- */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
  if (reduced() || typeof IntersectionObserver === 'undefined') {
    revealEls.forEach(function (el) { el.style.opacity = '1'; el.style.transform = 'none'; });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.style.opacity = '1';
        e.target.style.transform = 'translateY(0)';
        io.unobserve(e.target);
      });
    }, { threshold: 0, rootMargin: '0px 0px -8% 0px' });

    revealEls.forEach(function (el, i) {
      el.style.opacity = '0';
      el.style.transform = 'translateY(34px)';
      var d = (i % 4) * 0.08;
      el.style.transition = 'opacity .9s cubic-bezier(.22,1,.36,1) ' + d + 's, transform .9s cubic-bezier(.22,1,.36,1) ' + d + 's';
      io.observe(el);
    });

    // A very fast jump (End key, scrollTo) can outrun the observer. On scroll
    // idle, instantly show anything already scrolled past — it should not
    // animate in from below anyway.
    var sweepT = null;
    window.addEventListener('scroll', function () {
      clearTimeout(sweepT);
      sweepT = setTimeout(function () {
        revealEls.forEach(function (el) {
          if (el.style.opacity !== '0') return;
          if (el.getBoundingClientRect().bottom >= 0) return;
          el.style.transition = 'none';
          el.style.opacity = '1';
          el.style.transform = 'translateY(0)';
          io.unobserve(el);
        });
      }, 220);
    }, { passive: true });
  }

  /* ------------------------------------------------------------------
   * Gallery lightbox: a real modal — focus moves in, is trapped, and is
   * restored on close. Plus swipe, neighbour preloading and a loading state.
   * ---------------------------------------------------------------- */
  (function () {
    var grid = document.getElementById('gallery-grid');
    var lightbox = document.getElementById('gallery-lightbox');
    if (!grid || !lightbox) return;

    var items = Array.prototype.slice.call(grid.querySelectorAll('.gallery-tile'));
    var img = document.getElementById('gallery-lightbox-img');
    var caption = document.getElementById('gallery-caption');
    var closeBtn = document.getElementById('gallery-close');
    var prevBtn = document.getElementById('gallery-prev');
    var nextBtn = document.getElementById('gallery-next');
    var idx = 0, opener = null, isOpen = false, cache = {};

    function preload(i) {
      var el = items[(i + items.length) % items.length];
      var src = el && el.dataset.full;
      if (!src || cache[src]) return;
      var p = new Image(); p.src = src; cache[src] = p;
    }
    function show(i) {
      idx = (i + items.length) % items.length;
      var el = items[idx];
      var label = el.dataset.caption || '';
      img.classList.add('is-loading');
      img.src = el.dataset.full;
      img.alt = label;
      if (img.decode) img.decode().then(clearLoading, clearLoading);
      else img.onload = clearLoading;
      caption.textContent = (idx + 1) + ' / ' + items.length + '   ·   ' + label;
      // The caption is not a live region, so name the dialog instead.
      lightbox.setAttribute('aria-label', 'Photo viewer, ' + (idx + 1) + ' of ' + items.length + ', ' + label);
      preload(idx + 1); preload(idx - 1);
    }
    function clearLoading() { img.classList.remove('is-loading'); }
    function focusables() { return [closeBtn, prevBtn, nextBtn].filter(Boolean); }

    function open(i) {
      opener = document.activeElement;
      isOpen = true;
      show(i);
      lightbox.classList.add('open');
      lock(true);
      if (window.HIA3D && window.HIA3D.pause) window.HIA3D.pause(true);
      (closeBtn || lightbox).focus();
    }
    function close() {
      if (!isOpen) return;
      isOpen = false;
      lightbox.classList.remove('open');
      img.removeAttribute('src');
      lock(false);
      if (window.HIA3D && window.HIA3D.pause) window.HIA3D.pause(false);
      if (opener && opener.focus) opener.focus();
      opener = null;
    }

    items.forEach(function (el, i) { el.addEventListener('click', function () { open(i); }); });
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (prevBtn) prevBtn.addEventListener('click', function () { show(idx - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function () { show(idx + 1); });
    lightbox.addEventListener('click', function (e) { if (e.target === lightbox) close(); });

    window.addEventListener('keydown', function (e) {
      if (!isOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); show(idx + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); show(idx - 1); }
      else if (e.key === 'Tab') {
        var f = focusables();
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        // Boundary checks alone leak if focus is already outside the dialog.
        if (!lightbox.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    // Swipe: the primary mobile path previously had no gesture at all.
    var sx = 0, sy = 0, tracking = false;
    lightbox.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      tracking = true; sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    }, { passive: true });
    lightbox.addEventListener('touchend', function (e) {
      if (!tracking) return;
      tracking = false;
      var t = e.changedTouches[0];
      var dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) show(idx + (dx < 0 ? 1 : -1));
      else if (dy > 70 && Math.abs(dy) > Math.abs(dx)) close();
    }, { passive: true });
  })();

  /* ------------------------------------------------------------------
   * Mobile nav drawer: untabbable AND hidden from screen readers when
   * closed, trapped and focus-managed when open.
   * ---------------------------------------------------------------- */
  (function () {
    var toggle = document.getElementById('nav-toggle');
    var links = document.getElementById('nav-links');
    var backdrop = document.getElementById('nav-backdrop');
    if (!toggle || !links || !backdrop) return;

    var anchors = Array.prototype.slice.call(links.querySelectorAll('a'));
    var open = false;
    function isDrawer() { return window.matchMedia('(max-width: 880px)').matches; }

    function syncHidden() {
      var hide = isDrawer() && !open;
      anchors.forEach(function (a) {
        if (hide) a.setAttribute('tabindex', '-1'); else a.removeAttribute('tabindex');
      });
      // tabindex alone still leaves the off-screen drawer readable by AT.
      if (hide) links.setAttribute('aria-hidden', 'true'); else links.removeAttribute('aria-hidden');
    }

    function setOpen(v) {
      open = !!v;
      links.classList.toggle('open', open);
      backdrop.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      lock(open);
      syncHidden();
      if (open && anchors[0]) anchors[0].focus();
    }

    toggle.addEventListener('click', function () { setOpen(!open); });
    backdrop.addEventListener('click', function () { setOpen(false); toggle.focus(); });
    anchors.forEach(function (a) {
      a.addEventListener('click', function () { if (open) { setOpen(false); toggle.focus(); } });
    });
    window.addEventListener('keydown', function (e) {
      if (!open) return;
      if (e.key === 'Escape') { setOpen(false); toggle.focus(); }
      else if (e.key === 'Tab') {
        var f = [toggle].concat(anchors);
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    window.addEventListener('resize', function () {
      if (!isDrawer() && open) setOpen(false); else syncHidden();
    }, { passive: true });
    syncHidden();
  })();

  /* ------------------------------------------------------------------
   * Scroll-spy: on an eight-section one-pager the nav never said where
   * you were.
   * ---------------------------------------------------------------- */
  (function () {
    var navLinks = Array.prototype.slice.call(document.querySelectorAll('#nav-links a[href^="#"]'));
    var targets = navLinks
      .map(function (a) { return document.querySelector(a.getAttribute('href')); })
      .filter(Boolean);
    if (!targets.length || typeof IntersectionObserver === 'undefined') return;

    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        navLinks.forEach(function (a) {
          var hit = a.getAttribute('href') === '#' + e.target.id;
          a.classList.toggle('is-current', hit);
          if (hit) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    targets.forEach(function (t) { spy.observe(t); });
  })();

  /* ---- pause the WebGL layer when the tab is hidden ---- */
  document.addEventListener('visibilitychange', function () {
    if (window.HIA3D && window.HIA3D.pause) window.HIA3D.pause(document.hidden);
  });

  /* ------------------------------------------------------------------
   * notify form — unchanged: builds an explicit mailto: rather than
   * relying on native mailto form submission.
   * ---------------------------------------------------------------- */
  (function () {
    var form = document.getElementById('notify-form');
    var submitBtn = document.getElementById('notify-submit');
    if (!form || !submitBtn) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = document.getElementById('notify-email').value.trim();
      var subject = encodeURIComponent('Notify me — Here I Am');
      var body = encodeURIComponent('Please add me to the list for release date, pre-order, and tour updates.\n\nMy email: ' + email);
      window.location.href = 'mailto:roniquemarshall7@gmail.com?subject=' + subject + '&body=' + body;
      submitBtn.textContent = 'OPENING YOUR EMAIL APP…';
      setTimeout(function () { submitBtn.textContent = 'NOTIFY ME'; }, 4000);
    });
  })();

  /* ---- countdown to release — unchanged ---- */
  (function () {
    var el = document.getElementById('countdown');
    var arrivedEl = document.getElementById('countdown-arrived');
    if (!el) return;

    var target = new Date(el.dataset.target).getTime();
    var daysEl = document.getElementById('cd-days');
    var hoursEl = document.getElementById('cd-hours');
    var minutesEl = document.getElementById('cd-minutes');
    var secondsEl = document.getElementById('cd-seconds');
    var timer = null;

    function pad(n) { return n < 10 ? '0' + n : String(n); }

    function tick() {
      var diff = target - Date.now();
      if (diff <= 0) {
        if (timer) clearInterval(timer);
        el.hidden = true;
        if (arrivedEl) arrivedEl.hidden = false;
        return;
      }
      var totalSeconds = Math.floor(diff / 1000);
      daysEl.textContent = pad(Math.floor(totalSeconds / 86400));
      hoursEl.textContent = pad(Math.floor((totalSeconds % 86400) / 3600));
      minutesEl.textContent = pad(Math.floor((totalSeconds % 3600) / 60));
      secondsEl.textContent = pad(totalSeconds % 60);
    }

    tick();
    timer = setInterval(tick, 1000);
  })();

  /* ------------------------------------------------------------------
   * WebGL layer — last, lazy, and only on devices that qualify. The tiny
   * hia-3d.js loads first purely so eligible() can veto BEFORE the 564KB
   * three.js is ever requested.
   * ---------------------------------------------------------------- */
  (function () {
    if (reduced()) return;
    if (window.__hia3dBooting) return;
    window.__hia3dBooting = true;

    function load(src) {
      return new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = src; s.async = false;
        s.onload = res;
        s.onerror = function () { rej(new Error('failed: ' + src)); };
        document.head.appendChild(s);
      });
    }

    function start() {
      window.__hia3dBooting = false;
      load('assets/js/hia-3d.js')
        .then(function () {
          if (!window.HIA3D || !window.HIA3D.eligible()) return null;
          return load('assets/js/three.min.js').then(function () { window.HIA3D.init(); });
        })
        .catch(function (e) { if (window.console) console.warn('[hia-3d] disabled:', e.message); });
    }

    if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 2500 });
    else setTimeout(start, 900);
  })();
})();
