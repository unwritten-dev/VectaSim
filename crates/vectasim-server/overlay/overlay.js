// VectaSim overlays: one script for every page (body[data-page] = hud | landing | route | index).
// Reads the WebSocket /api/v1/ws (hello, telemetry 2 Hz, phase, landing, flightSaved, status)
// and reconnects with a growing pause. Only textContent and classes are set – never HTML from
// the data. URL parameters: token (LAN access), scale (font size factor), local=1 (local time
// instead of UTC), preview=1 (sample data, for placing the source in OBS), lang=de|en (the server
// sets <html lang> from it or from the app's language; texts below in TEXT, phases stay English).
// The token is only needed on the first load: the server answers it with an HttpOnly cookie, and
// the script takes it out of the address bar (history, bookmarks) and keeps it for this tab only
// (sessionStorage) for the WebSocket URL and the links on the start page. The start page also gets
// it from the server (<meta name="vectasim-token">, only for a request that sent the token itself
// while LAN access is on), so its copy URLs carry the token after a bookmark load through the cookie too;
// the element is removed right after reading.
(function () {
  "use strict";

  var P = new URLSearchParams(location.search);
  var TOKEN_KEY = "vectasim_token";
  var META = document.querySelector('meta[name="vectasim-token"]');
  var SERVED = META ? META.getAttribute("content") || "" : "";
  if (META && META.parentNode) META.parentNode.removeChild(META);
  var TOKEN = SERVED || P.get("token") || "";
  try {
    if (TOKEN) sessionStorage.setItem(TOKEN_KEY, TOKEN);
    else TOKEN = sessionStorage.getItem(TOKEN_KEY) || "";
  } catch (e) {
    /* storage blocked: the cookie still carries the token */
  }
  if (P.has("token") && window.history && history.replaceState) {
    var rest = new URLSearchParams(location.search);
    rest.delete("token");
    var qs = rest.toString();
    try {
      history.replaceState(history.state, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    } catch (e) {
      /* keep the URL as it is */
    }
  }
  var LOCAL = P.get("local") === "1";
  var PREVIEW = P.get("preview") === "1";
  var scale = parseFloat(P.get("scale") || "1");
  if (!isFinite(scale) || scale <= 0) scale = 1;
  scale = Math.min(4, Math.max(0.25, scale));
  document.documentElement.style.setProperty("--scale", String(scale));

  var PAGE = document.body.getAttribute("data-page") || "";
  var NN = " ";
  var LANG = /^en/i.test(P.get("lang") || document.documentElement.getAttribute("lang") || "") ? "en" : "de";
  document.documentElement.setAttribute("lang", LANG);
  var EN = LANG === "en";
  // like app/src/i18n/number.ts: de "1 500,5" / "−155", en "1,500.5" / "-155"
  var MINUS = EN ? "-" : "−";
  var GROUP = EN ? "," : NN;
  var DECIMAL = EN ? "." : ",";
  var DASH = "–";

  // ---- texts (German = reference) ------------------------------------------------------
  var TEXT = {
    de: {
      "title.index": "VectaSim Overlay & Schnittstelle",
      "h.index": "Overlay & Schnittstelle",
      "title.hud": "VectaSim HUD",
      "title.landing": "VectaSim Landung",
      "aria.hud": "Flugdaten",
      "label.phase": "Phase",
      "label.alt": "Höhe",
      "label.gs": "Geschwindigkeit",
      "sub.vs": "Vertikalgeschwindigkeit",
      "label.hdg": "Kurs",
      "label.rest": "Rest",
      "label.landing": "Landung",
      "label.g": "g-Last",
      "label.rwy": "Piste",
      "label.tdz": "Aufsetzpunkt",
      "label.dist": "Strecke",
      "conn.down": "VectaSim getrennt · verbinde neu …",
      recording: "Aufzeichnung",
      completed: "abgeschlossen",
      landed: "gelandet",
      destUnknown: "Ziel unbekannt",
      etaIn: "in ",
      etaFrom: "ab 50 kt GS",
      "conn.connected": "Simulator verbunden",
      "conn.connecting": "wartet auf Simulator",
      "conn.disconnected": "Simulator getrennt",
      "conn.error": "Verbindungsfehler",
      "src.sim": "Landerate vom Simulator",
      "src.measured": "Landerate gemessen (letzte V/S)",
      stableFrom: "stabil ab ",
      "band.smooth": "sanft",
      "band.normal": "normal",
      "band.firm": "fest",
      "band.hard": "hart",
      "state.connected": "Verbunden",
      "state.connecting": "Verbinde …",
      "state.none": "Keine Verbindung zum Datenstrom",
      streamer: "Streamer-Modus",
      preview: "Vorschau",
    },
    en: {
      "title.index": "VectaSim Overlay & API",
      "h.index": "Overlay & API",
      "title.hud": "VectaSim HUD",
      "title.landing": "VectaSim Landing",
      "aria.hud": "Flight data",
      "label.phase": "Phase",
      "label.alt": "Altitude",
      "label.gs": "Speed",
      "sub.vs": "Vertical speed",
      "label.hdg": "Heading",
      "label.rest": "To go",
      "label.landing": "Landing",
      "label.g": "g-load",
      "label.rwy": "Runway",
      "label.tdz": "Touchdown",
      "label.dist": "Distance",
      "conn.down": "VectaSim disconnected · reconnecting …",
      recording: "Recording",
      completed: "completed",
      landed: "landed",
      destUnknown: "destination unknown",
      etaIn: "in ",
      etaFrom: "from 50 kt GS",
      "conn.connected": "Simulator connected",
      "conn.connecting": "waiting for simulator",
      "conn.disconnected": "Simulator disconnected",
      "conn.error": "Connection error",
      "src.sim": "Landing rate from the simulator",
      "src.measured": "Landing rate measured (last V/S)",
      stableFrom: "stable from ",
      "band.smooth": "smooth",
      "band.normal": "normal",
      "band.firm": "firm",
      "band.hard": "hard",
      "state.connected": "Connected",
      "state.connecting": "Connecting …",
      "state.none": "No connection to the data stream",
      streamer: "Streamer mode",
      preview: "Preview",
    },
  };
  function tx(key) {
    var v = TEXT[LANG][key];
    return v != null ? v : TEXT.de[key] != null ? TEXT.de[key] : key;
  }
  // static texts of the page: [data-t] → textContent, [data-t-aria] → aria-label
  document.querySelectorAll("[data-t]").forEach(function (e) {
    e.textContent = tx(e.getAttribute("data-t"));
  });
  document.querySelectorAll("[data-t-aria]").forEach(function (e) {
    e.setAttribute("aria-label", tx(e.getAttribute("data-t-aria")));
  });
  /** How long the landing card stays (ms). */
  var LANDING_SHOW_MS = 20000;

  var PHASE = {
    preflight: "Preflight",
    pushback: "Pushback",
    taxiOut: "Taxi out",
    takeoff: "Takeoff",
    climb: "Climb",
    cruise: "Cruise",
    descent: "Descent",
    approach: "Approach",
    final: "Final",
    landing: "Landing",
    taxiIn: "Taxi in",
    shutdown: "Shutdown",
  };
  var PHASES = Object.keys(PHASE);

  // ---- formatting (same rules as app/src/format.ts) ---------------------------------
  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }
  function num(n, digits) {
    if (!isNum(n)) return DASH;
    var fixed = Math.abs(n).toFixed(digits || 0);
    var neg = n < 0 && Number(fixed) !== 0;
    var parts = fixed.split(".");
    var grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
    return (neg ? MINUS : "") + grouped + (parts[1] ? DECIMAL + parts[1] : "");
  }
  function withUnit(v, unit) {
    return v === DASH ? DASH : v + NN + unit;
  }
  function signed(n, digits) {
    if (!isNum(n)) return DASH;
    var s = num(n, digits);
    return n > 0 && s !== "0" ? "+" + s : s;
  }
  function p2(n) {
    return (n < 10 ? "0" : "") + n;
  }
  function clock(ms) {
    if (!isNum(ms) || ms <= 0) return DASH;
    var d = new Date(ms);
    return LOCAL ? p2(d.getHours()) + ":" + p2(d.getMinutes()) : p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()) + "z";
  }
  function duration(ms) {
    if (!isNum(ms) || ms < 0) return DASH;
    var total = Math.floor(ms / 60000);
    var h = Math.floor(total / 60);
    var m = total % 60;
    return h > 0 ? h + NN + "h" + NN + p2(m) + NN + "min" : m + NN + "min";
  }
  function altitude(t) {
    if (!t) return DASH;
    if (t.altitudeMslFt > 5000) return "FL" + ("00" + Math.round(t.altitudeMslFt / 100)).slice(-3);
    return withUnit(num(Math.round(t.altitudeMslFt)), "ft");
  }
  function heading(deg) {
    if (!isNum(deg)) return DASH;
    var h = Math.round(((deg % 360) + 360) % 360) || 360;
    return ("00" + h).slice(-3) + "°";
  }
  function fpm(v) {
    return withUnit(signed(Math.round(v)), "fpm");
  }

  // ---- DOM helpers -------------------------------------------------------------------
  function el(field) {
    return document.querySelector('[data-f="' + field + '"]');
  }
  function set(field, text) {
    var e = el(field);
    if (e && e.textContent !== text) e.textContent = text;
  }
  function cls(e, name, on) {
    if (e) e.classList.toggle(name, !!on);
  }

  // ---- state + clock offset to the server (a tablet's clock may be off) ---------------
  var state = { status: null, flight: null, telemetry: null, landing: null };
  var offsetMs = 0;
  function serverNow() {
    return Date.now() + offsetMs;
  }

  // ---- HUD ---------------------------------------------------------------------------
  function renderHud() {
    var t = state.telemetry;
    var f = state.flight;
    set("phase", f ? PHASE[f.phase] || f.phase : DASH);
    set("phase-sub", f && f.state === "active" ? tx("recording") : f && f.state === "completed" ? tx("completed") : state.status ? connectionText(state.status) : "");
    set("alt", altitude(t));
    set("alt-sub", t && !t.onGround && t.altitudeAglFt < 2500 ? "AGL " + withUnit(num(t.altitudeAglFt), "ft") : t ? withUnit(num(Math.round(t.altitudeMslFt)), "ft MSL") : "");
    set("gs", t ? withUnit(num(t.groundSpeedKt), "kt") : DASH);
    set("gs-sub", t ? "IAS " + withUnit(num(t.iasKt), "kt") : "");
    set("vs", t ? fpm(t.verticalSpeedFpm) : DASH);
    var vsWarn = t && (t.verticalSpeedFpm > 4000 || (t.verticalSpeedFpm < -1000 && !t.onGround && t.altitudeAglFt < 2500));
    cls(el("vs"), "warn", vsWarn);
    set("hdg", t ? heading(t.headingMagDeg) : DASH);
    set("hdg-sub", t ? "TRK " + heading(t.headingTrueDeg) + " T" : "");
    var landed = f && f.landingMs;
    set("rest", landed ? tx("landed") : f && isNum(f.remainingNm) ? withUnit(num(f.remainingNm), "nm") : DASH);
    set("rest-sub", f && f.destination ? f.destination : landed ? "" : tx("destUnknown"));
    set("eta", !landed && f && f.etaMs ? clock(f.etaMs) : DASH);
    set("eta-sub", !landed && f && f.etaMs ? tx("etaIn") + duration(f.etaMs - serverNow()) : landed ? "" : tx("etaFrom"));
  }

  function connectionText(s) {
    switch (s.connection) {
      case "connected":
      case "connecting":
      case "disconnected":
      case "error":
        return tx("conn." + s.connection);
      default:
        return "";
    }
  }

  // ---- landing card ------------------------------------------------------------------
  var landingTimer = 0;
  var BANDS = ["smooth", "normal", "firm", "hard"];
  function showLanding(l, forMs) {
    var card = el("card");
    if (!card || !l) return;
    BANDS.forEach(function (b) {
      cls(card, "band-" + b, l.band === b);
    });
    set("rate", fpm(l.landingRateFpm));
    // own label from the band code (bandLabel is in the app's language, not necessarily the page's)
    set("band", BANDS.indexOf(l.band) >= 0 ? tx("band." + l.band) : l.bandLabel || "");
    set("src", l.landingRateSource === "sim" ? tx("src.sim") : tx("src.measured"));
    set("g", withUnit(num(l.peakG, 2), "g"));
    set("bounces", String(l.bounces));
    var rwy = l.airport && l.runway ? l.airport + " " + l.runway : l.airport || DASH;
    set("rwy", rwy);
    var tdz = isNum(l.touchdownDistanceM) ? withUnit(num(Math.round(l.touchdownDistanceM)), "m") + (l.inTouchdownZone ? " · TDZ" : "") : DASH;
    set("tdz", tdz);
    set("stable", isNum(l.stableFromFt) ? tx("stableFrom") + withUnit(num(Math.round(l.stableFromFt)), "ft") : "");
    cls(card, "show", true);
    window.clearTimeout(landingTimer);
    if (forMs !== Infinity) {
      landingTimer = window.setTimeout(function () {
        cls(card, "show", false);
      }, Math.max(0, forMs));
    }
  }

  // ---- route strip -------------------------------------------------------------------
  function renderRoute() {
    var f = state.flight;
    set("dep", f && f.departure ? f.departure : "····");
    set("arr", f && (f.destination || f.arrival) ? f.destination || f.arrival : "····");
    var ac = f && f.aircraft ? [f.aircraft.icaoType, f.aircraft.registration].filter(Boolean).join(" · ") : "";
    set("aircraft", ac || (f && f.aircraft && f.aircraft.title) || DASH);
    set("callsign", f && f.callsign ? f.callsign : "");
    set("block", f ? duration(f.blockTimeMs) : DASH);
    set("dist", f ? withUnit(num(f.distanceNm), "nm") : DASH);
    var i = f ? PHASES.indexOf(f.phase) : -1;
    var bar = el("phasebar");
    if (bar) {
      var marks = bar.children;
      for (var k = 0; k < marks.length; k++) {
        marks[k].className = k < i ? "past" : k === i ? "now" : "";
      }
    }
    set("phasename", f ? PHASE[f.phase] || f.phase : "");
  }

  // ---- start page --------------------------------------------------------------------
  function renderIndex() {
    var base = location.protocol + "//" + location.host;
    // the URLs to copy (OBS on another PC) carry the token; the language switch does not (cookie)
    var q = TOKEN ? "?token=" + encodeURIComponent(TOKEN) : "";
    document.querySelectorAll("[data-switch]").forEach(function (e) {
      e.setAttribute("href", "?lang=" + e.getAttribute("data-switch"));
    });
    document.querySelectorAll("[data-url]").forEach(function (e) {
      var path = e.getAttribute("data-url");
      var url = base + path + q;
      e.textContent = url;
      if (e.tagName === "A") e.setAttribute("href", url);
    });
    var s = state.status;
    set("state", s ? tx("state.connected") + " · " + (s.simName || s.provider || "") + " · " + connectionText(s) + (s.streamerMode ? " · " + tx("streamer") : "") : tx("state.none"));
    cls(el("state"), "ok", !!s);
  }

  function render() {
    if (PAGE === "hud") renderHud();
    else if (PAGE === "route") renderRoute();
    else if (PAGE === "index") renderIndex();
  }

  // ---- stream ------------------------------------------------------------------------
  function onMessage(m) {
    switch (m.type) {
      case "hello":
        state.status = m.status;
        state.flight = m.flight;
        state.telemetry = m.telemetry;
        state.landing = m.landing;
        if (m.status && isNum(m.status.serverTimeMs)) offsetMs = m.status.serverTimeMs - Date.now();
        // joined within 20 s of a touchdown: show the rest of its time
        if (PAGE === "landing" && m.landing && m.landing.live !== false) {
          var age = serverNow() - m.landing.timestampMs;
          if (age >= 0 && age < LANDING_SHOW_MS) showLanding(m.landing, LANDING_SHOW_MS - age);
        }
        break;
      case "telemetry":
        state.telemetry = m.telemetry;
        state.flight = m.flight;
        break;
      case "status":
        state.status = m.status;
        break;
      case "phase":
        if (state.flight) state.flight.phase = m.to;
        break;
      case "landing":
        state.landing = m.landing;
        if (PAGE === "landing") showLanding(m.landing, LANDING_SHOW_MS);
        break;
      case "flightSaved":
        if (state.flight) state.flight.state = m.state;
        break;
    }
    render();
  }

  var retry = 0;
  var DELAYS = [1000, 2000, 5000, 10000];
  function connect() {
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    var url = proto + location.host + "/api/v1/ws" + (TOKEN ? "?token=" + encodeURIComponent(TOKEN) : "");
    var ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      schedule();
      return;
    }
    ws.onopen = function () {
      retry = 0;
      cls(el("conn"), "down", false);
    };
    ws.onmessage = function (ev) {
      try {
        onMessage(JSON.parse(ev.data));
      } catch (e) {
        /* a broken message is skipped */
      }
    };
    ws.onclose = function () {
      cls(el("conn"), "down", true);
      if (PAGE === "index") {
        state.status = null;
        render();
      }
      schedule();
    };
  }
  function schedule() {
    var d = DELAYS[Math.min(retry, DELAYS.length - 1)];
    retry++;
    window.setTimeout(connect, d);
  }

  // ---- preview data (?preview=1) -------------------------------------------------------
  function preview() {
    var now = Date.now();
    state.status = { connection: "connected", provider: "mock", simName: tx("preview"), streamerMode: false, serverTimeMs: now };
    state.flight = {
      state: "active",
      phase: "descent",
      departure: "EDDF",
      destination: "EGLL",
      callsign: "DLH4YA",
      aircraft: { icaoType: "A20N", registration: "D-AINA", title: "Airbus A320neo" },
      blockTimeMs: 4980000,
      distanceNm: 312.4,
      remainingNm: 96.2,
      etaMs: now + 1260000,
    };
    state.telemetry = { altitudeMslFt: 18240, altitudeAglFt: 17900, groundSpeedKt: 412, iasKt: 290, verticalSpeedFpm: -1850, headingMagDeg: 287, headingTrueDeg: 289, onGround: false };
    render();
    if (PAGE === "landing") {
      showLanding(
        { landingRateFpm: -142, landingRateSource: "sim", band: "smooth", bandLabel: tx("band.smooth"), peakG: 1.18, bounces: 0, airport: "EGLL", runway: "27L", touchdownDistanceM: 412, inTouchdownZone: true, stableFromFt: 1000 },
        Infinity,
      );
    }
  }

  // the flight clocks (block time, ETA countdown) move between telemetry messages too
  window.setInterval(function () {
    if (PAGE === "hud" || PAGE === "route") render();
  }, 1000);

  if (PREVIEW) preview();
  else {
    render();
    connect();
  }
})();
