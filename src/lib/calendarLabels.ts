/** Week headings retain both years across New Year and follow the UI locale. */
export function formatWeekRange(start: Date, end: Date, locale: string): string {
  if (locale === 'zh-CN') {
    const left = `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日`
    const year = start.getFullYear() !== end.getFullYear() ? `${end.getFullYear()}年` : ''
    const month = year || start.getMonth() !== end.getMonth() ? `${end.getMonth() + 1}月` : ''
    return `${left}—${year}${month}${end.getDate()}日`
  }
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).formatRange(start, end)
}
