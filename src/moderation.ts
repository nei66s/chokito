import fetch from 'node-fetch'
import dotenv from 'dotenv'

dotenv.config()

const OPENAI_KEY = process.env.OPENAI_API_KEY

export async function moderateText(text: string) {
  // If no key, fallback to simple keyword blocklist
  if (!OPENAI_KEY) {
    const blocklist = ['bomb', 'attack', 'suicide', 'explosive']
    const lowered = text.toLowerCase()
    const found = blocklist.filter(w => lowered.includes(w))
    return { allowed: found.length === 0, reason: found.join(', ') }
  }

  const resp = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({ input: text }),
  })

  if (!resp.ok) {
    const t = await resp.text()
    throw new Error(`moderation API error: ${resp.status} ${t}`)
  }

  const data: any = await resp.json()
  // OpenAI moderation response structure: results[0].categories / flagged
  const res = data?.results?.[0]
  const flagged = !!res?.flagged
  return { allowed: !flagged, raw: res }
}
