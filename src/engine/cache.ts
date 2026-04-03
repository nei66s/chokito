/**
 * File Content LRU Cache
 * Stores recent file reads to reduce repeated parsing + token usage.
 */

export interface CacheEntry {
  content: string
  timestamp: number
  size: number // bytes
}

export class LRUCache {
  private maxSize: number // max total bytes
  private maxAge: number // max age in ms
  private cache = new Map<string, CacheEntry>()
  private accessOrder: string[] = [] // track access order for LRU eviction

  constructor(maxSizeBytes = 10 * 1024 * 1024, maxAgeMs = 1000 * 60 * 30) { // 10MB, 30min default
    this.maxSize = maxSizeBytes
    this.maxAge = maxAgeMs
  }

  get(path: string): string | null {
    const entry = this.cache.get(path)
    if (!entry) return null

    // Check if expired
    if (Date.now() - entry.timestamp > this.maxAge) {
      this.cache.delete(path)
      this.accessOrder = this.accessOrder.filter(p => p !== path)
      return null
    }

    // Move to end (most recently used)
    this.accessOrder = this.accessOrder.filter(p => p !== path)
    this.accessOrder.push(path)

    return entry.content
  }

  set(path: string, content: string): void {
    const size = Buffer.byteLength(content, 'utf8')

    // Evict if needed
    this.evictUntilFits(size)

    // Remove old entry if exists
    if (this.cache.has(path)) {
      this.cache.delete(path)
      this.accessOrder = this.accessOrder.filter(p => p !== path)
    }

    // Add new entry
    this.cache.set(path, {
      content,
      timestamp: Date.now(),
      size,
    })
    this.accessOrder.push(path)
  }

  private evictUntilFits(newSize: number): void {
    let totalSize = Array.from(this.cache.values()).reduce((sum, e) => sum + e.size, 0)

    while (totalSize + newSize > this.maxSize && this.accessOrder.length > 0) {
      const oldest = this.accessOrder.shift()!
      const entry = this.cache.get(oldest)
      if (entry) {
        totalSize -= entry.size
        this.cache.delete(oldest)
      }
    }
  }

  clear(): void {
    this.cache.clear()
    this.accessOrder = []
  }

  invalidate(path: string): void {
    this.cache.delete(path)
    this.accessOrder = this.accessOrder.filter(p => p !== path)
  }

  stats() {
    const totalSize = Array.from(this.cache.values()).reduce((sum, e) => sum + e.size, 0)
    return {
      entries: this.cache.size,
      totalSizeBytes: totalSize,
      maxSizeBytes: this.maxSize,
      utilization: (totalSize / this.maxSize) * 100,
    }
  }
}
