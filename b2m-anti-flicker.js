/**
 * B2Metric anti-flicker snippet — the source of the inline <head> snippet
 * (docs/web-sdk/anti-flicker.md). The build writes it, minified, to
 * dist/b2m-anti-flicker.min.js; the page pastes that text inline, as the
 * first script in <head>. It is NOT part of the SDK bundle and must stay
 * dependency-free ES5: it runs before anything else on the page.
 *
 * Why it exists: the SDK is loaded with async / defer (or by a tag manager),
 * so the page paints its original content before the SDK can apply a
 * variant — the visitor sees the original flash and then change. The SDK's
 * own early hide (core/visual/anti-flicker.js) starts too late for that.
 * This snippet hides what an experiment may change from the very first
 * paint and waits for the SDK to call `b2mAntiFlicker.done()`.
 *
 * What it hides — elements, never the page (unless asked to):
 *   - `rules` — what the page itself says about its experiments: per
 *     experiment, the compiled URL targets and every selector a group may
 *     change (generated: `node tools/anti-flicker-snippet.js --experiments …`).
 *     With them a FIRST visit already hides exactly those elements, on
 *     exactly the pages the experiment runs on, and nothing anywhere else.
 *   - returning visitor — the SDK left a manifest in localStorage (`b2m_af`)
 *     with what it decided for THIS visitor: per experiment, the selectors
 *     that can still change for them (their own group's; none for the
 *     control group or a visitor who is not in the experiment). It replaces
 *     the rule of every experiment it knows (`k`); a rule the manifest has
 *     not seen yet — an experiment added since — still applies.
 *   - no rules and no manifest — nothing is known: `firstVisit` decides.
 *     'off' (default) hides nothing, a selector list hides those elements,
 *     'page' hides the whole page (`html{opacity:0}`); `urls` limits that to
 *     the pages experiments run on.
 *
 * Fail-open, always: after `timeout` ms the page is shown no matter what; an
 * error anywhere in here shows it at once; the visual editor and preview are
 * never hidden.
 *
 * Options (the object passed at the bottom):
 *   timeout     ms before everything is shown regardless          (3000)
 *   rules       [{ id, n, x, s }] — experiment id, include / exclude URL
 *               targets as [subject, regex source, flags], selectors
 *   firstVisit  'off' | '<css selector list>' | 'page'            ('off')
 *   urls        regular expressions (source strings) of the pages
 *               `firstVisit` applies to; omitted = every page
 *   maxAge      ms a manifest is trusted                          (1800000)
 *   nonce       CSP nonce for the injected <style>
 *
 * API: window.b2mAntiFlicker = { v, at, mode, hidden, released, ms, rules, done(reason) }
 */
(function (w, d, o) {
  var NAME = 'b2mAntiFlicker';
  if (w[NAME]) return;
  o = o || {};
  var api = w[NAME] = { v: 1, at: +new Date(), mode: '', hidden: '', released: '', done: done };
  var style = null;
  var timer = null;

  function done(reason) {
    if (api.released) return;
    api.released = reason || 'done';
    api.ms = +new Date() - api.at;
    if (timer) clearTimeout(timer);
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }

  // Compiled URL targets: [subject index, regex source, flags] (url-match.js).
  function matches(entries, subjects) {
    for (var i = 0; entries && i < entries.length; i++) {
      try {
        if (new RegExp(entries[i][1], entries[i][2]).test(subjects[entries[i][0]])) return true;
      } catch (e) { /* a broken entry matches nothing */ }
    }
    return false;
  }

  try {
    var href = String(w.location.href);
    var raw = href.split('#')[0];
    var session = w.sessionStorage;
    // The visual editor and preview show the page while it is being built.
    if (/[?&]b2m_(ve|preview)=/.test(raw) || session.getItem('b2m_ve_session') || session.getItem('b2m_visual_preview')) {
      done('editor');
      return;
    }

    var m = null;
    try { m = JSON.parse(w.localStorage.getItem('b2m_af')); } catch (e) { m = null; }
    var maxAge = o.maxAge >= 0 ? o.maxAge : 1800000;
    var known = m && m.v === 1 && m.r && typeof m.r.length === 'number' && Math.abs(+new Date() - m.t) <= maxAge;
    var rules = o.rules && o.rules.length ? o.rules : [];
    api.rules = rules;
    api.mode = known ? 'selectors' : (rules.length ? 'rules' : 'first-visit');

    var u = new URL(href);
    var path = u.pathname;
    if (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);
    if (path === '/') path = '';
    var subjects = [raw, u.protocol + '//' + u.host + path + u.search, raw.toLowerCase()];
    var selectors = [];
    // Rules that run on this URL; `decided`: experiment ids to leave out.
    var collect = function (list, decided) {
      for (var i = 0; i < list.length; i++) {
        var rule = list[i];
        if (!rule || !rule.s || !rule.s.length) continue;
        if (decided && rule.id && decided.indexOf(rule.id) !== -1) continue;
        if (!matches(rule.x, subjects) && matches(rule.n, subjects)) selectors = selectors.concat(rule.s);
      }
    };
    // What the SDK decided for this visitor…
    if (known) collect(m.r);
    // …and the page's own rules for every experiment it has not decided yet.
    collect(rules, known ? (m.k || []) : null);

    var page = false;
    if (!known) {
      // Nothing is known about this visitor: the explicit first-visit option.
      var first = o.firstVisit;
      var inScope = !o.urls;
      for (var j = 0; !inScope && j < o.urls.length; j++) {
        try { inScope = new RegExp(o.urls[j]).test(raw); } catch (e) { /* skip */ }
      }
      if (first && first !== 'off' && inScope) {
        if (first === 'page') page = true;
        else selectors.push(first);
      }
    }
    var css = '';
    if (page) css = 'html{opacity:0!important}';
    else if (selectors.length) css = selectors.join(',') + '{visibility:hidden!important}';

    if (!css) {
      done('nothing');
      return;
    }
    style = d.createElement('style');
    style.id = 'b2m-af';
    if (o.nonce) style.setAttribute('nonce', o.nonce);
    style.appendChild(d.createTextNode(css));
    (d.head || d.documentElement).appendChild(style);
    api.hidden = css;
    timer = setTimeout(function () { done('timeout'); }, o.timeout > 0 ? o.timeout : 3000);
  } catch (e) {
    done('error');
  }
})(window, document, { timeout: 3000 });
