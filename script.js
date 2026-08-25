(function () {
  'use strict';

  // ---- parallax ----
  var raf = null;
  function runParallax() {
    var y = (document.scrollingElement || document.documentElement).scrollTop;
    document.querySelectorAll('[data-plx]').forEach(function (el) {
      var container = el.closest('section, header');
      var base = container ? container.offsetTop : 0;
      var factor = parseFloat(el.getAttribute('data-plx'));
      var local = y - base;
      var keepCenter = el.classList.contains('hero__portrait') || el.classList.contains('notify__watermark');
      var tx = keepCenter ? 'translateX(-50%) ' : '';
      var ty = keepCenter && el.classList.contains('notify__watermark')
        ? 'translate(-50%, calc(-50% + ' + (local * factor).toFixed(1) + 'px))'
        : tx + 'translateY(' + (local * factor).toFixed(1) + 'px)';
      el.style.transform = ty;
    });
    raf = null;
  }
  function onScroll() {
    if (!raf) raf = requestAnimationFrame(runParallax);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  runParallax();

  // ---- reveal on scroll ----
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.18 });

  document.querySelectorAll('[data-reveal]').forEach(function (el, i) {
    el.style.opacity = '0';
    el.style.transform = 'translateY(34px)';
    var delay = (i % 4) * 0.08;
    el.style.transition = 'opacity 0.9s cubic-bezier(0.22,1,0.36,1) ' + delay + 's, transform 0.9s cubic-bezier(0.22,1,0.36,1) ' + delay + 's';
    io.observe(el);
  });

  // ---- gallery lightbox ----
  (function () {
    var grid = document.getElementById('gallery-grid');
    var lightbox = document.getElementById('gallery-lightbox');
    if (!grid || !lightbox) return;

    var items = Array.prototype.slice.call(grid.querySelectorAll('.gallery-tile'));
    var img = document.getElementById('gallery-lightbox-img');
    var caption = document.getElementById('gallery-caption');
    var idx = 0;

    function show(i) {
      idx = (i + items.length) % items.length;
      var el = items[idx];
      img.src = el.dataset.full;
      img.alt = el.dataset.caption || '';
      caption.textContent = (idx + 1) + ' / ' + items.length + '   ·   ' + (el.dataset.caption || '');
    }
    function open(i) {
      show(i);
      lightbox.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function close() {
      lightbox.classList.remove('open');
      document.body.style.overflow = '';
    }

    items.forEach(function (el, i) {
      el.addEventListener('click', function () { open(i); });
    });

    var closeBtn = document.getElementById('gallery-close');
    var prevBtn = document.getElementById('gallery-prev');
    var nextBtn = document.getElementById('gallery-next');
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (prevBtn) prevBtn.addEventListener('click', function () { show(idx - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function () { show(idx + 1); });
    lightbox.addEventListener('click', function (e) { if (e.target === lightbox) close(); });

    window.addEventListener('keydown', function (e) {
      if (!lightbox.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') show(idx + 1);
      else if (e.key === 'ArrowLeft') show(idx - 1);
    });
  })();

  // ---- mobile nav toggle ----
  (function () {
    var toggle = document.getElementById('nav-toggle');
    var links = document.getElementById('nav-links');
    var backdrop = document.getElementById('nav-backdrop');
    if (!toggle || !links || !backdrop) return;

    function setOpen(open) {
      links.classList.toggle('open', open);
      backdrop.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      document.body.style.overflow = open ? 'hidden' : '';
    }

    toggle.addEventListener('click', function () { setOpen(!links.classList.contains('open')); });
    backdrop.addEventListener('click', function () { setOpen(false); });
    links.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () { setOpen(false); });
    });
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
  })();

  // ---- notify form: build a proper mailto: link instead of relying on
  // the browser's inconsistent native mailto form submission ----
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
})();
