/* =====================================================================
 * hia-3d.js — WebGL layer for "Here I Am — The Ronique Marshall Story"
 *
 * Loaded lazily AFTER first paint, and only on devices that pass the
 * eligibility probe. If anything here fails, the site is unchanged: the
 * flat cover art stays visible until a scene reports its first frame.
 *
 * DESIGN RULES (deliberate, do not "optimise" away):
 *  - Zero autonomous idle motion. The CSS `hia-float` keyframe already
 *    moves the wrapper (and therefore the canvas) in perfect phase. The
 *    rAF loop runs ONLY while a scene says it still has work to do, so a
 *    settled, unhovered book costs exactly zero frames.
 *  - Ambient-dominant lighting on the book. The cover is a near-white
 *    studio photograph; a strong directional key would visibly re-grade
 *    her photograph, which is worse than shipping no 3D at all.
 *  - The GPU context is created on first intersection, never up front.
 *
 * Depends on window.THREE (assets/js/three.min.js — tree-shaken subset).
 * Exposes window.HIA3D = { init, dispose, pause, eligible }.
 * ===================================================================== */
(function () {
  'use strict';
  if (window.HIA3D && window.HIA3D.__live) return;

  function prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  /* Single source of truth. The page calls this BEFORE fetching three.js,
     so an ineligible visitor downloads nothing. */
  function eligible() {
    try {
      if (prefersReducedMotion()) return false;
      var c = navigator.connection || {};
      if (c.saveData) return false;
      if (typeof c.effectiveType === 'string' && /(^|-)2g$/.test(c.effectiveType)) return false;
      if (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory > 0 && navigator.deviceMemory < 4) return false;
      if (typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency < 4) return false;
      if (Math.min(screen.width, screen.height) < 360) return false;
      var probe = document.createElement('canvas');
      // three r185 requests 'webgl2' and nothing else — accepting a WebGL1
      // context here would download 564KB and then throw on first render.
      var gl = probe.getContext('webgl2');
      if (!gl) return false;
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return true;
    } catch (e) { return false; }
  }

  /* ---------------- shared frame clock ---------------- */
  function Loop() {
    this.scenes = [];
    this.raf = 0;
    this.last = 0;
    this.paused = false;
    this._tick = this._tick.bind(this);
  }
  Loop.prototype.add = function (s) {
    if (this.scenes.indexOf(s) === -1) this.scenes.push(s);
    this.kick();
  };
  Loop.prototype.remove = function (s) {
    var i = this.scenes.indexOf(s);
    if (i !== -1) this.scenes.splice(i, 1);
    if (!this.scenes.length) this.stop();
  };
  Loop.prototype.setPaused = function (p) {
    this.paused = !!p;
    if (p) this.stop(); else this.kick();
  };
  Loop.prototype.wanted = function () {
    if (this.paused || document.hidden) return false;
    for (var i = 0; i < this.scenes.length; i++) {
      var s = this.scenes[i];
      if (s.visible && !s.dead && s.needsFrame && s.needsFrame()) return true;
    }
    return false;
  };
  Loop.prototype.kick = function () {
    if (!this.raf && this.wanted()) { this.last = 0; this.raf = requestAnimationFrame(this._tick); }
  };
  Loop.prototype.stop = function () { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; } };
  Loop.prototype._tick = function (t) {
    this.raf = 0;
    if (this.paused || document.hidden) return;
    var dt = this.last ? Math.min((t - this.last) / 1000, 0.05) : 0.016;
    this.last = t;
    // Iterate a copy: a scene that throws disposes itself, which splices
    // this.scenes mid-loop and would silently skip the next scene.
    var list = this.scenes.slice();
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s.visible || s.dead) continue;
      if (s.needsFrame && !s.needsFrame()) continue;
      try { s.frame(dt, t / 1000); } catch (e) { s.kill(e); }
    }
    if (this.wanted()) this.raf = requestAnimationFrame(this._tick);
  };

  /* ---------------- scene base ---------------- */
  function Scene3D(host, loop, opts) {
    opts = opts || {};
    this.host = host;
    this.loop = loop;
    this.opts = opts;
    this.visible = false;
    this.dead = false;
    this.ready = false;
    this.w = 0; this.h = 0;
    this.firstFrame = false;

    var self = this;
    this._io = new IntersectionObserver(function (en) {
      var hit = false;
      for (var i = 0; i < en.length; i++) if (en[i].isIntersecting) hit = true;
      if (hit && !self.ready && !self.dead) { try { self.ensure(); } catch (e) { self.kill(e); return; } }
      self.visible = hit && !self.dead;
      if (self.visible && self.onEnter) self.onEnter();
      self.loop.kick();
    }, { threshold: 0.05, rootMargin: '200px 0px' });
    this._io.observe(host);
  }

  /* GPU context is minted here — on first intersection, not at construction. */
  Scene3D.prototype.ensure = function () {
    if (this.ready) return;
    var T = window.THREE;
    this.renderer = new T.WebGLRenderer({
      alpha: true,
      antialias: !!this.opts.antialias,
      powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: false
    });
    this.renderer.setClearAlpha(0);
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:block;' +
      'pointer-events:none;opacity:0;transition:opacity .8s ease';
    this.host.appendChild(this.canvas);

    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(this.opts.fov || 34, 1, 0.1, 200);

    var self = this;
    this._onLost = function (e) { e.preventDefault(); self.visible = false; };
    this._onRestored = function () {
      // Do not assume visibility: the context can come back while the host is
      // far off screen, which would pin an invisible scene at 60fps. Textures
      // are re-uploaded by marking every map dirty.
      self.scene.traverse(function (o) {
        var m = o.material; if (!m) return;
        var arr = Array.isArray(m) ? m : [m];
        for (var i = 0; i < arr.length; i++) {
          for (var k in arr[i]) { var v = arr[i][k]; if (v && v.isTexture) v.needsUpdate = true; }
          arr[i].needsUpdate = true;
        }
      });
      self.w = 0; self.h = 0;            // force a resize + redraw
      self.dirty = true;
      self.resize();
      self.loop.kick();
    };
    this.canvas.addEventListener('webglcontextlost', this._onLost, false);
    this.canvas.addEventListener('webglcontextrestored', this._onRestored, false);

    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(function () { self.resize(); });
      this._ro.observe(this.host);
    }
    this.ready = true;
    if (this.build) this.build();
    this.resize();
  };

  Scene3D.prototype.dpr = function () {
    var cap = this.opts.dprCap || 2;
    return Math.min(window.devicePixelRatio || 1, cap);
  };

  Scene3D.prototype.resize = function () {
    if (this.dead || !this.ready) return;
    // offsetWidth/Height, NOT getBoundingClientRect: an ancestor carries
    // rotate(-1.2deg) from hia-float, and the rect would be the rotated
    // bounding box — a few px too large, and oscillating every frame.
    var w = Math.max(1, this.host.offsetWidth);
    var h = Math.max(1, this.host.offsetHeight);
    this.renderer.setPixelRatio(this.dpr());   // must run even if size is same
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.onResize) this.onResize(w, h);
    this.dirty = true;
    this.loop.kick();
  };

  Scene3D.prototype.reveal = function () {
    if (this.firstFrame) return;
    this.firstFrame = true;
    this.canvas.style.opacity = '1';
    this.host.setAttribute('data-hia-on', '');
    if (this.onFirstFrame) this.onFirstFrame();
  };

  Scene3D.prototype.kill = function (err) {
    if (this.dead) return;
    if (err && window.console) console.warn('[hia-3d] scene failed, falling back:', err);
    this.dispose();
  };

  Scene3D.prototype.dispose = function () {
    this.dead = true;
    this.visible = false;
    this.loop.remove(this);
    if (this._io) { this._io.disconnect(); this._io = null; }
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this.onDispose) { try { this.onDispose(); } catch (e) {} }
    if (!this.ready) return;
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    this.scene.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      var m = o.material; if (!m) return;
      var arr = Array.isArray(m) ? m : [m];
      for (var i = 0; i < arr.length; i++) {
        for (var k in arr[i]) { var v = arr[i][k]; if (v && v.isTexture) v.dispose(); }
        arr[i].dispose();
      }
    });
    try { this.renderer.dispose(); } catch (e) {}
    try { this.renderer.forceContextLoss(); } catch (e) {}
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.host.removeAttribute('data-hia-on');
    this.ready = false;
  };

  window.HIA3D = {
    __live: true,
    eligible: eligible,
    prefersReducedMotion: prefersReducedMotion,
    _Loop: Loop,
    _Scene3D: Scene3D
  };
})();

