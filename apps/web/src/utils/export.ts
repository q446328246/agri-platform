type CsvCell = string | number | boolean | null | undefined

/**
 * RFC4180 转义：含分隔符或换行的字段整体加引号，内部引号翻倍。
 * 文本以 = + - @ 或制表符开头时会被电子表格当公式执行，前置单引号降级为纯文本；
 * 数字不做该处理，否则负数会被破坏。
 */
function escapeCell(value: CsvCell): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  const guarded = typeof value === 'string' && /^[=+\-@\t]/.test(text) ? `'${text}` : text
  return /["\n\r,]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/** 表头加数据行拼成 CSV 文本，行分隔用 CRLF 以兼容 Excel */
export function buildCsv(headers: string[], rows: CsvCell[][]): string {
  return [headers, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n')
}

/**
 * 导出并下载 CSV。
 * 前置 UTF-8 BOM，否则 Excel 打开中文列会乱码。
 */
export function exportCsv(filename: string, headers: string[], rows: CsvCell[][]): void {
  const url = URL.createObjectURL(new Blob(['\uFEFF', buildCsv(headers, rows)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  // 立即 revoke 会让部分浏览器拿不到数据，交给下一轮事件循环
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
