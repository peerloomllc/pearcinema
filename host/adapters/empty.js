// The adapter for a host with no source configured yet.
//
// NOT A STUB AND NOT A TEST DOUBLE. A freshly installed host has no source until
// the operator picks one, and it still has to come up, serve its dashboard, and
// let a phone pair - otherwise the operator is locked out of the very screen they
// need in order to configure it. The donor learned this the other way round: a bad
// Navidrome credential used to be fatal at startup.
//
// So this answers every method honestly and emptily, and says WHY through
// `ping()`. "No source configured" and "your source is broken" are different
// sentences and the UI must be able to tell them apart.

const items = require('../items')

class EmptyAdapter {
  constructor ({ libraryId = null, log = () => {} } = {}) {
    this.kind = 'empty'
    this.libraryId = libraryId
    this.log = log
  }

  async ping () {
    return { ok: false, detail: 'no source configured' }
  }

  // Zero leaves, and NOT a throw. A throw means "the source is misconfigured", and
  // there is no source here to misconfigure yet.
  async scan () {
    return 0
  }

  // Accepted and ignored, like every option: there is nothing to report progress on.

  async stats () {
    return { movies: 0, series: 0, seasons: 0, episodes: 0 }
  }

  async list () {
    return items.page([], {})
  }

  async get () {
    return null
  }

  async search () {
    return { items: [] }
  }

  async art () {
    return null
  }

  async stream () {
    return null
  }
}

module.exports = { EmptyAdapter }
