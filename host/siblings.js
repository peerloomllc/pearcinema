// The episode on either side, walked over the WHOLE show rather than one season.
//
// This lives on its own because two surfaces need the same answer and neither
// should re-derive it: the phone asks over the wire (`library.siblings`) and the
// dashboard asks over HTTP (`GET /api/siblings`). A second copy of the walk is a
// second copy of the season-boundary rule, which is the only interesting part of
// it - the last episode of season one is followed by the first of season two,
// because that is what "next" means to a person.
//
// This is NOT watch.nextEpisode. That rule serves the up-next shelf and skips
// everything already watched; a person paging through a season they are
// rewatching wants the neighbour, watched or not.
//
// Anything that is not an episode answers with two nulls rather than an error, so
// a caller can ask about whatever is playing without branching.

async function siblings (adapter, id) {
  const ep = await adapter.get({ id: String(id) })
  if (!ep) return null
  if (ep.type !== 'episode' || !ep.seriesId) return { prev: null, next: null }

  const seasons = (await adapter.list({ type: 'seasons', seriesId: ep.seriesId, limit: 500 })).items || []
  const all = []
  for (const s of seasons) {
    const page = await adapter.list({ type: 'episodes', seasonId: s.id, limit: 1000 })
    all.push(...(page.items || []))
  }
  const at = all.findIndex((e) => e.id === ep.id)
  if (at < 0) return { prev: null, next: null }
  return { prev: all[at - 1] || null, next: all[at + 1] || null }
}

module.exports = { siblings }
