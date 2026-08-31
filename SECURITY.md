# Security

PearCinema plays films from a computer you own, to devices you have let in. That
means a program on your machine accepts connections from the internet, reads your
files and runs ffmpeg on them. This page says what protects what, so you do not have
to read the code to find out.

## Reporting a problem

Email **peerloomllc@proton.me**. If it is a real vulnerability, please give us a
chance to ship a fix before you publish it. There is no bounty. There is a thank you
in the release notes if you want one.

MIT licensed and developed in the open, so anything claimed here can be checked:
<https://github.com/peerloomllc/pearcinema>

## What an attacker would be trying to reach

The **host** is the interesting target. It runs on the machine holding your films,
it is reachable over the internet by design, and it can read your library. The phone
app matters less: it holds no library and no keys worth stealing beyond its own.

## The boundaries that hold this up

### A stranger cannot make the host do anything

The host is found by key, not by an address, and every connection is encrypted and
authenticated by the Noise handshake before a single byte of ours is read. An
unknown key is refused at the firewall, and refused *again* when it tries to open
the media channel, because the first refusal has a deliberate exemption while a
pairing window is open and the second does not. A connection without a grant has no
method table at all, so there is nothing to call.

If an error is thrown while deciding, the connection is denied. Failing closed is
the rule everywhere in this path.

### ffmpeg is never handed to a shell

Every ffmpeg and ffprobe run is `spawn(binary, [arguments])`, with the arguments as
separate array entries. There is no `shell: true`, no `exec`, and no command built by
joining strings anywhere in the host. A film called
`Amelie; rm -rf $HOME/"quoted" & (1998).mkv` is one argument, and there is a test
that says so.

Everything a phone gets to influence is forced into a safe shape first. Quality caps
and channel counts become numbers, seek positions become numbers, the seek index is
bounds-checked against the plan that produced it, and the colour tone is matched
against a fixed list of two. A subtitle to burn in is resolved to an integer stream
index of a file we already opened, never a string we were handed.

### An id is not a path

Films, posters and subtitles are named on the wire by a one-way hash. The host looks
that hash up in a table built while scanning your library. A hash that is not in the
table gets nothing, and there is no fallback that treats it as a filename. The path
that comes back out of the table is then re-checked to be inside a configured library
root before anything opens it. `../../../../etc/passwd` is not a special case, it is
simply not in the table.

Folder browsing on the dashboard, which does take a path, refuses anything that
resolves outside a root you configured and lists directory names only.

### Access is revocable, and revoking is immediate

The list of who may connect lives only on the host and is never replicated to any
device. Revoking cuts live connections rather than waiting for the next one, and it
also stops a television that the revoked device had started, because a cast is not a
connection we could close from our end. The cast server re-reads the grant on every
fetch for exactly this reason.

### The dashboard is not exposed by accident

The web dashboard can revoke devices, open pairing windows and stream your films, so
the host refuses to start if it is told to listen on anything but loopback without a
password. That is a startup failure, not a warning in a log. Where a password is set,
sessions are compared in constant time, there is a lockout after five failures, and
the cookie is `HttpOnly; SameSite=Strict`.

Where there is no password, which is how the desktop app runs it on loopback, the
dashboard checks the `Host` and `Origin` headers of every request instead, so that a
web page you happen to visit cannot drive it and DNS rebinding cannot read from it.

### Nothing runs code that arrived over the network

There is no `eval` and no `new Function` in the host, the dashboard, the phone app or
the desktop app. The phone's background engine is a bundle shipped inside the app, not
downloaded. The phone's interface is a page shipped inside the app, served over
loopback, and Android is configured to refuse cleartext to anything except that
loopback address. The desktop app has no browser window at all, so the usual Electron
questions about `nodeIntegration` do not arise. There is no plugin system and no
update mechanism that downloads and runs anything.

### The relay cannot read your films

When a direct connection cannot be made, traffic can fall back to a relay. It
forwards data that is already encrypted end to end. It can see that a device is
talking to a host and how much data moved. It cannot see what is in it and keeps no
copy. You can turn it off, or point the app at a relay you run.

## What is genuinely trusted, and what is not

**Trusted:** the person running the host, and the machine it runs on. Anyone who can
edit files in your library folder, or run programs on that machine, is already past
everything described here.

**Semi-trusted:** a device you have paired. It can ask for anything it has been
granted and nothing else, its access can be narrowed to particular folders, and it
can be cut off in seconds. It cannot reach files outside the library, cannot make the
host run a command and cannot see the grant store.

**Not trusted:** everybody else, including the relay, and including any device that
has been revoked.

## Known residual risk

Being honest about what is not covered:

- **ffmpeg parses your media.** A malicious video file could in principle exploit a
  bug in ffmpeg itself. This only matters for files already inside the library folder
  you configured, so it needs someone who can write there, and that person is past
  the boundary anyway.
- **A cast link travels over plain HTTP on your LAN.** Televisions fetch the video
  themselves and will not do TLS with a self-signed certificate, so the link carries
  a 256-bit random token with a four-hour life instead. Someone already on your wifi
  who captures that link can watch that one film.
- **Symbolic links inside a library root are followed.** If you link a folder into
  your library, its contents are in your library.
- **The phone's loopback helper is not authenticated.** Another app on the same phone
  that guessed its random port could read the library that phone can see.

## Things people ask that turn out not to apply

- **"Is there a VPN in it?"** No. No `NetworkExtension` API, no VPN entitlement, no
  tunnel, and no traffic but its own passes through the app. The direct encrypted
  connection between your phone and your own server is what scanners sometimes
  mistake for one.
- **"Does it phone home?"** There are no accounts, no analytics and no server of
  ours in the path of anything except the optional relay described above.
