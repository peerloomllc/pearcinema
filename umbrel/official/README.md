# The official Umbrel App Store submission

These three files are what a pull request to
[getumbrel/umbrel-apps](https://github.com/getumbrel/umbrel-apps) contains, in a
directory named `pearcinema/`. They are NOT the community store listing - that is
`umbrel/` one level up, and the two differ in ways the store's own linter enforces.

## What differs from the community listing, and why

| | `umbrel/` (community) | `umbrel/official/` |
| --- | --- | --- |
| `id` | `peerloom-pearcinema` - a community store prefixes every id with its own | `pearcinema` - bare, and it must equal the directory name |
| `icon` | a URL in the manifest | **omitted.** Umbrel hosts the icon themselves, in `getumbrel/umbrel-apps-gallery`, and add it before merge |
| `gallery` | may carry image URLs | `[]` for a new submission, for the same reason |
| `releaseNotes` | the notes umbrelOS shows on an update | `""` - a hard lint ERROR if set on a new app, because there is no previous version for notes to describe |
| `website` | `peerloomllc.com` | the app's own page, which is what the listing links to |
| `permissions` | not required | `STORAGE_DOWNLOADS` and `GPU`, the only two values the linter accepts |

Everything else - the description, the tagline, the port, the image digest, the
whole compose file - is the same content, and a test keeps it that way.

## Do not commit images here

The store's own guidance: "Do not commit screenshots, gallery assets, or icon
assets for official App Store submissions; the Umbrel team will create and host
final App Store assets."

## Checking it before submitting

The store repo ships its own linter, and running it locally is the difference
between a PR that gets looked at and one that sits red. PearTune's submission sat
red for 27 days on a single field nobody had run a check against:

```
git clone --depth 1 https://github.com/getumbrel/umbrel-apps && cd umbrel-apps && npm install && mkdir -p pearcinema && cp -r ../pearcinema/umbrel/official/. pearcinema/ && rm pearcinema/README.md && node .tools/lint-apps.mjs pearcinema --check-images
```

Last run: **0 errors, 3 warnings** - host networking, mapped devices and security
options. All three are the "justify this in the PR" kind rather than faults, and
each is justified in the compose file's own comments. Carry those justifications
into the PR body; that is what the warning is asking for.

## The one field that cannot be right until the PR exists

`submission:` is meant to be the pull request's own URL, which does not exist
until the PR is opened. It points at the repo for now, which passes the linter -
PearTune's did the same. Update it to the PR URL in the first follow-up commit.
