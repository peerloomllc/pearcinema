// The icon set.
//
// EMOJI WERE PLACEHOLDERS AND THEY LOOKED LIKE PLACEHOLDERS. Every platform draws its
// own, in its own colours, at its own weight - so a page that mixes them with real
// interface reads as half-finished, and the one thing a control plane for somebody's
// film collection should not look like is half-finished.
//
// Inline SVG, `currentColor`, one stroke weight. Inline rather than a font or a sprite
// because the dashboard is a single self-contained HTML file by design (see
// host/ui/server.js) and an icon font is a second asset to serve and a flash of nothing
// while it loads.
//
// The whole set is deliberately small. An icon that has to be explained is worse than
// the word it replaced, so anything ambiguous stays as text.

const S = ({ children, size = 18, fill = 'none', ...rest }) => (
  <svg
    viewBox='0 0 24 24'
    width={size}
    height={size}
    fill={fill}
    stroke='currentColor'
    stroke-width='1.7'
    stroke-linecap='round'
    stroke-linejoin='round'
    aria-hidden='true'
    focusable='false'
    {...rest}
  >{children}</svg>
)

// THE MARK. A pear, with a film frame's perforations down its side - the suite's fruit
// and this app's medium in one shape, at a size where it still reads at 20px. Drawn
// rather than borrowed: PearTune's mark is PearTune's, and a companion app that wears
// it would be claiming to be the same app.
export const Mark = ({ size = 22 }) => (
  <svg viewBox='0 0 24 24' width={size} height={size} aria-hidden='true' focusable='false'>
    <path
      d='M13.6 6.2c2.4 1 4 3.4 4 6.2 0 3.9-2.9 7.1-6.3 7.1S5 16.3 5 12.4c0-2.6 1.4-4.9 3.5-6'
      fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round'
    />
    <path d='M11.3 6.4c0-1.9.9-3.4 2.6-4.2' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' />
    <g fill='currentColor'>
      <rect x='8.1' y='10.2' width='1.6' height='1.6' rx='.4' />
      <rect x='8.1' y='13.4' width='1.6' height='1.6' rx='.4' />
      <rect x='12.8' y='10.2' width='1.6' height='1.6' rx='.4' />
      <rect x='12.8' y='13.4' width='1.6' height='1.6' rx='.4' />
    </g>
  </svg>
)

// --- what a thing IS ---------------------------------------------------------
// These three stand in where a film has no artwork on disk, which on a hand-built
// library is most of it. They have to be distinguishable at a glance and at poster
// size, because a grid of them is the whole screen.

export const Film = (p) => (
  <S {...p}>
    <rect x='3' y='4' width='18' height='16' rx='2' />
    <path d='M7 4v16M17 4v16M3 12h18' />
    <path d='M3 8h4M3 16h4M17 8h4M17 16h4' />
  </S>
)

export const Tv = (p) => (
  <S {...p}>
    <rect x='2.5' y='7' width='19' height='13' rx='2' />
    <path d='m8 3 4 4 4-4' />
  </S>
)

export const Frames = (p) => (
  <S {...p}>
    <rect x='2.5' y='6' width='19' height='12' rx='2' />
    <path d='M2.5 10h19M2.5 14h19M8 6v12M16 6v12' />
  </S>
)

// --- doing things ------------------------------------------------------------

export const Search = (p) => (
  <S {...p}><circle cx='11' cy='11' r='7' /><path d='m20 20-3.6-3.6' /></S>
)

export const Close = (p) => <S {...p}><path d='M6 6l12 12M18 6L6 18' /></S>

export const Check = (p) => <S {...p}><path d='m4.5 12.5 5 5 10-11' /></S>

export const Play = (p) => <S {...p} fill='currentColor' stroke='none'><path d='M8 5.5v13l11-6.5z' /></S>

export const Folder = (p) => (
  <S {...p}><path d='M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' /></S>
)

export const Drive = (p) => (
  <S {...p}><rect x='3' y='5' width='18' height='14' rx='2' /><path d='M3 12h18' /><circle cx='7.5' cy='15.6' r='.9' fill='currentColor' stroke='none' /></S>
)

export const Server = (p) => (
  <S {...p}><rect x='3' y='4' width='18' height='7' rx='2' /><rect x='3' y='13' width='18' height='7' rx='2' /><path d='M7 7.5h.01M7 16.5h.01' /></S>
)

export const Blocked = (p) => <S {...p}><circle cx='12' cy='12' r='8.5' /><path d='m6.2 6.2 11.6 11.6' /></S>

export const List = (p) => <S {...p}><path d='M4 7h16M4 12h16M4 17h16' /></S>

export const Grid = (p) => (
  <S {...p}><rect x='4' y='4' width='7' height='7' rx='1.4' /><rect x='13' y='4' width='7' height='7' rx='1.4' /><rect x='4' y='13' width='7' height='7' rx='1.4' /><rect x='13' y='13' width='7' height='7' rx='1.4' /></S>
)

export const Volume = (p) => (
  <S {...p}><path d='M4 9.5h3.5L12 5.5v13L7.5 14.5H4z' /><path d='M15.5 9.2a4 4 0 0 1 0 5.6' /><path d='M18 6.8a7.5 7.5 0 0 1 0 10.4' /></S>
)

export const Muted = (p) => (
  <S {...p}><path d='M4 9.5h3.5L12 5.5v13L7.5 14.5H4z' /><path d='m16 10 4.5 4.5M20.5 10 16 14.5' /></S>
)