/* =====================================================================
 * THE BOOK (#book) — a real 6x9 volume you can turn over.
 * ===================================================================== */
(function () {
  'use strict';
  var H = window.HIA3D;
  if (!H) return;

  var BW = 6.0, BH = 9.0;

  /* !! PRODUCT CLAIM !! Spine thickness is derived from the real page
     count: T = pages / 2 * 0.0043in for 50lb offset stock. 320pp is a
     PLACEHOLDER. Set PAGE_COUNT from the Amazon listing before launch —
     shipping a guessed thickness misrepresents the physical object. */
  var PAGE_COUNT = 320;
  var BD = Math.max(0.55, Math.min(2.0, (PAGE_COUNT / 2) * 0.0043));

  function cv(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  function drawCoverFit(ctx, img, w, h) {
    var ir = img.naturalWidth / img.naturalHeight, br = w / h, sw, sh, sx, sy;
    if (ir > br) { sh = img.naturalHeight; sw = sh * br; sx = (img.naturalWidth - sw) / 2; sy = 0; }
    else { sw = img.naturalWidth; sh = sw / br; sx = 0; sy = (img.naturalHeight - sh) * 0.04; }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  }

  function fitPx(ctx, text, family, weight, maxW, startPx, spacingRatio) {
    var px = startPx;
    for (;;) {
      ctx.font = weight + ' ' + px + "px '" + family + "', serif";
      var w = 0;
      for (var i = 0; i < text.length; i++) w += ctx.measureText(text[i]).width + px * spacingRatio;
      w -= px * spacingRatio;
      if (w <= maxW || px <= 10) return px;
      px -= 2;
    }
  }

  /* Canvas has no letter-spacing in older engines; track by hand so the
     baked title matches the tracked-out HTML original. */
  function tracked(ctx, text, cxMid, y, spacing, stroke) {
    var total = 0, i;
    for (i = 0; i < text.length; i++) total += ctx.measureText(text[i]).width + spacing;
    total -= spacing;
    var x = cxMid - total / 2;
    for (i = 0; i < text.length; i++) {
      if (stroke) ctx.strokeText(text[i], x, y);
      ctx.fillText(text[i], x, y);
      x += ctx.measureText(text[i]).width + spacing;
    }
  }

  function buildCover(img, mobile) {
    var T = window.THREE;
    var TW = mobile ? 768 : 1024, TH = Math.round(TW * (BH / BW));
    var c = cv(TW, TH), x = c.getContext('2d', { willReadFrequently: false });
    var f = cv(TW >> 1, TH >> 1), fx = f.getContext('2d');

    x.fillStyle = '#EDEBE7'; x.fillRect(0, 0, TW, TH);
    if (img && img.naturalWidth) drawCoverFit(x, img, TW, TH);

    // Taint canary: a tainted canvas throws far more confusingly inside
    // texImage2D later. Fail here, where we can still fall back cleanly.
    x.getImageData(0, 0, 1, 1);

    // foil mask: three reads roughness from .g and metalness from .b
    fx.fillStyle = 'rgb(0,158,0)'; fx.fillRect(0, 0, f.width, f.height); // g=.62 rough, b=0 metal

    var title = 'HERE I AM';
    var tsp = 0.09;
    var px = fitPx(x, title, 'Anton', '400', TW * 0.80, Math.round(TW * 0.15), tsp);
    x.textAlign = 'left'; x.textBaseline = 'alphabetic';
    var ty = TH * 0.132;
    var g = x.createLinearGradient(TW * 0.1, 0, TW * 0.9, 0);
    g.addColorStop(0, '#B08F45'); g.addColorStop(0.45, '#F2E0AE'); g.addColorStop(1, '#B08F45');
    x.lineWidth = Math.max(2, px * 0.028);
    x.strokeStyle = '#4A3A18';
    x.lineJoin = 'round';
    x.fillStyle = g;
    x.shadowColor = 'rgba(38,28,8,0.38)'; x.shadowBlur = px * 0.10; x.shadowOffsetY = px * 0.022;
    tracked(x, title, TW / 2, ty, px * tsp, true);
    x.shadowColor = 'transparent'; x.shadowBlur = 0; x.shadowOffsetY = 0;

    fx.save(); fx.scale(0.5, 0.5);
    fx.font = x.font; fx.textAlign = 'left'; fx.textBaseline = 'alphabetic';
    fx.fillStyle = 'rgb(0,89,130)';            // g=.35 (smooth), b=.51 (half-metal)
    tracked(fx, title, TW / 2, ty, px * tsp, false);
    fx.restore();

    var author = 'RONIQUE MARSHALL';
    var asp = 0.19;
    var apx = fitPx(x, author, 'Cormorant Garamond', '500', TW * 0.74, Math.round(TW * 0.062), asp);
    x.fillStyle = '#4A4036';
    x.shadowColor = 'rgba(255,255,255,0.97)'; x.shadowBlur = apx * 0.55;
    tracked(x, author, TW / 2, TH * 0.945, apx * asp, false);
    tracked(x, author, TW / 2, TH * 0.945, apx * asp, false);
    x.shadowColor = 'transparent'; x.shadowBlur = 0;

    var map = new T.CanvasTexture(c);
    map.colorSpace = T.SRGBColorSpace;
    map.generateMipmaps = false;
    map.minFilter = T.LinearFilter; map.magFilter = T.LinearFilter;
    map.wrapS = map.wrapT = T.ClampToEdgeWrapping;

    var foil = new T.CanvasTexture(f);
    foil.generateMipmaps = false;
    foil.minFilter = T.LinearFilter; foil.magFilter = T.LinearFilter;
    return { map: map, foil: foil };
  }

  function spineTex() {
    var T = window.THREE;
    var c = cv(128, 1024), x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, 128, 0);
    g.addColorStop(0, '#080706'); g.addColorStop(0.45, '#1E1913'); g.addColorStop(1, '#080706');
    x.fillStyle = g; x.fillRect(0, 0, 128, 1024);
    // US trade convention: spine reads TOP-TO-BOTTOM, title at the head.
    x.save(); x.translate(64, 512); x.rotate(Math.PI / 2);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#C0A165'; x.font = "400 56px 'Anton', sans-serif";
    x.fillText('HERE I AM', -150, 2);
    x.fillStyle = '#A79A83'; x.font = "500 34px 'Cormorant Garamond', serif";
    x.fillText('RONIQUE MARSHALL', 235, 0);
    x.restore();
    var t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
  }

  function backTex() {
    var T = window.THREE;
    var c = cv(512, 768), x = c.getContext('2d');
    x.fillStyle = '#15120F'; x.fillRect(0, 0, 512, 768);
    x.textAlign = 'center';
    x.fillStyle = '#C0A165'; x.font = "400 26px 'Anton', sans-serif";
    x.fillText('THE AUTOBIOGRAPHY', 256, 92);
    x.fillStyle = 'rgba(236,229,217,0.80)'; x.font = "500 27px 'Cormorant Garamond', serif";
    var L = ['From survival to purpose.', 'From pain to power.', 'From dream to destiny.'];
    for (var i = 0; i < L.length; i++) x.fillText(L[i], 256, 286 + i * 46);
    x.strokeStyle = 'rgba(192,161,101,0.40)'; x.lineWidth = 2;
    x.strokeRect(176, 556, 160, 118);
    x.fillStyle = 'rgba(192,161,101,0.55)'; x.font = "400 15px 'Anton', sans-serif";
    x.fillText('RONIQUEMARSHALL.COM', 256, 718);
    var t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
  }

  /* Baked page striations. A procedural sin() shader moirés badly on tilt
     and needs the derivatives extension on WebGL1 — this does not. */
  function pageTex() {
    var T = window.THREE;
    var c = cv(64, 8), x = c.getContext('2d');
    for (var i = 0; i < 64; i++) {
      var v = i % 3 === 0 ? '#D8CFBF' : (i % 3 === 1 ? '#F2EDE3' : '#E6DFD1');
      x.fillStyle = v; x.fillRect(i, 0, 1, 8);
    }
    var t = new T.CanvasTexture(c);
    t.colorSpace = T.SRGBColorSpace;
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.repeat.set(26, 1);
    t.magFilter = T.LinearFilter;
    t.minFilter = T.LinearMipmapLinearFilter;   // the edge is ~26px wide
    t.generateMipmaps = true;
    t.anisotropy = 4;
    return t;
  }

  H._BookScene = function (host, loop, img, mobile) {
    var T = window.THREE;
    var s = new H._Scene3D(host, loop, { fov: 32, antialias: !mobile, dprCap: mobile ? 1.75 : 2 });

    var yaw = 0, pitch = 0, tYaw = 0, tPitch = 0;
    var dragging = false, hovering = false, introDone = false;
    var lastX = 0, lastY = 0, pid = null, vel = 0;

    s.build = function () {
      s.renderer.outputColorSpace = T.SRGBColorSpace;
      s.renderer.toneMapping = T.ACESFilmicToneMapping;
      s.renderer.toneMappingExposure = 1.05;

      var ct = buildCover(img, mobile);
      var pages = pageTex();

      var MatCover = (!mobile && T.MeshPhysicalMaterial) ? T.MeshPhysicalMaterial : T.MeshStandardMaterial;
      var front = new MatCover({
        map: ct.map, roughnessMap: ct.foil, metalnessMap: ct.foil,
        roughness: 1.0, metalness: 1.0
      });
      if (MatCover === T.MeshPhysicalMaterial) { front.clearcoat = 0.55; front.clearcoatRoughness = 0.18; }

      var spine = new T.MeshStandardMaterial({ map: spineTex(), roughness: 0.66, metalness: 0.10 });
      var back = new T.MeshStandardMaterial({ map: backTex(), roughness: 0.70, metalness: 0.05 });
      var edge = new T.MeshStandardMaterial({ map: pages, roughness: 0.95, metalness: 0.0 });
      var edgeTB = new T.MeshStandardMaterial({ color: 0xece5d8, roughness: 0.95, metalness: 0.0 });

      // BoxGeometry group order: +X, -X, +Y, -Y, +Z, -Z
      var geo = new T.BoxGeometry(BW, BH, BD);
      s.book = new T.Mesh(geo, [edge, spine, edgeTB, edgeTB, front, back]);
      s.group = new T.Group();
      s.group.add(s.book);
      s.scene.add(s.group);

      // Ambient-dominant: the cover is a near-white studio photo, and a
      // strong key would visibly re-grade her photograph.
      s.scene.add(new T.AmbientLight(0xf7f4ee, 2.0));
      var key = new T.DirectionalLight(0xfff6e2, 1.0); key.position.set(-4, 6, 8); s.scene.add(key);
      var rim = new T.PointLight(0xc0a165, 0.6, 60); rim.position.set(6, -3, -4); s.scene.add(rim);

      s.camera.position.set(0, 0, 20);
      s.camera.lookAt(0, 0, 0);
    };

    s.onResize = function (w, h) {
      var vfov = (s.camera.fov * Math.PI) / 180;
      var byH = (BH * 1.10) / 2 / Math.tan(vfov / 2);
      var hfov = 2 * Math.atan(Math.tan(vfov / 2) * (w / h));
      var byW = (Math.sqrt(BW * BW + BD * BD) * 1.08) / 2 / Math.tan(hfov / 2);
      s.camera.position.z = Math.max(byH, byW);
      s.camera.updateProjectionMatrix();
    };

    /* Render only when there is something to render. */
    s.needsFrame = function () {
      if (!s.ready) return false;
      if (s.dirty || dragging) return true;
      // Hover alone is NOT a reason to draw: a settled, hovered book would
      // otherwise repaint a byte-identical frame at 60fps forever.
      return Math.abs(tYaw - yaw) > 1e-4 || Math.abs(tPitch - pitch) > 1e-4 || Math.abs(vel) > 1e-4;
    };

    // One-time reveal turn, then rest. No perpetual idle animation.
    s.onEnter = function () {
      if (introDone) return;
      introDone = true;
      yaw = -0.62; pitch = 0.10;
      tYaw = -0.30; tPitch = 0.05;
      s.dirty = true;
    };

    host.style.touchAction = 'pan-y';
    host.style.cursor = 'grab';
    host.style.pointerEvents = 'auto';

    function down(e) {
      if (e.button != null && e.button !== 0) return;
      dragging = true; vel = 0;
      lastX = e.clientX; lastY = e.clientY; pid = e.pointerId;
      host.style.cursor = 'grabbing';
      try { host.setPointerCapture(e.pointerId); } catch (err) {}
      loop.kick();
    }
    function move(e) {
      if (!dragging || (pid != null && e.pointerId !== pid)) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      tYaw += dx * 0.0095;
      tPitch = Math.max(-0.5, Math.min(0.5, tPitch - dy * 0.006));
      vel = dx * 0.0095;
      loop.kick();
    }
    function up(e) {
      if (!dragging) return;
      dragging = false; pid = null;
      host.style.cursor = 'grab';
      try { host.releasePointerCapture(e.pointerId); } catch (err) {}
      loop.kick();
    }
    function enter() { hovering = true; }
    function leave() { hovering = false; up({}); }
    function key(e) {
      var st = 0.35;
      if (e.key === 'ArrowLeft') tYaw -= st;
      else if (e.key === 'ArrowRight') tYaw += st;
      else if (e.key === 'ArrowUp') tPitch = Math.max(-0.5, tPitch - 0.15);
      else if (e.key === 'ArrowDown') tPitch = Math.min(0.5, tPitch + 0.15);
      else if (e.key === 'Home') { tYaw = 0; tPitch = 0; }
      else return;
      e.preventDefault(); loop.kick();
    }
    host.addEventListener('pointerdown', down);
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up);
    host.addEventListener('pointercancel', up);
    host.addEventListener('pointerenter', enter);
    host.addEventListener('pointerleave', leave);
    host.addEventListener('keydown', key);
    host.setAttribute('tabindex', '0');
    // role=application is what lets a screen reader pass arrow keys through
    // to a custom widget; role=img would swallow them in browse mode.
    host.setAttribute('role', 'application');
    host.setAttribute('aria-roledescription', '3D book viewer');
    host.setAttribute('aria-label',
      'Three-dimensional view of the book Here I Am by Ronique Marshall. ' +
      'Drag, swipe, or press the arrow keys to turn it and read the back cover. ' +
      'Press Home to face it forward.');

    s.frame = function (dt) {
      s.dirty = false;
      if (!dragging) { tYaw += vel * 5 * dt; vel *= Math.pow(0.015, dt); }
      var k = Math.min(1, dt * 8);
      yaw += (tYaw - yaw) * k;
      pitch += (tPitch - pitch) * k;
      s.group.rotation.y = yaw;
      s.group.rotation.x = pitch;
      s.renderer.render(s.scene, s.camera);
      s.reveal();
    };

    // Hand off from the flat plate only once a real frame exists.
    s.onFirstFrame = function () {
      var box = host.parentNode;
      if (!box || !box.setAttribute) return;
      box.setAttribute('data-hia-on', '');
      // opacity:0 does not remove them from the a11y tree, so the title and
      // byline would be announced twice — once here, once from the 3D label.
      for (var i = 0; i < box.children.length; i++) {
        var c = box.children[i];
        if (c !== host) c.setAttribute('aria-hidden', 'true');
      }
    };

    s.onDispose = function () {
      var box = host.parentNode;
      if (box && box.removeAttribute) {
        box.removeAttribute('data-hia-on');
        for (var i = 0; i < box.children.length; i++) {
          if (box.children[i] !== host) box.children[i].removeAttribute('aria-hidden');
        }
      }
      host.removeEventListener('pointerdown', down);
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up);
      host.removeEventListener('pointercancel', up);
      host.removeEventListener('pointerenter', enter);
      host.removeEventListener('pointerleave', leave);
      host.removeEventListener('keydown', key);
      host.removeAttribute('tabindex');
      host.removeAttribute('role');
      host.removeAttribute('aria-roledescription');
      host.removeAttribute('aria-label');
      host.style.cursor = '';
      host.style.pointerEvents = '';
    };
    return s;
  };
})();

