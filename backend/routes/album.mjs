import express from 'express'

import { getAlbum, normalizeAlbum } from '../lib/appleApi.mjs'
import { readSettings } from '../lib/settingsStore.mjs'
import { resolveLocalizedArtistName } from '../lib/localizedArtist.mjs'
import { toAppleLanguage } from '../lib/metadataLanguage.mjs'

export const albumRouter = express.Router()

albumRouter.get('/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const settings = await readSettings()
    const storefront = String(
      req.query.storefront || settings.storefront || 'us',
    )
    const reqLang = req.query.language || req.query.l
    const language = reqLang ? toAppleLanguage(reqLang) : (settings.language || 'en-US')
    const raw = await getAlbum({ storefront, id, language })
    const album = normalizeAlbum(raw?.data?.[0])
    if (!album) return res.status(404).json({ error: 'album not found' })

    if (album.artistId) {
      const localizedArtist = await resolveLocalizedArtistName({
        artistId: album.artistId,
        artistName: album.artistName,
        language,
      })
      if (localizedArtist && localizedArtist !== album.artistName) {
        album.artistName = localizedArtist
        for (const t of album.tracks || []) {
          t.artistName = localizedArtist
        }
      }
    }

    res.json({ album, storefront })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})