export const Captions = (p) => (
  <S {...p}><rect x='3' y='5.5' width='18' height='13' rx='2.5' /><path d='M10 10.5a2.5 2.5 0 1 0 0 3M17 10.5a2.5 2.5 0 1 0 0 3' /></S>
)

export const ChevronDown = (p) => <S {...p}><path d='m6 9.5 6 6 6-6' /></S>
export const ChevronUp = (p) => <S {...p}><path d='m6 14.5 6-6 6 6' /></S>
export const ChevronRight = (p) => <S {...p}><path d='m9.5 6 6 6-6 6' /></S>

// The stand-in for an item with no artwork, picked from what the item IS.
export function ArtIcon ({ type, size = 34 }) {
  if (type === 'series') return <Tv size={size} />
  if (type === 'episode' || type === 'season') return <Frames size={size} />
  return <Film size={size} />
}

export const Download = (p) => (
  <S {...p}><path d='M12 4v10m0 0-4-4m4 4 4-4M5 18.5h14' /></S>
)

export const Trash = (p) => (
  <S {...p}><path d='M5 7h14M9.5 7V5h5v2M7 7l1 12.5h8L17 7M10 10.5v6M14 10.5v6' /></S>
)

// Hiding a cast target and offering it again. An eye, and the same eye struck
// through - the one pairing people read without a caption, which matters
// because these two replace the words that used to say it.
export const Eye = (p) => (
  <S {...p}><path d='M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z' /><circle cx='12' cy='12' r='3' /></S>
)

export const EyeOff = (p) => (
  <S {...p}><path d='M4 4l16 16' /><path d='M9.9 5.9A9.6 9.6 0 0 1 12 5.8c6 0 9.5 6.2 9.5 6.2a17 17 0 0 1-3.3 3.9' /><path d='M6.6 7.9A16.7 16.7 0 0 0 2.5 12S6 18.2 12 18.2a9.7 9.7 0 0 0 3.6-.7' /><path d='M10.6 10.7a3 3 0 0 0 3.9 4' /></S>
)

export const Pencil = (p) => (
  <S {...p}><path d='M4.5 19.5l.9-3.6L15.9 5.4a1.5 1.5 0 0 1 2.1 0l.6.6a1.5 1.5 0 0 1 0 2.1L8.1 18.6l-3.6.9z' /><path d='M14.5 6.8l2.7 2.7' /></S>
)

export const Info = (p) => (
  <S {...p}><circle cx='12' cy='12' r='8.5' /><path d='M12 11v5.5' /><path d='M12 7.8h.01' /></S>
)

export const Pause = (p) => (
  <S {...p} fill='currentColor' stroke='none'>
    <rect x='7' y='5' width='3.6' height='14' rx='1.1' />
    <rect x='13.4' y='5' width='3.6' height='14' rx='1.1' />
  </S>
)

// Ten seconds either way. An arrow curling back over a "10" - the shape every player
// uses, and the one people reach for without reading it.
export const Back10 = (p) => (
  <S {...p}>
    <path d='M11.5 5.5 8 8.6l3.5 3' />
    <path d='M8.2 8.6H13a6 6 0 1 1-6 6' />
    <text x='12' y='17.6' font-size='7' font-weight='700' text-anchor='middle' fill='currentColor' stroke='none'>10</text>
  </S>
)

export const Forward10 = (p) => (
  <S {...p}>
    <path d='M12.5 5.5 16 8.6l-3.5 3' />
    <path d='M15.8 8.6H11a6 6 0 1 0 6 6' />
    <text x='12' y='17.6' font-size='7' font-weight='700' text-anchor='middle' fill='currentColor' stroke='none'>10</text>
  </S>
)

export const Gear = (p) => (
  <S {...p}>
    <circle cx='12' cy='12' r='3.1' />
    <path d='M19.4 14.6a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z' />
  </S>
)

export const Sun = (p) => (
  <S {...p}>
    <circle cx='12' cy='12' r='4' />
    <path d='M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4' />
  </S>
)

export const Moon = (p) => (
  <S {...p}><path d='M20 14.2A8.2 8.2 0 0 1 9.8 4 8.2 8.2 0 1 0 20 14.2z' /></S>
)

export const People = (p) => (
  <S {...p}>
    <circle cx='9' cy='8.5' r='3.2' />
    <path d='M3.5 19.5a5.5 5.5 0 0 1 11 0' />
    <path d='M16 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.8a5.5 5.5 0 0 1 3 4.7' />
  </S>
)

// HOME, on the far left, where a logo would be. The pear is the brand and the brand is
// not a control - "click the name to go back" is a thing you have to be told, which is
// the definition of the wrong affordance (Tim, 2026-08-13). The pear keeps the login
// page and the app icon, where it is a mark rather than a button.
export const Home = (p) => (
  <S {...p}><path d='M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-5.5H9V20H5a1 1 0 0 1-1-1z' /></S>
)

// A circle with a gap, spun by CSS. The phone's connecting screen uses the same shape
// (src/ui: ArrowsClockwise under .spin), and a dashboard that is waiting for the same
// kind of answer should not say so a different way.
export const Spinner = (p) => (
  <S {...p}><path d='M12 3.5a8.5 8.5 0 1 0 8.5 8.5' /></S>
)

// A BELL, for somebody waiting on an answer. Deliberately not the People mark, which
// already means "who can get in" in the same bar - two lights with the same glyph and
// different meanings is worse than no light at all (Tim, 2026-08-19).
export const Bell = (p) => (
  <S {...p}><path d='M18 9.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5z' /><path d='M13.7 19.5a2 2 0 0 1-3.4 0' /></S>
)