/* =====================================================================
 * HERO GOLD DUST (#top) — one draw call, additive, no lights.
 * Sits at the very back of the header, behind the portrait and the
 * title, so it can never reduce text contrast. Renders only while the
 * hero is actually on screen, which is only ever the top of the page.
 * ===================================================================== */
(function () {
  'use strict';
  var H = window.HIA3D;
  if (!H) return;

  var VERT = [
    'attribute float aSeed;',
    'attribute float aSize;',
    'uniform float uTime;',
    'uniform float uScroll;',
    'uniform vec2  uPointer;',
    'uniform float uPR;',
    'varying float vA;',
    'varying float vS;',
    'void main() {',
    '  vec3 p = position;',
    '  float s = aSeed;',
    '  p.y = mod(p.y + uTime * (0.14 + s * 0.26) + 60.0, 34.0) - 17.0;',
    '  p.x += sin(uTime * (0.18 + s * 0.30) + s * 31.4) * (0.6 + s * 1.0);',
    '  float depth = (p.z + 7.0) / 14.0;',
    '  p.x += uPointer.x * (0.4 + depth * 2.0);',
    '  p.y += uPointer.y * (0.3 + depth * 1.5) - uScroll * (0.8 + depth * 2.2);',
    '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
    '  gl_Position = projectionMatrix * mv;',
    '  gl_PointSize = aSize * uPR * (30.0 / max(-mv.z, 0.001));',
    '  vA = (1.0 - smoothstep(8.0, 17.0, abs(p.y))) * (0.25 + s * 0.5);',
    '  vS = s;',
    '}'
  ].join('\n');

  var FRAG = [
    'precision mediump float;',
    'uniform vec3 uWarm; uniform vec3 uPale; uniform float uOp;',
    'varying float vA; varying float vS;',
    'void main() {',
    '  vec2 d = gl_PointCoord - vec2(0.5);',
    '  float r = dot(d, d);',
    '  if (r > 0.25) discard;',
    '  float core = 1.0 - smoothstep(0.0, 0.25, r);',
    '  gl_FragColor = vec4(mix(uWarm, uPale, vS), core * core * vA * uOp);',
    // three injects linearToOutputTexel() into the prefix but only CALLS it via
    // this chunk, which built-in materials include and a user ShaderMaterial
    // does not. Without it the linear uniforms hit the sRGB buffer raw and
    // #C0A165 displays as roughly #875B21.
    '  #include <colorspace_fragment>',
    '}'
  ].join('\n');

  H._DustScene = function (host, loop, N, mobile) {
    var T = window.THREE;
    var s = new H._Scene3D(host, loop, { fov: 46, dprCap: mobile ? 1.5 : 1.75 });
    var uni, onPointer, px = 0, py = 0, tx = 0, ty = 0;

    s.build = function () {
      var pos = new Float32Array(N * 3), seed = new Float32Array(N), size = new Float32Array(N);
      // Deterministic scatter (no Math.random) so the field is identical on
      // every load and screenshot diffs stay meaningful.
      for (var i = 0; i < N; i++) {
        var a = i * 2.399963229728653, rr = Math.sqrt((i + 0.5) / N);
        pos[i * 3] = Math.cos(a) * rr * 15.0;
        pos[i * 3 + 1] = (((i * 7919) % 1000) / 1000) * 34.0 - 17.0;
        pos[i * 3 + 2] = ((((i * 6271) % 1000) / 1000) * 2.0 - 1.0) * 7.0;
        seed[i] = ((i * 4271) % 1000) / 1000;
        size[i] = 1.0 + (((i * 2903) % 1000) / 1000) * 3.0;
      }
      var geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      geo.setAttribute('aSeed', new T.BufferAttribute(seed, 1));
      geo.setAttribute('aSize', new T.BufferAttribute(size, 1));
      uni = {
        uTime: { value: 0 }, uScroll: { value: 0 },
        uPointer: { value: new T.Vector2(0, 0) }, uPR: { value: s.dpr() },
        uWarm: { value: new T.Color(0xc0a165) }, uPale: { value: new T.Color(0xf2e0ae) },
        uOp: { value: 0 }
      };
      var mat = new T.ShaderMaterial({
        uniforms: uni, vertexShader: VERT, fragmentShader: FRAG,
        transparent: true, depthWrite: false, depthTest: false, blending: T.AdditiveBlending
      });
      var pts = new T.Points(geo, mat);
      pts.frustumCulled = false;
      s.scene.add(pts);
      s.camera.position.set(0, 0, 18);

      onPointer = function (e) {
        tx = (e.clientX / window.innerWidth - 0.5) * 2;
        ty = -(e.clientY / window.innerHeight - 0.5) * 2;
      };
      window.addEventListener('pointermove', onPointer, { passive: true });
    };

    s.onResize = function () { if (uni) uni.uPR.value = s.dpr(); };
    s.needsFrame = function () { return s.ready; };

    s.frame = function (dt, t) {
      uni.uTime.value = t;
      px += (tx - px) * Math.min(1, dt * 2.0);
      py += (ty - py) * Math.min(1, dt * 2.0);
      uni.uPointer.value.set(px * 0.8, py * 0.5);
      var r = host.getBoundingClientRect();
      uni.uScroll.value = (Math.max(0, -r.top) / Math.max(1, r.height)) * 3.0;
      if (uni.uOp.value < 1) uni.uOp.value = Math.min(1, uni.uOp.value + dt * 0.7);
      s.renderer.render(s.scene, s.camera);
      s.reveal();
    };

    s.onDispose = function () { if (onPointer) window.removeEventListener('pointermove', onPointer); };
    return s;
  };
})();

