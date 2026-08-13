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
  :root {
    --bg:#0e0f13; --fg:#eceef4; --muted:#8b90a0; --line:#262a35;
    --card:#171922; --accent:#6ea8fe; --danger:#e0705f;
  }
  * { box-sizing:border-box }
  body {
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:var(--bg); color:var(--fg);
    font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;
  }
  .box { width:100%; max-width:22rem; padding:2rem; text-align:center }
  h1 { font-size:1.6rem; margin:0 0 .25rem; font-weight:600; letter-spacing:-.01em }
  h1 span { color:var(--accent) }
  p.sub { color:var(--muted); font-size:.9rem; margin:0 0 1.5rem }
  input {
    width:100%; padding:.75rem; font:inherit; border-radius:10px;
    border:1px solid var(--line); background:var(--card); color:var(--fg);
  }
  input:focus { outline:2px solid var(--accent); outline-offset:1px }
  button {
    width:100%; margin-top:.6rem; padding:.75rem; font:inherit; font-weight:600;
    border:none; border-radius:10px; background:var(--accent); color:#0b1220; cursor:pointer;
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
    <h1>Pear<span>Cinema</span></h1>
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
