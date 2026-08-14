// The login page. Shown instead of the web interface when a password is set and the
// browser has no session yet.
//
// THIS ONE IS STILL A STRING, and that is deliberate rather than an inconsistency
// with the built Preact page it guards. The dashboard is a string no longer because
// it grew to 700 lines and a syntax error inside it produced a blank control plane;
// this is a form with one field, and shipping the whole application bundle to a
// visitor who has not authenticated yet would be the opposite of the point.
//
// The trap the donor left behind still applies: THIS FILE IS ONE TEMPLATE LITERAL.
// A backtick anywhere in it, comment included, closes the string and the page stops
// parsing. test/dashboard.test.js loads and parses it for exactly that reason.

module.exports = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PearCinema</title>
<style>
  /* THE SAME PALETTE AS THE PAGE BEHIND IT. This is the first thing anybody sees, and
     a login in one set of colours opening onto an app in another reads as two
     different programs - or as a phishing page, which is worse. Copied rather than
     imported because this file must stay standalone: it is served to somebody who has
     not authenticated, so it cannot pull in the dashboard's bundle. */
  :root {
    --bg:#0c0a07; --fg:#f3ede1; --muted:#a2947d; --line:#322a20;
    --card:#191410; --accent:#e6b24e; --danger:#e0705f;
  }
  * { box-sizing:border-box }
  body {
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:radial-gradient(1200px 600px at 50% -12%, rgba(230,178,78,.09) 0%, transparent 60%), var(--bg);
    color:var(--fg);
    font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;
  }
  .box { width:100%; max-width:22rem; padding:2rem; text-align:center }
  h1 { font-size:1.6rem; margin:0 0 .25rem; font-weight:600; letter-spacing:-.01em }
  h1 span { color:var(--accent) }
  h1.brand { display:flex; align-items:center; justify-content:center; gap:.4rem }
  h1.brand svg { color:var(--accent) }
  p.sub { color:var(--muted); font-size:.9rem; margin:0 0 1.5rem }
  input {
    width:100%; padding:.75rem; font:inherit; border-radius:10px;
    border:1px solid var(--line); background:var(--card); color:var(--fg);
  }
  input:focus { outline:2px solid var(--accent); outline-offset:1px }
  button {
    width:100%; margin-top:.6rem; padding:.75rem; font:inherit; font-weight:600;
    border:none; border-radius:10px; background:var(--accent); color:#1c1305; cursor:pointer;
  }
  button:disabled { opacity:.5; cursor:default }
  .err {
    margin-top:.8rem; padding:.6rem .8rem; border-radius:8px; font-size:.85rem;
    background:rgba(224,112,95,.14); border:1px solid rgba(224,112,95,.4);
  }
  .hint { margin-top:1.5rem; color:var(--muted); font-size:.78rem; line-height:1.5 }
</style>
</head>
<body>
  <div class="box">
    <h1 class="brand">
      <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
        <path d="M13.6 6.2c2.4 1 4 3.4 4 6.2 0 3.9-2.9 7.1-6.3 7.1S5 16.3 5 12.4c0-2.6 1.4-4.9 3.5-6"
          fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        <path d="M11.3 6.4c0-1.9.9-3.4 2.6-4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        <g fill="currentColor">
          <rect x="8.1" y="10.2" width="1.6" height="1.6" rx=".4"/>
          <rect x="8.1" y="13.4" width="1.6" height="1.6" rx=".4"/>
          <rect x="12.8" y="10.2" width="1.6" height="1.6" rx=".4"/>
          <rect x="12.8" y="13.4" width="1.6" height="1.6" rx=".4"/>
        </g>
      </svg>
      Pear<span>Cinema</span>
    </h1>
    <p class="sub">This page can play your library and hand out access to it. It wants a password.</p>

    <form id="f">
      <input id="pw" type="password" placeholder="Password" autofocus autocomplete="current-password">
      <button id="go" type="submit">Unlock</button>
    </form>

    <div id="err"></div>

    <p class="hint">
      On Umbrel this is the app password shown next to PearCinema in your app list.
      On a plain Docker or systemd install it is in <code>dashboard-password</code>
      in the data folder, and it was printed the first time the host started.
    </p>
  </div>

<script>
  var f = document.getElementById('f')
  var pw = document.getElementById('pw')
  var go = document.getElementById('go')
  var err = document.getElementById('err')

  f.addEventListener('submit', async function (e) {
    e.preventDefault()
    err.textContent = ''
    err.className = ''
    go.disabled = true
    try {
      var res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: pw.value })
      })
      if (res.ok) { location.reload(); return }
      var body = await res.json().catch(function () { return {} })
      err.className = 'err'
      err.textContent = body.error || 'Wrong password'
    } catch (e2) {
      err.className = 'err'
      err.textContent = 'Could not reach the host'
    }
    go.disabled = false
    pw.select()
  })
</script>
</body>
</html>
`