/* ===================== bootstrap ===================== */
(function () {
  'use strict';
  var H = window.HIA3D;
  if (!H) return;
  var loop = null, scenes = [];

  function decoded(img) {
    return new Promise(function (res) {
      if (!img) return res(null);
      var done = function () { res(img.naturalWidth ? img : null); };
      if (img.complete && img.naturalWidth) {
        if (img.decode) img.decode().then(done, done); else done();
        return;
      }
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', function () { res(null); }, { once: true });
      setTimeout(done, 3000);
    });
  }

  /* The baked cover must use the real faces. If they are not ready in
     1.5s we abort and leave the DOM cover alone rather than bake Times. */
  function fontsReady() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve(true);
    var want = ["400 96px 'Anton'", "500 48px 'Cormorant Garamond'"];
    var race = Promise.all(want.map(function (f) { return document.fonts.load(f); }))
      .then(function () {
        return document.fonts.check("400 96px 'Anton'") &&
               document.fonts.check("500 48px 'Cormorant Garamond'");
      })
      .catch(function () { return false; });
    var timeout = new Promise(function (r) { setTimeout(function () { r(false); }, 1500); });
    return Promise.race([race, timeout]);
  }

  H.init = function () {
    if (loop || !window.THREE || H.prefersReducedMotion()) return;
    loop = new H._Loop();
    // Coarse pointer alone is not mobile (touchscreen laptops); require a
    // genuinely small viewport too.
    var mobile = Math.min(window.innerWidth, window.innerHeight) < 700 ||
                 (window.innerWidth < 900 && window.matchMedia &&
                  window.matchMedia('(pointer: coarse)').matches);

    var heroHost = document.querySelector('[data-hia-host="hero"]');
    if (heroHost) {
      try {
        var d = H._DustScene(heroHost, loop, mobile ? 480 : 1200, mobile);
        scenes.push(d); loop.add(d);
      } catch (e) { if (window.console) console.warn('[hia-3d] dust skipped:', e); }
    }

    var bookHost = document.querySelector('[data-hia-host="book"]');
    if (!bookHost) return;
    var cover = bookHost.parentNode ? bookHost.parentNode.querySelector('img') : null;
    Promise.all([decoded(cover), fontsReady()]).then(function (r) {
      if (!r[1]) { if (window.console) console.warn('[hia-3d] webfonts not ready; keeping flat cover'); return; }
      // Without the real cover photo the 3D book would show a blank beige
      // plate — strictly worse than the flat artwork already on screen.
      if (!r[0]) { if (window.console) console.warn('[hia-3d] cover image unavailable; keeping flat cover'); return; }
      if (!loop) return;                      // disposed during the await
      try {
        var b = H._BookScene(bookHost, loop, r[0], mobile);
        scenes.push(b); loop.add(b);
      } catch (e) { if (window.console) console.warn('[hia-3d] book skipped:', e); }
    });
  };

  var pauses = 0;
  H.pause = function (p) {
    pauses = Math.max(0, pauses + (p ? 1 : -1));
    if (loop) loop.setPaused(pauses > 0);
  };
  H.dispose = function () {
    for (var i = 0; i < scenes.length; i++) { try { scenes[i].dispose(); } catch (e) {} }
    scenes = [];
    if (loop) { loop.stop(); loop = null; }
  };
})();
