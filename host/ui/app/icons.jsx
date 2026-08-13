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
