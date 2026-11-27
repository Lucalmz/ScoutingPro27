import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { downloadCSV } from '../utils/csvExport'

describe('csvExport - downloadCSV', () => {
  const origCreateObjectURL = URL.createObjectURL
  const origRevokeObjectURL = URL.revokeObjectURL
  let capturedBlobs: Blob[] = []
  let createdAnchors: HTMLAnchorElement[] = []

  beforeEach(() => {
    capturedBlobs = []
    createdAnchors = []

    URL.createObjectURL = vi.fn((blob: Blob) => {
      capturedBlobs.push(blob)
      return 'blob:mock-csv-url'
    })
    URL.revokeObjectURL = vi.fn()

    const origCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) => {
      const el = origCreateElement(tagName, options)
      if (tagName.toLowerCase() === 'a') {
        const anchor = el as HTMLAnchorElement
        vi.spyOn(anchor, 'click').mockImplementation(() => {})
        createdAnchors.push(anchor)
      }
      return el
    })
  })

  afterEach(() => {
    URL.createObjectURL = origCreateObjectURL
    URL.revokeObjectURL = origRevokeObjectURL
    vi.restoreAllMocks()
  })

  async function readCapturedCsv(): Promise<string> {
    expect(capturedBlobs).toHaveLength(1)
    const blob = capturedBlobs[0]!
    // Ensure UTF-8 BOM is preserved when reading raw bytes
    const buf = await blob.arrayBuffer()
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf)
  }

  it('triggers anchor download with UTF-8 BOM, headers, and rows and revokes object URL', async () => {
    downloadCSV('report.csv', ['Team', 'Score'], [[27570, 95.5], [118, 80]])

    expect(createdAnchors).toHaveLength(1)
    const anchor = createdAnchors[0]!
    expect(anchor.getAttribute('href')).toBe('blob:mock-csv-url')
    expect(anchor.getAttribute('download')).toBe('report.csv')
    expect(anchor.style.visibility).toBe('hidden')
    expect(anchor.click).toHaveBeenCalledTimes(1)
    expect(anchor.isConnected).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-csv-url')

    const text = await readCapturedCsv()
    expect(text.charCodeAt(0)).toBe(0xfeff)
    expect(text.slice(1)).toBe('Team,Score\n27570,95.5\n118,80')
  })

  it('handles null, undefined, commas, newlines, and embedded quotes per CSV escaping rules', async () => {
    downloadCSV(
      'escape.csv',
      ['A,B', 'Quote"H'],
      [[null, undefined], ['hello, world', 'say "hi"\nnext']]
    )

    const text = await readCapturedCsv()
    expect(text.slice(1)).toBe(
      '"A,B","Quote""H"\n"",""\n"hello, world","say ""hi""\nnext"'
    )
  })

  it('neutralizes formula injection strings (including tab/CR) and quotes bare CR while preserving negative numbers', async () => {
    downloadCSV(
      'security.csv',
      ['Formula', 'NegNum', 'PlusCmd', 'TabFormula', 'CrFormula', 'BareCr', 'NumericVal'],
      [['=SUM(A1:A2)', '-42.5', '+cmd|calc', '\t=1+1', '\r=cmd', 'line1\rline2', -15.25]]
    )

    const text = await readCapturedCsv()
    const lines = text.slice(1).split('\n')
    expect(lines[1]).toBe("'=SUM(A1:A2),-42.5,'+cmd|calc,'\t=1+1,\"'\r=cmd\",\"line1\rline2\",-15.25")
  })
})
