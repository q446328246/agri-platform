/**
 * WGS84 ↔ GCJ-02（火星坐标）转换。
 *
 * 高德/腾讯等国内手机地图底图用 GCJ-02 加密坐标，与平台地块边界的 WGS84
 * 存在数百米非线性偏移；直接叠加会错位。这里提供正算与迭代逆算，
 * 供一张图在高德底图下做显示层投影转换——入库与面积计算始终用 WGS84。
 * 算法为公开通用实现，境外坐标（落不进中国范围）不做偏移。
 */
const PI = Math.PI
const SEMI_MAJOR = 6378245.0
const ECCENTRICITY_SQ = 0.00669342162296594323

function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
  ret += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3
  ret += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3
  return ret
}

function transformLng(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
  ret += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3
  ret += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3
  return ret
}

/** WGS84 → GCJ-02，入参与返回均为 [经度, 纬度] */
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat]
  let dLat = transformLat(lng - 105, lat - 35)
  let dLng = transformLng(lng - 105, lat - 35)
  const radLat = (lat / 180) * PI
  let magic = Math.sin(radLat)
  magic = 1 - ECCENTRICITY_SQ * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180) / (((SEMI_MAJOR * (1 - ECCENTRICITY_SQ)) / (magic * sqrtMagic)) * PI)
  dLng = (dLng * 180) / ((SEMI_MAJOR / sqrtMagic) * Math.cos(radLat) * PI)
  return [lng + dLng, lat + dLat]
}

/** GCJ-02 → WGS84：迭代逆算，2~3 轮即收敛到 1e-9 度（远优于厘米级），不引入可感知误差 */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat]
  let wLng = lng
  let wLat = lat
  for (let i = 0; i < 8; i += 1) {
    const [gLng, gLat] = wgs84ToGcj02(wLng, wLat)
    const dLng = lng - gLng
    const dLat = lat - gLat
    wLng += dLng
    wLat += dLat
    if (Math.abs(dLng) < 1e-9 && Math.abs(dLat) < 1e-9) break
  }
  return [wLng, wLat]
}