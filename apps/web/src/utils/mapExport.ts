import L from 'leaflet'

/** 图幅导出 PNG：当前视野按设备像素比合成底图瓦片 + 矢量图层（地块/片区/管线/设备点位/测量结果）。
 *  底图瓦片经 fetch 跨域读取：源站允许 CORS（如 Esri/天地图）时导出含真实影像；
 *  谷歌/高德等不允许跨域读取的源，canvas 会被污染无法编码，此时退化为深色底矢量图幅并告知调用方。
 *  瓦片屏幕位置走 Leaflet 自己的 _tileCoordsToNwSe + latLngToContainerPoint，
 *  GCJ-02 定制投影与超原生级插值放大都自动同系，不需要手工墨卡托换算。 */

interface TileJob { url: string; x: number; y: number; w: number; h: number }

function tileLayersOf(map: any): any[] {
  return Object.values(map._layers ?? {}).filter((l: any) => l instanceof L.TileLayer)
}

/** 预检：每层取视野中心瓦片试读一次，任一层不允许跨域即整体放弃底图（半张影像观感更差） */
async function basemapReadable(map: any, layers: any[]): Promise<boolean> {
  if (!layers.length) return false
  const center = map.getCenter()
  for (const layer of layers) {
    const z = layer._tileZoom ?? Math.round(map.getZoom())
    const n = 2 ** z
    const x = Math.floor(((center.lng + 180) / 360) * n)
    const rad = (center.lat * Math.PI) / 180
    const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)
    try {
      const url = layer.getTileUrl(L.point(x, y) as any)
      if (!/^https?:/.test(url)) return false
      const res = await fetch(url, { mode: 'cors' })
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image')) return false
    } catch {
      return false
    }
  }
  return true
}

/** 枚举覆盖当前视野的瓦片并算好屏幕落点（含超原生级的放大瓦片） */
function collectTileJobs(map: any, layers: any[]): TileJob[] {
  const jobs: TileJob[] = []
  const zoom = map.getZoom()
  const pixelBounds = map.getPixelBounds()
  for (const layer of layers) {
    const z = layer._tileZoom ?? Math.round(zoom)
    const factor = 2 ** (zoom - z)
    const tileSize = 256 * factor
    const minX = Math.floor(pixelBounds.min.x / tileSize)
    const minY = Math.floor(pixelBounds.min.y / tileSize)
    const maxX = Math.floor(pixelBounds.max.x / tileSize)
    const maxY = Math.floor(pixelBounds.max.y / tileSize)
    const n = 2 ** z
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        if (y < 0 || y >= n) continue
        const coords: any = L.point(((x % n) + n) % n, y)
        coords.z = z
        const [nw, se] = layer._tileCoordsToNwSe(coords)
        const a = map.latLngToContainerPoint(nw)
        const b = map.latLngToContainerPoint(se)
        const url = layer.getTileUrl(coords)
        if (!/^https?:/.test(url)) continue
        jobs.push({ url, x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y })
      }
    }
  }
  return jobs
}

/** 并发受限的瓦片拉取：浏览器同域连接数有限，8 路足够快又不把源站打爆 */
async function fetchTiles(jobs: TileJob[], draw: (job: TileJob, img: ImageBitmap) => void): Promise<void> {
  let cursor = 0
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor]!
      cursor += 1
      try {
        const res = await fetch(job.url, { mode: 'cors' })
        if (!res.ok) continue
        const img = await createImageBitmap(await res.blob())
        draw(job, img)
        img.close()
      } catch {
        // 单块失败留白底，不中断整幅导出
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, worker))
}

