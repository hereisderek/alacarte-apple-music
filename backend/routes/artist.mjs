import express from 'express'

import { readSettings } from '../lib/settingsStore.mjs'
import { loadArtistCatalogCached } from '../lib/artistCatalogCache.mjs'
import { resolveLocalizedArtistName } from '../lib/localizedArtist.mjs'
import { toAppleLanguage } from '../lib/metadataLanguage.mjs'

export const artistRouter = express.Router()

artistRouter.get('/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const settings = await readSettings()
    const storefront = String(
      req.query.storefront || settings.storefront || 'us',
    )
    const reqLang = req.query.language || req.query.l
    const language = reqLang ? toAppleLanguage(reqLang) : (settings.language || 'en-US')
    const catalog = await loadArtistCatalogCached({
      artistId: id,
      storefront,
      language,
      explicitFilter: settings.explicitFilter || 'explicit',
    })
    if (!catalog?.artist) return res.status(404).json({ error: 'artist not found' })

    const localizedName = await resolveLocalizedArtistName({
      artistId: id,
      artistName: catalog.artist.name,
      language,
    })
    const artist = {
      ...catalog.artist,
      name: localizedName || catalog.artist.name,
    }
    const albums = (catalog.albums || []).map((alb) =>
      alb.artistName === catalog.artist.name
        ? { ...alb, artistName: artist.name }
        : alb,
    )
    res.json({
      artist,
      albums,
      storefront,
    })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})
