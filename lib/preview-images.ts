import ky from 'ky'
import {
  type ExtendedRecordMap,
  type PreviewImage,
  type PreviewImageMap
} from 'notion-types'
import { getPageImageUrls, normalizeUrl } from 'notion-utils'
import pMap from 'p-map'
import pMemoize from 'p-memoize'

import { defaultPageCover, defaultPageIcon } from './config'
import { db } from './db'
import { mapImageUrl } from './map-image-url'

// Only import lqip-modern if not in Cloudflare environment
let lqip: any = null
if (typeof process !== 'undefined' && !process.env.CLOUDFLARE && !process.env.NEXT_RUNTIME) {
  try {
    // Dynamic import to avoid issues with Cloudflare
    lqip = await import('lqip-modern').then(module => module.default)
  } catch (err) {
    console.warn('Failed to import lqip-modern', err)
  }
}

export async function getPreviewImageMap(
  recordMap: ExtendedRecordMap
): Promise<PreviewImageMap> {
  const urls: string[] = getPageImageUrls(recordMap, {
    mapImageUrl
  })
    .concat([defaultPageIcon, defaultPageCover])
    .filter(Boolean)

  const previewImagesMap = Object.fromEntries(
    await pMap(
      urls,
      async (url) => {
        const cacheKey = normalizeUrl(url)
        return [cacheKey, await getPreviewImage(url, { cacheKey })]
      },
      {
        concurrency: 8
      }
    )
  )

  return previewImagesMap
}

async function createPreviewImage(
  url: string,
  { cacheKey }: { cacheKey: string }
): Promise<PreviewImage | null> {
  try {
    try {
      const cachedPreviewImage = await db.get(cacheKey)
      if (cachedPreviewImage) {
        return cachedPreviewImage
      }
    } catch (err) {
      // ignore redis errors
      console.warn(`redis error get "${cacheKey}"`, err.message)
    }

    // Check if we're in Cloudflare environment
    if (!lqip || typeof process !== 'undefined' && (process.env.CLOUDFLARE || process.env.NEXT_RUNTIME === 'edge')) {
      // In Cloudflare environment, return a placeholder preview image
      console.log('Skipping lqip in Cloudflare environment', { url, cacheKey })
      
      // Return a simple placeholder
      const previewImage = {
        originalWidth: 400,
        originalHeight: 300,
        dataURIBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFeAJ5jHBQgwAAAABJRU5ErkJggg=='
      }

      try {
        await db.set(cacheKey, previewImage)
      } catch (err) {
        // ignore redis errors
        console.warn(`redis error set "${cacheKey}"`, err.message)
      }

      return previewImage
    }

    // Only run this code in non-Cloudflare environments
    const body = await ky(url).arrayBuffer()
    const result = await lqip(body)
    console.log('lqip', { ...result.metadata, url, cacheKey })

    const previewImage = {
      originalWidth: result.metadata.originalWidth,
      originalHeight: result.metadata.originalHeight,
      dataURIBase64: result.metadata.dataURIBase64
    }

    try {
      await db.set(cacheKey, previewImage)
    } catch (err) {
      // ignore redis errors
      console.warn(`redis error set "${cacheKey}"`, err.message)
    }

    return previewImage
  } catch (err) {
    console.warn('failed to create preview image', url, err.message)
    return null
  }
}

export const getPreviewImage = pMemoize(createPreviewImage)