function drawVectors(map: any, ctx: CanvasRenderingContext2D) {
  const toPoint = (latlng: any) => map.latLngToContainerPoint(latlng)
  const traceRing = (ring: any[]) => {
    ring.forEach((latlng, i) => {
      const p = toPoint(latlng)
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    })
  }
  for (const layer of Object.values(map._layers ?? {}) as any[]) {
    if (layer instanceof L.Polygon) {
      const opt = layer.options ?? {}
      const rings = layer.getLatLngs() as any[]
      ctx.beginPath()
      for (const ring of rings) traceRing(ring)
      ctx.closePath()
      ctx.globalAlpha = opt.fillOpacity ?? 0.2
      ctx.fillStyle = opt.fillColor || opt.color || '#00d4ff'
      ctx.fill()
      ctx.globalAlpha = opt.opacity ?? 1
      ctx.strokeStyle = opt.color || '#00d4ff'
      ctx.lineWidth = opt.weight ?? 2
      ctx.setLineDash(opt.dashArray ? String(opt.dashArray).split(/[\s,]+/).map(Number) : [])
      ctx.stroke()
      ctx.setLineDash([])
    } else if (layer instanceof L.Polyline) {
      const opt = layer.options ?? {}
      ctx.beginPath()
      traceRing(layer.getLatLngs() as any[])
      ctx.globalAlpha = opt.opacity ?? 1
      ctx.strokeStyle = opt.color || '#ffd54f'
      ctx.lineWidth = opt.weight ?? 2
      ctx.setLineDash(opt.dashArray ? String(opt.dashArray).split(/[\s,]+/).map(Number) : [])
      ctx.stroke()
      ctx.setLineDash([])
    } else if (layer instanceof L.CircleMarker) {
      const opt = layer.options ?? {}
      const p = toPoint(layer.getLatLng())
      ctx.beginPath()
      ctx.arc(p.x, p.y, opt.radius ?? 4, 0, Math.PI * 2)
      ctx.globalAlpha = opt.fillOpacity ?? 1
      ctx.fillStyle = opt.fillColor || opt.color || '#fff'
      ctx.fill()
      ctx.globalAlpha = opt.opacity ?? 1
      ctx.strokeStyle = opt.color || '#ffd54f'
      ctx.lineWidth = opt.weight ?? 1.5
      ctx.stroke()
    } else if (layer instanceof L.Marker) {
      // 设备聚合点位是 divIcon（dev-pin 圆徽），按 HTML 里的底色与数字还原；
      // 空 html 的隐形锚点（如测量结果 tooltip 挂点）不画，其余标记画通用圆点
      const html = String(layer.options?.icon?.options?.html ?? '')
      if (!html.trim()) continue
      const p = toPoint(layer.getLatLng())
      const color = /background:\s*([^;"']+)/.exec(html)?.[1] ?? '#00d4ff'
      const text = html.replace(/<[^>]*>/g, '').trim()
      ctx.globalAlpha = 1
      ctx.beginPath()
      ctx.arc(p.x, p.y, 11, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(255,255,255,.7)'
      ctx.stroke()
      if (text) {
        ctx.fillStyle = '#04121f'
        ctx.font = '700 12px "Microsoft YaHei", sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, p.x, p.y)
      }
    }
  }
  ctx.globalAlpha = 1
}

function drawCaption(ctx: CanvasRenderingContext2D, baseLabel: string, withBasemap: boolean) {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const text = `智耘蜀芯 · 一张图　${baseLabel}${withBasemap ? '' : '（矢量图幅）'}　导出 ${stamp}`
  ctx.font = '12px "Microsoft YaHei", sans-serif'
  const w = ctx.measureText(text).width + 20
  ctx.fillStyle = 'rgba(7,25,48,.78)'
  ctx.fillRect(10, 10, w, 26)
  ctx.strokeStyle = 'rgba(0,212,255,.35)'
  ctx.lineWidth = 1
  ctx.strokeRect(10.5, 10.5, w - 1, 25)
  ctx.fillStyle = '#cdeeff'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 20, 23)
}

/** 导出当前视野为 PNG 并触发下载；返回是否含底图影像，供调用方给出对应提示 */
export async function exportMapPng(map: any, baseLabel: string): Promise<{ withBasemap: boolean }> {
  const size = map.getSize()
  const scale = Math.min(2, window.devicePixelRatio || 1)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(size.x * scale)
  canvas.height = Math.round(size.y * scale)
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.fillStyle = '#061026'
  ctx.fillRect(0, 0, size.x, size.y)

  const layers = tileLayersOf(map)
  const withBasemap = await basemapReadable(map, layers)
  if (withBasemap) {
    await fetchTiles(collectTileJobs(map, layers), (job, img) => ctx.drawImage(img, job.x, job.y, job.w, job.h))
  }
  drawVectors(map, ctx)
  drawCaption(ctx, baseLabel, withBasemap)

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('canvas 编码失败')
  const pad = (n: number) => String(n).padStart(2, '0')
  const now = new Date()
  const name = `一张图_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
  return { withBasemap }
}