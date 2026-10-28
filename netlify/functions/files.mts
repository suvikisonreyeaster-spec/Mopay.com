import { getStore } from '@netlify/blobs'
import type { Config } from '@netlify/functions'

// Files are uploaded in chunks so large phone videos fit under the function request size limit.
const CHUNK_SIZE = 3 * 1024 * 1024
const MAX_FILE_SIZE = 200 * 1024 * 1024

type FileMeta = {
  id: string
  name: string
  type: string
  size: number
  chunks: number
  createdAt: string
  complete: boolean
}

const store = () => getStore({ name: 'uploads', consistency: 'strong' })

const error = (message: string, status = 400) => Response.json({ error: message }, { status })

export default async (req: Request) => {
  const parts = new URL(req.url).pathname.replace(/^\/api\/files\/?/, '').split('/').filter(Boolean)
  const [id, section, index] = parts
  const uploads = store()

  // GET /api/files — list finished uploads, newest first
  if (!id && req.method === 'GET') {
    const { blobs } = await uploads.list({ prefix: 'meta/' })
    const files = await Promise.all(blobs.map((b) => uploads.get(b.key, { type: 'json' }) as Promise<FileMeta | null>))
    const done = files.filter((f): f is FileMeta => !!f && f.complete)
    done.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return Response.json({ files: done })
  }

  // POST /api/files — start a new upload
  if (!id && req.method === 'POST') {
    const body = await req.json().catch(() => null)
    const name = String(body?.name || 'file').slice(0, 200)
    const type = String(body?.type || 'application/octet-stream').slice(0, 100)
    const size = Number(body?.size)
    if (!Number.isFinite(size) || size <= 0) return error('File is empty')
    if (size > MAX_FILE_SIZE) return error('File is too large (max 200 MB)')

    const meta: FileMeta = {
      id: crypto.randomUUID(),
      name,
      type,
      size,
      chunks: Math.ceil(size / CHUNK_SIZE),
      createdAt: new Date().toISOString(),
      complete: false,
    }
    await uploads.setJSON(`meta/${meta.id}`, meta)
    return Response.json({ id: meta.id, chunkSize: CHUNK_SIZE, chunks: meta.chunks })
  }

  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return error('Not found', 404)
  const meta = (await uploads.get(`meta/${id}`, { type: 'json' })) as FileMeta | null
  if (!meta) return error('Not found', 404)

  // GET /api/files/:id — file details
  if (!section && req.method === 'GET') return Response.json(meta)

  // POST /api/files/:id/complete — mark upload finished once every chunk is stored
  if (section === 'complete' && req.method === 'POST') {
    const { blobs } = await uploads.list({ prefix: `chunk/${id}/` })
    if (blobs.length !== meta.chunks) return error('Upload is missing parts, please try again')
    await uploads.setJSON(`meta/${id}`, { ...meta, complete: true })
    return Response.json({ ...meta, complete: true })
  }

  if (section === 'chunks') {
    const n = Number(index)
    if (!Number.isInteger(n) || n < 0 || n >= meta.chunks) return error('Invalid part', 404)

    // PUT /api/files/:id/chunks/:n — store one chunk
    if (req.method === 'PUT') {
      if (meta.complete) return error('Upload already finished', 409)
      const data = await req.arrayBuffer()
      if (data.byteLength === 0 || data.byteLength > CHUNK_SIZE) return error('Invalid part size')
      await uploads.set(`chunk/${id}/${n}`, data)
      return Response.json({ ok: true })
    }

    // GET /api/files/:id/chunks/:n — read one chunk
    if (req.method === 'GET') {
      const data = await uploads.get(`chunk/${id}/${n}`, { type: 'arrayBuffer' })
      if (!data) return error('Not found', 404)
      return new Response(data, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    }
  }

  return error('Not found', 404)
}

export const config: Config = {
  path: ['/api/files', '/api/files/*'],
}
